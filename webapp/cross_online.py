"""Online 3/4-player Cross chess: a WebSocket lobby that auto-matches N players
(N = 3 or 4) into a server-authoritative Cross game and relays moves.

Wire protocol (JSON):
  client -> server:
    {type:"quick", n, name}    join the N-player queue (n = 3 or 4)
    {type:"cancel"}            leave the queue
    {type:"move", frm, to}     play a move (only on your turn)
    {type:"ping"}
  server -> client:
    {type:"waiting", have, need}
    {type:"start", seat, n, active, names, state}   seat = engine seat id
    {type:"state", state, last}
    {type:"end", winner, state}
    {type:"aborted", reason}
    {type:"error", message}
  `state` = Cross.to_dict() + {moves: legal moves for the side to move}.
"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from webapp.cross import Cross, moves_for


async def _send(ws, payload):
    try:
        await ws.send_json(payload)
    except Exception:
        pass


class CrossLobby:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.queues = {3: [], 4: []}       # n -> list of (ws, name)
        self.games = {}                    # ws -> game dict

    def _state(self, eng):
        d = eng.to_dict()
        d["moves"] = moves_for(eng)
        return d

    async def quick(self, ws, name, n):
        if n not in (3, 4):
            n = 4
        start = None
        async with self.lock:
            if ws in self.games:
                return await _send(ws, {"type": "error", "message": "이미 대국 중입니다."})
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws]
            self.queues[n].append((ws, name))
            if len(self.queues[n]) >= n:
                trio = self.queues[n][:n]
                self.queues[n] = self.queues[n][n:]
                eng = Cross(n)
                seats = [t[0] for t in trio]           # ws by join order
                seat_ids = list(eng.active)            # engine seat id per player
                names = [t[1] for t in trio]
                game = {"engine": eng, "seats": seats, "seat_ids": seat_ids,
                        "names": names, "n": n}
                for s in seats:
                    self.games[s] = game
                start = game
        if start is not None:
            st = self._state(start["engine"])
            for pos, s in enumerate(start["seats"]):
                await _send(s, {"type": "start", "seat": start["seat_ids"][pos],
                                "n": start["n"], "active": start["seat_ids"],
                                "names": start["names"], "state": st})
        else:
            async with self.lock:
                have = len(self.queues[n])
            await _send(ws, {"type": "waiting", "have": have, "need": n})

    async def cancel(self, ws):
        async with self.lock:
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws]
        await _send(ws, {"type": "cancelled"})

    async def move(self, ws, frm, to):
        broadcast = None
        async with self.lock:
            game = self.games.get(ws)
            if game is None:
                return await _send(ws, {"type": "error", "message": "진행 중인 대국이 없습니다."})
            eng = game["engine"]
            pos = game["seats"].index(ws)
            seat_id = game["seat_ids"][pos]
            if eng.turn != seat_id:
                return await _send(ws, {"type": "error", "message": "당신의 차례가 아닙니다."})
            occ = eng.board[frm] if 0 <= frm < len(eng.board) else None
            if occ is None or occ[0] != seat_id:
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            if not eng.push(frm, to):
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            broadcast = (game, self._state(eng), [frm, to], eng.over, eng.winner)
        if broadcast is not None:
            game, st, last, over, winner = broadcast
            for s in game["seats"]:
                if over:
                    await _send(s, {"type": "end", "winner": winner, "state": st})
                else:
                    await _send(s, {"type": "state", "state": st, "last": last})
            if over:
                async with self.lock:
                    for s in game["seats"]:
                        self.games.pop(s, None)

    async def disconnect(self, ws):
        others = None
        async with self.lock:
            for q in self.queues.values():
                q[:] = [e for e in q if e[0] is not ws]
            game = self.games.pop(ws, None)
            if game is not None and not game["engine"].over:
                others = [s for s in game["seats"] if s is not ws]
                for s in others:
                    self.games.pop(s, None)
        if others:
            for s in others:
                await _send(s, {"type": "aborted", "reason": "opponent_left"})


def register_cross_online(app: FastAPI) -> CrossLobby:
    lobby = CrossLobby()

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
                    await lobby.quick(ws, str(msg.get("name") or "플레이어")[:20].strip() or "플레이어", n)
                elif t == "cancel":
                    await lobby.cancel(ws)
                elif t == "move":
                    try:
                        await lobby.move(ws, int(msg.get("frm")), int(msg.get("to")))
                    except (TypeError, ValueError):
                        pass
        except WebSocketDisconnect:
            await lobby.disconnect(ws)
        except Exception:
            await lobby.disconnect(ws)

    return lobby
