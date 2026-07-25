"""MODE2: Correspondence / Daily Chess (한 수 대국).

Async, turn-based games stored in Neon (no live socket, no clock thread) — the
ideal fit for a free tier that sleeps when idle. The server validates every move
with python-chess and stores only the move list; clients poll on open. Also the
shared plumbing for the weekly Async Swiss (MODE8).
"""
from __future__ import annotations

import secrets

import chess
from fastapi import FastAPI
from pydantic import BaseModel

from webapp.auth import _connect, _ph, _IS_PG, _user_for_token, _now, _init_db


def _init_corr() -> None:
    with _connect() as con:
        cur = con.cursor()
        cur.execute("""CREATE TABLE IF NOT EXISTS corr_games (
            gid TEXT PRIMARY KEY,
            w_uid TEXT, b_uid TEXT,
            w_name TEXT, b_name TEXT,
            moves TEXT NOT NULL DEFAULT '',
            turn TEXT, status TEXT, result TEXT,
            event TEXT,
            created TEXT, updated TEXT)""")
        # weekly Async Swiss sign-ups (MODE8)
        cur.execute("""CREATE TABLE IF NOT EXISTS swiss (
            week TEXT NOT NULL,
            uid TEXT NOT NULL,
            name TEXT,
            joined TEXT,
            PRIMARY KEY (week, uid))""")
        con.commit()


class CorrNew(BaseModel):
    token: str
    opponent: str | None = None     # opponent account id, or None → open challenge


class CorrMove(BaseModel):
    token: str
    gid: str
    uci: str


class CorrId(BaseModel):
    token: str
    gid: str


class CorrTok(BaseModel):
    token: str


class SwissReq(BaseModel):
    token: str
    week: str
    name: str | None = None


def _uid_for(token: str):
    if not token:
        return None
    try:
        with _connect() as con:
            row = _user_for_token(con, token)
            return row[0] if row else None
    except Exception:
        return None


def _replay(moves_str: str):
    board = chess.Board()
    san = []
    for u in (moves_str.split(",") if moves_str else []):
        if not u:
            continue
        try:
            mv = chess.Move.from_uci(u)
            san.append(board.san(mv))
            board.push(mv)
        except Exception:
            break
    return board, san


def register_corr(app: FastAPI) -> None:
    _init_db()
    _init_corr()

    @app.post("/api/corr/new")
    def corr_new(req: CorrNew):
        uid = _uid_for(req.token)
        if not uid:
            return {"ok": False, "error": "login"}
        opp = (req.opponent or "").strip().lower() or None
        if opp == uid:
            return {"ok": False, "error": "self"}
        gid = secrets.token_hex(6)
        with _connect() as con:
            cur = con.cursor()
            cur.execute(
                f"INSERT INTO corr_games (gid,w_uid,b_uid,w_name,b_name,moves,turn,status,event,created,updated) "
                f"VALUES ({_ph()},{_ph()},{_ph()},{_ph()},{_ph()},'',{_ph()},{_ph()},{_ph()},{_ph()},{_ph()})",
                (gid, uid, opp, uid, opp or "", "w", ("open" if opp is None else "active"), None, _now(), _now()))
            con.commit()
        return {"ok": True, "gid": gid}

    @app.post("/api/corr/join")
    def corr_join(req: CorrId):
        uid = _uid_for(req.token)
        if not uid:
            return {"ok": False}
        with _connect() as con:
            cur = con.cursor()
            cur.execute(f"SELECT w_uid,b_uid,status FROM corr_games WHERE gid={_ph()}", (req.gid,))
            row = cur.fetchone()
            if not row or row[1] or row[2] != "open" or row[0] == uid:
                return {"ok": False}
            cur.execute(f"UPDATE corr_games SET b_uid={_ph()}, b_name={_ph()}, status='active', updated={_ph()} WHERE gid={_ph()}",
                        (uid, uid, _now(), req.gid))
            con.commit()
        return {"ok": True}

    @app.post("/api/corr/list")
    def corr_list(req: CorrTok):
        uid = _uid_for(req.token)
        if not uid:
            return {"ok": False, "games": []}
        with _connect() as con:
            cur = con.cursor()
            cur.execute(
                f"SELECT gid,w_uid,b_uid,w_name,b_name,moves,turn,status,result FROM corr_games "
                f"WHERE (w_uid={_ph()} OR b_uid={_ph()} OR status='open') ORDER BY updated DESC LIMIT 40", (uid, uid))
            rows = cur.fetchall()
        games = []
        for (gid, wu, bu, wn, bn, mv, turn, status, result) in rows:
            mine = "w" if wu == uid else ("b" if bu == uid else None)
            n = len([x for x in (mv.split(",") if mv else []) if x])
            games.append({"gid": gid, "white": wn, "black": bn or "?", "turn": turn, "status": status,
                          "result": result, "myColor": mine, "myMove": (mine == turn and status == "active"),
                          "nMoves": n, "open": (status == "open" and mine is None)})
        return {"ok": True, "games": games}

    @app.post("/api/corr/get")
    def corr_get(req: CorrId):
        uid = _uid_for(req.token)
        with _connect() as con:
            cur = con.cursor()
            cur.execute(f"SELECT gid,w_uid,b_uid,w_name,b_name,moves,turn,status,result FROM corr_games WHERE gid={_ph()}", (req.gid,))
            row = cur.fetchone()
        if not row:
            return {"ok": False}
        (gid, wu, bu, wn, bn, mv, turn, status, result) = row
        board, san = _replay(mv)
        mine = "w" if wu == uid else ("b" if bu == uid else None)
        legal = {}
        if status == "active" and mine == turn:
            for m in board.legal_moves:
                legal.setdefault(m.uci()[:2], []).append(m.uci()[2:])
        return {"ok": True, "gid": gid, "white": wn, "black": bn or "?", "fen": board.fen(), "turn": turn,
                "status": status, "result": result, "myColor": mine,
                "moves": [x for x in (mv.split(",") if mv else []) if x], "san": san,
                "check": board.is_check(), "legal": legal,
                "lastUci": ([x for x in (mv.split(",") if mv else []) if x][-1] if mv else None)}

    @app.post("/api/corr/move")
    def corr_move(req: CorrMove):
        uid = _uid_for(req.token)
        if not uid:
            return {"ok": False}
        with _connect() as con:
            cur = con.cursor()
            cur.execute(f"SELECT w_uid,b_uid,moves,turn,status FROM corr_games WHERE gid={_ph()}", (req.gid,))
            row = cur.fetchone()
            if not row:
                return {"ok": False}
            (wu, bu, mv, turn, status) = row
            if status != "active":
                return {"ok": False, "error": "not active"}
            mine = "w" if wu == uid else ("b" if bu == uid else None)
            if mine != turn:
                return {"ok": False, "error": "not your turn"}
            board, _ = _replay(mv)
            try:
                m = chess.Move.from_uci(req.uci)
            except Exception:
                return {"ok": False, "error": "bad"}
            if m not in board.legal_moves:
                return {"ok": False, "error": "illegal"}
            board.push(m)
            new_moves = (mv + "," if mv else "") + req.uci
            new_turn = "b" if turn == "w" else "w"
            new_status, result = "active", None
            if board.is_game_over(claim_draw=True):
                new_status, result = "done", board.result(claim_draw=True)
            cur.execute(f"UPDATE corr_games SET moves={_ph()}, turn={_ph()}, status={_ph()}, result={_ph()}, updated={_ph()} WHERE gid={_ph()}",
                        (new_moves, new_turn, new_status, result, _now(), req.gid))
            con.commit()
        return {"ok": True, "status": new_status, "result": result}

    @app.post("/api/corr/resign")
    def corr_resign(req: CorrId):
        uid = _uid_for(req.token)
        with _connect() as con:
            cur = con.cursor()
            cur.execute(f"SELECT w_uid,b_uid,status FROM corr_games WHERE gid={_ph()}", (req.gid,))
            row = cur.fetchone()
            if not row:
                return {"ok": False}
            (wu, bu, status) = row
            mine = "w" if wu == uid else ("b" if bu == uid else None)
            if not mine or status != "active":
                return {"ok": False}
            result = "0-1" if mine == "w" else "1-0"
            cur.execute(f"UPDATE corr_games SET status='done', result={_ph()}, updated={_ph()} WHERE gid={_ph()}",
                        (result, _now(), req.gid))
            con.commit()
        return {"ok": True}

    # ---- MODE8: Async Swiss — a lightweight weekly event on top of correspondence.
    # Sign up; "pair" matches unpaired participants into correspondence games. (A
    # real weekly cadence would trigger pairing from an external cron hitting
    # /api/swiss/pair; here it can also be run on demand once >=2 have joined.)
    @app.post("/api/swiss/join")
    def swiss_join(req: SwissReq):
        uid = _uid_for(req.token)
        if not uid:
            return {"ok": False}
        name = (req.name or uid)[:20]
        with _connect() as con:
            cur = con.cursor()
            if _IS_PG:
                cur.execute("INSERT INTO swiss (week,uid,name,joined) VALUES (%s,%s,%s,%s) ON CONFLICT (week,uid) DO NOTHING",
                            (req.week[:10], uid, name, _now()))
            else:
                cur.execute("INSERT OR IGNORE INTO swiss (week,uid,name,joined) VALUES (?,?,?,?)",
                            (req.week[:10], uid, name, _now()))
            con.commit()
            cur.execute(f"SELECT COUNT(*) FROM swiss WHERE week={_ph()}", (req.week[:10],))
            n = cur.fetchone()[0]
        return {"ok": True, "entrants": n}

    @app.post("/api/swiss/status")
    def swiss_status(req: SwissReq):
        uid = _uid_for(req.token)
        with _connect() as con:
            cur = con.cursor()
            cur.execute(f"SELECT name FROM swiss WHERE week={_ph()} ORDER BY joined ASC LIMIT 50", (req.week[:10],))
            names = [r[0] for r in cur.fetchall()]
            cur.execute(f"SELECT 1 FROM swiss WHERE week={_ph()} AND uid={_ph()}", (req.week[:10], uid or ""))
            joined = cur.fetchone() is not None
        return {"ok": True, "entrants": len(names), "names": names, "joined": joined}
