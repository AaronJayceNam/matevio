"""Online 3-player Trident chess: a WebSocket lobby (matches 3 players, relays
moves through the server-authoritative engine). Turn-based, no clock — a good fit
for the free tier. In-memory (a dropped player aborts the game for a first cut).

Wire protocol (JSON):
  client -> server:
    {type:"quick", name}       join the 3-player queue
    {type:"cancel"}            leave the queue
    {type:"move", frm, to}     play a move (only on your turn)
    {type:"ping"}
  server -> client:
    {type:"waiting", have, need}
    {type:"start", seat, names, state}
    {type:"state", state, last}
    {type:"end", winner, state}
    {type:"aborted", reason}
    {type:"error", message}
  `state` = engine to_dict() + {moves: legal moves for the side to move}.
"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from webapp.trident import Trident


async def _send(ws, payload):
    try:
        await ws.send_json(payload)
    except Exception:
        pass


class TriLobby:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.queue = []                    # list of (ws, name)
        self.games = {}                    # ws -> game dict {engine, seats:[ws,ws,ws], names}

    def _state(self, eng):
        d = eng.to_dict()
        d["moves"] = [] if eng.over else [[a, b] for (a, b, pr) in eng.legal_moves(eng.turn)]
        return d

    async def quick(self, ws, name):
        start = None
        async with self.lock:
            if ws in self.games:
                return await _send(ws, {"type": "error", "message": "이미 대국 중입니다."})
            self.queue = [e for e in self.queue if e[0] is not ws]
            self.queue.append((ws, name))
            if len(self.queue) >= 3:
                trio = self.queue[:3]
                self.queue = self.queue[3:]
                eng = Trident()
                seats = [t[0] for t in trio]
                names = [t[1] for t in trio]
                game = {"engine": eng, "seats": seats, "names": names}
                for s in seats:
                    self.games[s] = game
                start = (game, seats, names, eng)
        if start is not None:
            game, seats, names, eng = start
            st = self._state(eng)
            for i, s in enumerate(seats):
                await _send(s, {"type": "start", "seat": i, "names": names, "state": st})
        else:
            async with self.lock:
                have = len(self.queue)
            await _send(ws, {"type": "waiting", "have": have, "need": 3})

    async def cancel(self, ws):
        async with self.lock:
            self.queue = [e for e in self.queue if e[0] is not ws]
        await _send(ws, {"type": "cancelled"})

    async def move(self, ws, frm, to):
        broadcast = None
        async with self.lock:
            game = self.games.get(ws)
            if game is None:
                return await _send(ws, {"type": "error", "message": "진행 중인 대국이 없습니다."})
            eng = game["engine"]
            seat = game["seats"].index(ws)
            if seat != eng.turn:
                return await _send(ws, {"type": "error", "message": "당신의 차례가 아닙니다."})
            occ = eng.board[frm] if 0 <= frm < 96 else None
            if occ is None or occ[0] != seat:
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            if not eng.push(frm, to):
                return await _send(ws, {"type": "error", "message": "둘 수 없는 수입니다."})
            st = self._state(eng)
            broadcast = (game, st, [frm, to], eng.over, eng.winner)
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
            self.queue = [e for e in self.queue if e[0] is not ws]
            game = self.games.pop(ws, None)
            if game is not None and not game["engine"].over:
                others = [s for s in game["seats"] if s is not ws]
                for s in others:
                    self.games.pop(s, None)
        if others:
            for s in others:
                await _send(s, {"type": "aborted", "reason": "opponent_left"})


def register_trident_online(app: FastAPI) -> TriLobby:
    lobby = TriLobby()

    @app.websocket("/ws3")
    async def ws3(ws: WebSocket):   # noqa: ANN001
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
                    await lobby.quick(ws, str(msg.get("name") or "플레이어")[:20].strip() or "플레이어")
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
