"""Online 3/4-player Cross chess: a WebSocket lobby that auto-matches N players
(N = 3 or 4) into a server-authoritative Cross game and relays moves.

Reliability/features beyond the first cut:
  * RECONNECT GRACE — a dropped player's seat is vacated (not the whole game
    aborted) for RECONNECT_GRACE seconds; they rejoin with {gid, rkey} and the
    others just see a "paused" notice. Only if nobody returns in time does the
    game abort. Previously ONE player's blip killed the game for 2-3 innocents.
  * ACCOUNTS + RATING — a token resolves to an account and its `cross_rating`
    (a column separate from the 1v1 Elo). The winner gains, the rest lose a
    share, so these modes feed progression like the 1v1 mode does.
  * SPECTATORS — read-only viewers attach by gid and receive state/end.
  * IDLE FORFEIT — a seat that never moves can't freeze the board forever.

Wire protocol (JSON):
  client -> server:
    {type:"quick", n, name, token}   join the N-player queue
    {type:"cancel"}                  leave the queue
    {type:"move", frm, to}           play a move (only on your turn)
    {type:"resume", gid, rkey}       rejoin a seat after a drop
    {type:"watch", gid}              attach as a spectator (read-only)
    {type:"ping"}
  server -> client:
    {type:"waiting", have, need}
    {type:"start", seat, n, active, names, ratings, gid, rkey, state}
    {type:"state", state, last}
    {type:"end", winner, state, rating?}
    {type:"paused", seat, seconds}   a player dropped; game held open
    {type:"resumed", seat}
    {type:"resume_ok", seat, ... }   / {type:"resume_fail"}
    {type:"watching", ...}           spectator attached
    {type:"aborted", reason}
    {type:"error", message}
"""
from __future__ import annotations

import asyncio
import os
import secrets
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from webapp.cross import Cross, moves_for

# A seat that idles longer than this loses the game for everyone (anti-freeze).
TURN_LIMIT = float(os.environ.get("CC_CROSS_TURN_LIMIT", "180"))
# How long a dropped player may take to reconnect before the game is abandoned.
RECONNECT_GRACE = float(os.environ.get("CC_CROSS_GRACE", "60"))


async def _send(ws, payload):
    try:
        await ws.send_json(payload)
    except Exception:
        pass


class CrossLobby:
    def __init__(self, rating_hooks: dict | None = None):
        self.lock = asyncio.Lock()
        self.queues = {3: [], 4: []}       # n -> list of (ws, name, uid, rating)
        self.games = {}                    # ws -> game dict (players only)
        self.by_gid = {}                   # gid -> game dict
        self.watchers = {}                 # ws -> game dict (spectators)
        self._sweeper = None
        hooks = rating_hooks or {}
        self._resolve = hooks.get("resolve")     # token -> (uid, rating)
        self._apply = hooks.get("apply")         # (uids, winner_uid) -> info

    # ------------------------------------------------------------------ #
    def _state(self, eng):
        d = eng.to_dict()
        d["moves"] = moves_for(eng)
        return d

    def _seat_index(self, game, ws):
        try:
            return game["seats"].index(ws)
        except ValueError:
            return -1

    async def _broadcast(self, game, payload, include_watchers=True):
        for s in game["seats"]:
            if s is not None:
                await _send(s, payload)
        if include_watchers:
            for s in list(game.get("spectators", [])):
                await _send(s, payload)

    # ------------------------------------------------------------------ #
    async def quick(self, ws, name, n, token=""):
        if n not in (3, 4):
            n = 4
        uid, rating = None, 400
        if self._resolve:
            r = self._resolve(token or "")
            if r is not None:
                uid, rating = r
        start = None
        async with self.lock:
            if ws in self.games:
                return await _send(ws, {"type": "error", "message": "이미 대국 중입니다."})
            # one account can't hold two seats (would be self-play / rating farming)
            if uid is not None:
                for g in self.by_gid.values():
                    if not g["engine"].over and uid in g["uids"]:
                        return await _send(ws, {"type": "error", "message": "이미 다른 대국에 참여 중입니다."})
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws and (uid is None or e[2] != uid)]
            self.queues[n].append((ws, name, uid, rating))
            if len(self.queues[n]) >= n:
                group = self.queues[n][:n]
                self.queues[n] = self.queues[n][n:]
                eng = Cross(n)
                gid = secrets.token_hex(8)
                game = {
                    "gid": gid, "engine": eng, "n": n,
                    "seats": [g[0] for g in group],
                    "seat_ids": list(eng.active),
                    "names": [g[1] for g in group],
                    "uids": [g[2] for g in group],
                    "ratings": [g[3] for g in group],
                    "rkeys": [secrets.token_hex(8) for _ in group],
                    "deadline": [None] * n,       # per-seat reconnect deadline
                    "spectators": [],
                    "active_at": time.monotonic(),
                    "rated_done": False,
                }
                for s in game["seats"]:
                    self.games[s] = game
                self.by_gid[gid] = game
                if self._sweeper is None or self._sweeper.done():
                    self._sweeper = asyncio.create_task(self._sweep())
                start = game
        if start is not None:
            st = self._state(start["engine"])
            for pos, s in enumerate(start["seats"]):
                await _send(s, {"type": "start", "seat": start["seat_ids"][pos], "n": start["n"],
                                "active": start["seat_ids"], "names": start["names"],
                                "ratings": start["ratings"], "gid": start["gid"],
                                "rkey": start["rkeys"][pos], "state": st})
        else:
            async with self.lock:
                have = len(self.queues[n])
            await _send(ws, {"type": "waiting", "have": have, "need": n})

    async def cancel(self, ws):
        async with self.lock:
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws]
        await _send(ws, {"type": "cancelled"})

    # ------------------------------------------------------------------ #
    async def move(self, ws, frm, to):
        broadcast = None
        async with self.lock:
            game = self.games.get(ws)
            if game is None:
                return await _send(ws, {"type": "error", "message": "진행 중인 대국이 없습니다."})
            eng = game["engine"]
            pos = self._seat_index(game, ws)
            if pos < 0:
                return await _send(ws, {"type": "error", "message": "좌석을 찾을 수 없습니다."})
            seat_id = game["seat_ids"][pos]
            if eng.turn != seat_id:
                return await _send(ws, {"type": "error", "message": "당신의 차례가 아닙니다."})
            # a seat is empty (someone reconnecting) → hold the game, no moves
            if any(d is not None for d in game["deadline"]):
                return await _send(ws, {"type": "error", "message": "상대의 재접속을 기다리는 중입니다."})
            occ = eng.board[frm] if 0 <= frm < len(eng.board) else None
            if occ is None or occ[0] != seat_id:
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            if not eng.push(frm, to):
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            game["active_at"] = time.monotonic()
            broadcast = (game, self._state(eng), [frm, to], eng.over, eng.winner)
        if broadcast is not None:
            game, st, last, over, winner = broadcast
            if over:
                await self._finish(game, st, winner)
            else:
                await self._broadcast(game, {"type": "state", "state": st, "last": last})

    async def _finish(self, game, st, winner):
        """End a game: apply the Cross rating once, tell everyone, clean up."""
        info = None
        async with self.lock:
            if not game.get("rated_done"):
                game["rated_done"] = True
                if self._apply is not None and winner is not None:
                    try:
                        wpos = game["seat_ids"].index(winner)
                        info = self._apply(game["uids"], game["uids"][wpos])
                    except Exception:
                        info = None
        for pos, s in enumerate(game["seats"]):
            if s is None:
                continue
            msg = {"type": "end", "winner": winner, "state": st}
            uid = game["uids"][pos]
            if info and uid in info:
                msg["rating"] = info[uid]
            await _send(s, msg)
        for s in list(game.get("spectators", [])):
            await _send(s, {"type": "end", "winner": winner, "state": st})
        async with self.lock:
            self._cleanup(game)

    def _cleanup(self, game):
        self.by_gid.pop(game["gid"], None)
        for s in game["seats"]:
            if s is not None and self.games.get(s) is game:
                self.games.pop(s, None)
        for s in list(game.get("spectators", [])):
            if self.watchers.get(s) is game:
                self.watchers.pop(s, None)

    # ------------------------------------------------------------------ #
    async def resume(self, ws, gid, rkey):
        """Reclaim a seat after a drop. The per-seat key issued at start proves
        ownership, so this works for guests too."""
        found = None
        async with self.lock:
            game = self.by_gid.get(gid)
            if game is not None and not game["engine"].over and rkey:
                for pos, k in enumerate(game["rkeys"]):
                    if k == rkey:
                        old = game["seats"][pos]
                        if old is not None and old is not ws:
                            self.games.pop(old, None)
                        game["seats"][pos] = ws
                        game["deadline"][pos] = None
                        self.games[ws] = game
                        found = (game, pos)
                        break
        if found is None:
            return await _send(ws, {"type": "resume_fail"})
        game, pos = found
        st = self._state(game["engine"])
        await _send(ws, {"type": "resume_ok", "seat": game["seat_ids"][pos], "n": game["n"],
                         "active": game["seat_ids"], "names": game["names"],
                         "ratings": game["ratings"], "gid": game["gid"],
                         "rkey": game["rkeys"][pos], "state": st})
        for i, s in enumerate(game["seats"]):
            if s is not None and s is not ws:
                await _send(s, {"type": "resumed", "seat": game["seat_ids"][pos]})

    async def watch(self, ws, gid):
        """Attach read-only to a live game."""
        async with self.lock:
            game = self.by_gid.get(gid)
            if game is None or game["engine"].over:
                return await _send(ws, {"type": "error", "message": "관전할 대국이 없습니다."})
            if ws in self.games:
                return await _send(ws, {"type": "error", "message": "대국 중에는 관전할 수 없습니다."})
            if ws not in game["spectators"]:
                game["spectators"].append(ws)
            self.watchers[ws] = game
            st = self._state(game["engine"])
            payload = {"type": "watching", "n": game["n"], "active": game["seat_ids"],
                       "names": game["names"], "gid": gid, "state": st}
        await _send(ws, payload)

    async def live_games(self, ws):
        """List watchable games (for a spectate picker)."""
        async with self.lock:
            out = [{"gid": g["gid"], "n": g["n"], "names": g["names"],
                    "moves": len(g["engine"].board) and sum(1 for c in g["engine"].board if c)}
                   for g in self.by_gid.values() if not g["engine"].over]
        await _send(ws, {"type": "games", "games": out[:20]})

    # ------------------------------------------------------------------ #
    async def disconnect(self, ws):
        notify = None
        async with self.lock:
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws]
            # spectator leaving is trivial
            g = self.watchers.pop(ws, None)
            if g is not None and ws in g.get("spectators", []):
                g["spectators"].remove(ws)
            game = self.games.pop(ws, None)
            if game is None or game["engine"].over:
                return
            pos = self._seat_index(game, ws)
            if pos < 0:
                return
            # vacate the seat and start the grace window instead of aborting
            game["seats"][pos] = None
            game["deadline"][pos] = time.monotonic() + RECONNECT_GRACE
            if self._sweeper is None or self._sweeper.done():
                self._sweeper = asyncio.create_task(self._sweep())
            notify = (game, game["seat_ids"][pos])
        if notify:
            game, seat_id = notify
            await self._broadcast(game, {"type": "paused", "seat": seat_id,
                                         "seconds": int(RECONNECT_GRACE)})

    async def _sweep(self):
        """Abort games whose dropped player never returned, or whose side to move
        idled too long."""
        while True:
            await asyncio.sleep(3.0)
            now = time.monotonic()
            dead = []
            async with self.lock:
                for game in list(self.by_gid.values()):
                    if game["engine"].over:
                        self._cleanup(game)
                        continue
                    expired = any(d is not None and now > d for d in game["deadline"])
                    idle = (now - game.get("active_at", now)) > TURN_LIMIT
                    if expired or idle:
                        dead.append((game, "opponent_left" if expired else "idle"))
                        self._cleanup(game)
                stop = not self.by_gid
                if stop:
                    self._sweeper = None
            for game, reason in dead:
                await self._broadcast(game, {"type": "aborted", "reason": reason})
            if stop:
                return


def register_cross_online(app: FastAPI, rating_hooks: dict | None = None) -> CrossLobby:
    lobby = CrossLobby(rating_hooks)

    @app.websocket("/wsc")
    async def wsc(ws: WebSocket):        # noqa: ANN001
        await ws.accept()
        try:
            while True:
                try:
                    msg = await ws.receive_json()
                except WebSocketDisconnect:
                    raise
                except Exception:
                    continue
                t = msg.get("type")
                if t == "ping":
                    await _send(ws, {"type": "pong"})
                elif t == "quick":
                    try:
                        n = int(msg.get("n", 4))
                    except (TypeError, ValueError):
                        n = 4
                    name = str(msg.get("name") or "플레이어")[:20].strip() or "플레이어"
                    await lobby.quick(ws, name, n, str(msg.get("token") or ""))
                elif t == "cancel":
                    await lobby.cancel(ws)
                elif t == "move":
                    try:
                        await lobby.move(ws, int(msg.get("frm")), int(msg.get("to")))
                    except (TypeError, ValueError):
                        pass
                elif t == "resume":
                    await lobby.resume(ws, str(msg.get("gid") or ""), str(msg.get("rkey") or ""))
                elif t == "watch":
                    await lobby.watch(ws, str(msg.get("gid") or ""))
                elif t == "games":
                    await lobby.live_games(ws)
        except WebSocketDisconnect:
            await lobby.disconnect(ws)
        except Exception:
            await lobby.disconnect(ws)

    return lobby
