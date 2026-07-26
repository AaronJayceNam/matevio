"""FastAPI backend for Chess Coach Studio.

Features:
  1. Record (play moves on a board) or upload/paste a PGN, then get an engine
     "AI" evaluation of every move played.
  2. Review that evaluation visually (board, eval bar, eval graph, annotated
     move list, engine best-move arrows).
  3. Teach: annotate the recorded line with per-move explanations and
     arrows/highlights, and export a standalone shareable study HTML.

python-chess is the SINGLE source of move legality (`/api/legal`); the browser
never needs its own chess engine, so the whole thing runs offline.

Run:  uvicorn webapp.server:app   (the desktop launcher sets CC_OPEN_BROWSER=1
so the server opens the browser itself once it is ready).
"""
from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from typing import Optional

import chess
import chess.pgn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chess_coach.config import EngineConfig
from chess_coach.engine import Engine, PositionEval
from chess_coach.analyze import (
    analyze_game_parallel, read_first_game,
    build_boards, _book_skip, _book_eval, _assemble,
)
from chess_coach.visualize import build_view_data, render_study_html
from chess_coach import coach as coach_mod

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

# --------------------------------------------------------------------------- #
# Persistent engines — keep Stockfish processes alive and reuse them instead of
# opening/closing a subprocess on every request (that startup made each AI move
# and puzzle move ~150ms+ slower). Access is serialized with locks.
# --------------------------------------------------------------------------- #
_TOTAL = os.cpu_count() or 4
_WORKERS = int(os.environ.get("CC_WORKERS", max(2, min(6, _TOTAL // 2))))
_ETHREADS = int(os.environ.get("CC_ENGINE_THREADS", max(1, _TOTAL // max(1, _WORKERS))))
_EHASH = int(os.environ.get("CC_ENGINE_HASH_MB", 128))


def _mem_limit_mb():
    """Container/host memory limit in MB (None if unknown)."""
    for p in ("/sys/fs/cgroup/memory.max",
              "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            v = open(p).read().strip()
            if v.isdigit():
                mb = int(v) // (1024 * 1024)
                if 0 < mb < 1_000_000:      # ignore "max"/absurd values
                    return mb
        except Exception:
            pass
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal"):
                return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


# Auto-cap on small instances (e.g. the 512MB free tier) so analysis can't
# OOM the box, regardless of env settings.
_MEM_MB = _mem_limit_mb()
if _MEM_MB and _MEM_MB <= 700:
    _WORKERS = 1
    _ETHREADS = 1
    _EHASH = min(_EHASH, 16)

_quick = {"e": None}            # single engine for ai_move / puzzle_move
_qlock = threading.Lock()
_pool = {"engines": None}       # engine pool for analysis
_plock = threading.Lock()

# Small LRU cache for /api/eval_fen. On a 0.1-CPU box the biggest shared load is
# the DAILY puzzle: everyone solves the SAME positions, so identical (fen, moves,
# movetime) requests recur constantly. Caching them removes redundant engine work.
from collections import OrderedDict as _OrderedDict  # noqa: E402
_EVAL_CACHE = _OrderedDict()
_EVAL_CACHE_MAX = 4000
_eval_cache_lock = threading.Lock()


def _eval_cache_get(key):
    with _eval_cache_lock:
        if key in _EVAL_CACHE:
            _EVAL_CACHE.move_to_end(key)
            return _EVAL_CACHE[key]
    return None


def _eval_cache_put(key, val):
    with _eval_cache_lock:
        _EVAL_CACHE[key] = val
        _EVAL_CACHE.move_to_end(key)
        while len(_EVAL_CACHE) > _EVAL_CACHE_MAX:
            _EVAL_CACHE.popitem(last=False)


def _quick_engine() -> Engine:
    if _quick["e"] is None:
        cfg = EngineConfig()
        # respect the small-instance env budget (was hardcoded 128MB, which
        # OOM'd the 512MB free tier during analysis).
        cfg.threads, cfg.hash_mb, cfg.multipv = _ETHREADS, _EHASH, 1
        cfg.movetime_ms = cfg.depth = None
        e = Engine(cfg); e.open()
        _quick["e"] = e
    return _quick["e"]


def _quick_reset():
    try:
        if _quick["e"]:
            _quick["e"].close()
    except Exception:
        pass
    _quick["e"] = None


def _analysis_pool() -> list[Engine]:
    if _pool["engines"] is None:
        pool = []
        for _ in range(_WORKERS):
            cfg = EngineConfig()
            cfg.threads, cfg.hash_mb, cfg.multipv = _ETHREADS, _EHASH, 2
            cfg.movetime_ms = cfg.depth = None
            e = Engine(cfg); e.open(); pool.append(e)
        _pool["engines"] = pool
    return _pool["engines"]


def _pool_reset():
    try:
        for e in (_pool["engines"] or []):
            e.close()
    except Exception:
        pass
    _pool["engines"] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # When launched from the desktop shortcut, open the app in the browser as
    # soon as the server is ready (so the user sees the board, not just a console).
    if os.environ.get("CC_OPEN_BROWSER") == "1":
        import webbrowser
        port = os.environ.get("PORT", "8000")
        url = f"http://127.0.0.1:{port}/"
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    # Warm the quick engine in the background so the first AI/puzzle move is fast.
    def _warm():
        try:
            with _qlock:
                _quick_engine()
        except Exception:
            pass
    threading.Thread(target=_warm, daemon=True).start()

    yield
    _quick_reset()
    _pool_reset()


app = FastAPI(title="Matevio", lifespan=lifespan)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class LegalRequest(BaseModel):
    moves: list[str] = []           # UCI moves played so far
    startFen: Optional[str] = None  # Chess960 / variant start position (None = standard)


class AnalyzeRequest(BaseModel):
    pgn: Optional[str] = None
    moves: Optional[list[str]] = None
    white: str = "White"
    black: str = "Black"
    depth: int = 16
    movetime: Optional[int] = None    # ms per position (preferred; predictable speed)
    coach: bool = False
    lang: str = "ko"                  # app language for the coaching report


class AiMoveRequest(BaseModel):
    moves: list[str] = []
    level: int = 5
    style: str | None = None   # famous-player persona (AI matches only)
    startFen: Optional[str] = None  # Chess960 / variant start position


class PuzzleMoveRequest(BaseModel):
    fen: str
    move: str           # UCI
    mateIn: int         # remaining moves-to-mate target (White to move)


class StudyRequest(BaseModel):
    moves: list[str] = []
    comments: dict[str, str] = {}                 # index ("0".."N") -> text
    shapes: dict[str, dict] = {}                  # index -> {arrows:[[a,b]], circles:[sq]}
    white: str = "White"
    black: str = "Black"
    title: str = "체스 설명 (Chess Study)"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _replay(moves: list[str], start_fen: str | None = None) -> chess.Board:
    board = chess.Board(start_fen, chess960=True) if start_fen else chess.Board()
    for i, u in enumerate(moves):
        try:
            mv = chess.Move.from_uci(u)
        except ValueError:
            raise HTTPException(400, f"잘못된 수 표기: {u} (#{i+1})")
        if mv not in board.legal_moves:
            raise HTTPException(400, f"불법 수: {u} (#{i+1})")
        board.push(mv)
    return board


def _legal_state(board: chess.Board) -> dict:
    legal: dict[str, list[str]] = {}
    for mv in board.legal_moves:
        src = chess.square_name(mv.from_square)
        dst = chess.square_name(mv.to_square)
        legal.setdefault(src, [])
        if dst not in legal[src]:
            legal[src].append(dst)
    over = board.is_game_over(claim_draw=True)
    return {
        "ok": True,
        "fen": board.fen(),
        "turn": "w" if board.turn == chess.WHITE else "b",
        "legal": legal,
        "check": board.is_check(),
        "gameOver": over,
        "result": board.result(claim_draw=True) if over else "*",
        "fullmove": board.fullmove_number,
    }


def _san_history(moves: list[str], start_fen: str | None = None) -> list[str]:
    san: list[str] = []
    b = chess.Board(start_fen, chess960=True) if start_fen else chess.Board()
    for u in moves:
        mv = chess.Move.from_uci(u)
        san.append(b.san(mv))
        b.push(mv)
    return san


def _game_from_moves(moves: list[str], white: str, black: str) -> chess.pgn.Game:
    board = chess.Board()
    game = chess.pgn.Game()
    game.headers["Event"] = "Matevio"
    game.headers["White"] = white or "White"
    game.headers["Black"] = black or "Black"
    node = game
    for u in moves:
        mv = chess.Move.from_uci(u)
        if mv not in board.legal_moves:
            raise HTTPException(400, f"불법 수: {u}")
        node = node.add_variation(mv)
        board.push(mv)
    game.headers["Result"] = board.result(claim_draw=True) if board.is_game_over(claim_draw=True) else "*"
    return game


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.api_route("/", methods=["GET", "HEAD"])
def index():
    # no-cache: browsers must revalidate the HTML on every visit (cheap 304 via
    # ETag). Without this, heuristic caching kept serving a stale page after
    # updates. Static assets are versioned (?v=N) so they stay cacheable.
    return FileResponse(os.path.join(STATIC, "index.html"),
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                                 "Pragma": "no-cache", "Expires": "0"})


@app.get("/privacy")
def privacy():
    return FileResponse(os.path.join(STATIC, "privacy.html"),
                        headers={"Cache-Control": "no-cache"})


@app.get("/terms")
def terms():
    return FileResponse(os.path.join(STATIC, "terms.html"),
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(STATIC, "manifest.webmanifest"),
                        media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # served from the root so its scope covers the whole app (not just /static)
    return FileResponse(os.path.join(STATIC, "sw.js"),
                        media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})


# GET + HEAD so uptime monitors (which default to HEAD) get 200, not 405.
@app.api_route("/api/health", methods=["GET", "HEAD"])
def health():
    cfg = EngineConfig()
    import webapp.auth as _auth
    return {
        "stockfish": bool(cfg.path),
        "stockfishPath": cfg.path,
        "coaching": coach_mod.coaching_available(),
        "db": "postgres" if _auth._IS_PG else "sqlite",   # durable? (diagnostic)
    }


@app.post("/api/legal")
def legal(req: LegalRequest):
    """Validate the moves so far and return the legal-move map for the position."""
    board = _replay(req.moves, req.startFen)
    state = _legal_state(board)
    state["san"] = _san_history(req.moves, req.startFen)
    return state


@app.get("/api/variant960")
def variant960():
    """A random Chess960 (Fischer random) starting position."""
    import random
    n = random.randint(0, 959)
    board = chess.Board.from_chess960_pos(n)
    return {"ok": True, "pos": n, "startFen": board.fen()}


class FenRequest(BaseModel):
    fen: str


@app.post("/api/legal_fen")
def legal_fen(req: FenRequest):
    """Legal-move map for an arbitrary FEN (used by the puzzle board)."""
    try:
        board = chess.Board(req.fen)
    except ValueError:
        raise HTTPException(400, "잘못된 FEN")
    return _legal_state(board)


@app.post("/api/ai_move")
def ai_move(req: AiMoveRequest):
    """Have the engine play one reply at the given difficulty (1-10).

    Returns the reply move plus the legal-move state AFTER the reply (or move=None
    if the game is already over).
    """
    if not EngineConfig().path:
        raise HTTPException(500, "Stockfish 바이너리를 찾을 수 없습니다.")
    board = _replay(req.moves, req.startFen)
    moves = list(req.moves)
    reply_uci = None
    reply_san = None
    if not board.is_game_over(claim_draw=True):
        with _qlock:
            try:
                mv = _quick_engine().play(board, req.level, req.style)
            except Exception:
                _quick_reset()
                mv = _quick_engine().play(board, req.level, req.style)
        if mv is not None:
            reply_san = board.san(mv)
            board.push(mv)
            reply_uci = mv.uci()
            moves.append(reply_uci)

    state = _legal_state(board)
    state["move"] = reply_uci
    state["sanMove"] = reply_san
    state["san"] = _san_history(moves, req.startFen)
    return state


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not EngineConfig().path:
        raise HTTPException(500, "Stockfish 바이너리를 찾을 수 없습니다. STOCKFISH_PATH 설정 필요.")
    if req.movetime:
        mt, dp = max(50, min(3000, req.movetime)), None
    else:
        mt, dp = None, max(6, min(24, req.depth))

    if req.pgn and req.pgn.strip():
        game = read_first_game(req.pgn)
        if game is None or not list(game.mainline_moves()):
            raise HTTPException(400, "PGN에서 유효한 게임을 찾지 못했습니다.")
    elif req.moves:
        game = _game_from_moves(req.moves, req.white, req.black)
        if not list(game.mainline_moves()):
            raise HTTPException(400, "분석할 수가 없습니다. 먼저 수를 두거나 PGN을 입력하세요.")
    else:
        raise HTTPException(400, "pgn 또는 moves 중 하나는 필요합니다.")

    # Reuse the persistent engine pool (no per-request subprocess startup).
    with _plock:
        try:
            pool = _analysis_pool()
            for e in pool:
                e.config.multipv = 1
                e.config.movetime_ms, e.config.depth = mt, dp
            ga = analyze_game_parallel(game, pool)
        except Exception:
            _pool_reset()
            pool = _analysis_pool()
            for e in pool:
                e.config.multipv = 1
                e.config.movetime_ms, e.config.depth = mt, dp
            ga = analyze_game_parallel(game, pool)
    view = build_view_data(game, ga)

    if req.coach:
        view["coach"] = coach_mod.generate_coaching(view, req.lang)
    else:
        view["coach"] = {"available": coach_mod.coaching_available()}
    return JSONResponse(view)


# --------------------------------------------------------------------------- #
# Client-assisted analysis: the browser's Stockfish (stockfish.js) does the slow
# per-position SEARCH; the server keeps ownership of move-gen + all the
# classification/coaching view-building. /api/positions hands the client the
# FENs to evaluate; /api/analyze_client turns the client's evals into the same
# review the fully server-side /api/analyze produces.
# --------------------------------------------------------------------------- #
class PositionsRequest(BaseModel):
    moves: list[str]


class ClientEval(BaseModel):
    cp: Optional[int] = None
    mate: Optional[int] = None
    bestUci: Optional[str] = None
    pv: list[str] = []


class AnalyzeClientRequest(BaseModel):
    moves: list[str]
    white: str = "White"
    black: str = "Black"
    evals: list[Optional[ClientEval]]
    movetime: Optional[int] = 300
    coach: bool = False
    lang: str = "ko"


@app.post("/api/positions")
def positions(req: PositionsRequest):
    """The N+1 position FENs of a game, plus how many opening plies to skip
    (book moves the client needn't evaluate)."""
    if not req.moves:
        raise HTTPException(400, "분석할 수가 없습니다.")
    if len(req.moves) > 600:
        raise HTTPException(400, "너무 긴 게임입니다.")
    game = _game_from_moves(req.moves, "White", "Black")
    boards = build_boards(game)
    return {"fens": [b.fen() for b in boards], "skip": _book_skip(boards), "count": len(boards)}


@app.post("/api/analyze_client")
def analyze_client(req: AnalyzeClientRequest):
    """Build the review from client-computed evals (one PositionEval per board)."""
    game = _game_from_moves(req.moves, req.white, req.black)
    boards = build_boards(game)
    if len(req.evals) != len(boards):
        raise HTTPException(400, "평가 개수가 위치 수와 일치하지 않습니다.")
    skip = _book_skip(boards)
    evals: list[PositionEval] = []
    for i, b in enumerate(boards):
        ce = req.evals[i]
        if i < skip or ce is None:
            evals.append(_book_eval())
            continue
        best_move = best_san = None
        if ce.bestUci:
            try:
                m = chess.Move.from_uci(ce.bestUci)
                if m in b.legal_moves:
                    best_move, best_san = m, b.san(m)
            except Exception:
                best_move = None
        pv_uci = list(ce.pv or [])
        pv_san: list[str] = []
        if pv_uci:
            bb = b.copy()
            for u in pv_uci:
                try:
                    mm = chess.Move.from_uci(u)
                except Exception:
                    break
                if mm not in bb.legal_moves:
                    break
                pv_san.append(bb.san(mm))
                bb.push(mm)
        cp = ce.cp if ce.mate is None else None
        evals.append(PositionEval(cp=cp, mate=ce.mate, best_move=best_move,
                                  best_move_san=best_san, pv=pv_san, pv_uci=pv_uci, multipv=[]))
    desc = {"engine": "stockfish.js (client)", "movetime_ms": req.movetime, "depth": None,
            "threads": 1, "hash_mb": 16, "workers": 1}
    ga = _assemble(game, boards, evals, desc, None, skip)
    view = build_view_data(game, ga)
    if req.coach:
        view["coach"] = coach_mod.generate_coaching(view, req.lang)
    else:
        view["coach"] = {"available": coach_mod.coaching_available()}
    return JSONResponse(view)


@app.post("/api/puzzle_move")
def puzzle_move(req: PuzzleMoveRequest):
    """Verify a move in a mate-in-N puzzle and, if correct, play the best defense.

    The move is correct if it delivers mate (when 1 left) or keeps a forced mate
    in the remaining number of moves. On a correct non-final move the engine
    plays the defender's best (longest) reply and returns the new position.
    """
    if not EngineConfig().path:
        raise HTTPException(500, "Stockfish 바이너리를 찾을 수 없습니다.")
    try:
        board = chess.Board(req.fen)
    except ValueError:
        raise HTTPException(400, "잘못된 FEN")
    try:
        mv = chess.Move.from_uci(req.move)
    except ValueError:
        raise HTTPException(400, "잘못된 수")
    if mv not in board.legal_moves:
        return {"ok": True, "correct": False, "reason": "illegal"}

    user_san = board.san(mv)
    board.push(mv)
    user_fen = board.fen()
    if board.is_checkmate():
        return {"ok": True, "correct": True, "solved": True,
                "userSan": user_san, "userFen": user_fen, "fen": user_fen}

    # Defender to move: must be getting mated in (mateIn - 1).
    target = max(0, req.mateIn - 1)
    def _eval_full(b):
        qe = _quick_engine()
        qe.config.multipv, qe.config.depth, qe.config.movetime_ms = 1, None, 350
        # the shared quick engine may have UCI_LimitStrength set by ai_move; the
        # puzzle check needs full strength to confirm the forced mate.
        try:
            qe._engine.configure({"UCI_LimitStrength": False})
        except Exception:
            pass
        return qe.evaluate(b)

    with _qlock:
        try:
            pe = _eval_full(board)
        except Exception:
            _quick_reset()
            pe = _eval_full(board)
    ok = (pe.mate is not None and pe.mate < 0 and 1 <= (-pe.mate) <= target)
    if not ok:
        return {"ok": True, "correct": False, "userSan": user_san, "userFen": user_fen}

    # Correct — play the defender's best (longest) reply.
    reply = pe.best_move
    reply_san = board.san(reply) if reply else None
    if reply is not None:
        board.push(reply)
    return {
        "ok": True, "correct": True, "solved": False,
        "userSan": user_san, "userFen": user_fen,
        "replyUci": reply.uci() if reply else None,
        "replySan": reply_san, "fen": board.fen(),
        "mateIn": req.mateIn - 1, "check": board.is_check(),
    }


class EvalFenRequest(BaseModel):
    fen: str
    moves: list[str] = []             # optional UCI moves to apply to `fen` first
    movetime: Optional[int] = 300     # ms per position


@app.post("/api/eval_fen")
def eval_fen(req: EvalFenRequest):
    """Evaluate a position for the free analysis board.

    Starts from `fen`, optionally applies `moves` (UCI, played from that FEN),
    then returns the legal-move map / turn / check for the resulting position
    (same shape as /api/legal_fen so the frontend board renderer can reuse it),
    the resulting `fen` and `san` history, PLUS a full-strength quick-engine
    evaluation of the position (best move + cp/mate from the side-to-move POV).
    Never raises into the request path: engine failures return best-effort JSON
    with a null evaluation.
    """
    _ckey = (req.fen, tuple(req.moves), int(req.movetime or 300))
    _cached = _eval_cache_get(_ckey)
    if _cached is not None:
        return _cached

    try:
        board = chess.Board(req.fen)
    except ValueError:
        raise HTTPException(400, "잘못된 FEN")

    san_hist: list[str] = []
    for i, u in enumerate(req.moves):
        try:
            mv = chess.Move.from_uci(u)
        except ValueError:
            raise HTTPException(400, f"잘못된 수 표기: {u} (#{i+1})")
        if mv not in board.legal_moves:
            raise HTTPException(400, f"불법 수: {u} (#{i+1})")
        san_hist.append(board.san(mv))
        board.push(mv)

    state = _legal_state(board)
    resp = {
        "legal": state["legal"],
        "turn": state["turn"],
        "check": state["check"],
        "fen": state["fen"],
        "san": san_hist,
        "gameOver": state["gameOver"],
        "result": state["result"] if state["gameOver"] else None,
        "bestUci": None,
        "bestSan": None,
        "cp": None,
        "mate": None,
        "pv": [],
    }

    if state["gameOver"] or not EngineConfig().path:
        _eval_cache_put(_ckey, resp)
        return resp

    mt = max(50, min(3000, req.movetime or 300))

    def _eval_full(b):
        qe = _quick_engine()
        qe.config.multipv, qe.config.depth, qe.config.movetime_ms = 1, None, mt
        # the shared quick engine may have UCI_LimitStrength set by ai_move;
        # analysis wants full strength.
        try:
            qe._engine.configure({"UCI_LimitStrength": False})
        except Exception:
            pass
        return qe.evaluate(b)

    try:
        with _qlock:
            try:
                pe = _eval_full(board)
            except Exception:
                _quick_reset()
                pe = _eval_full(board)
        resp["bestUci"] = pe.best_move.uci() if pe.best_move else None
        resp["bestSan"] = pe.best_move_san
        resp["cp"] = pe.cp
        resp["mate"] = pe.mate
        resp["pv"] = pe.pv or []
    except Exception:
        pass

    _eval_cache_put(_ckey, resp)
    return resp


@app.post("/api/study_html", response_class=PlainTextResponse)
def study_html(req: StudyRequest):
    """Bake the annotated line into a standalone, shareable HTML document."""
    _replay(req.moves)  # validate
    html = render_study_html(
        moves=req.moves,
        comments=req.comments,
        shapes=req.shapes,
        white=req.white,
        black=req.black,
        title=req.title,
    )
    return PlainTextResponse(html, media_type="text/html; charset=utf-8")


# Online multiplayer (WebSocket matchmaking + move relay) — /ws
from webapp.online import register_online  # noqa: E402
from webapp.auth import (  # noqa: E402
    rating_for_token, apply_online_result,
    save_online_snapshot, load_online_snapshot, delete_online_snapshot,
)
# server-authoritative online rating: the lobby resolves each player's rating
# from their auth token at match start and persists the Elo change on game end.
# FIX5: snapshot hooks let an in-progress game resume after a server restart.
register_online(app, _legal_state,
                rating_hooks={"resolve": rating_for_token, "apply": apply_online_result,
                              "snap_save": save_online_snapshot,
                              "snap_load": load_online_snapshot,
                              "snap_del": delete_online_snapshot})

# Accounts (register/login + server-saved progress) — /api/auth/*
from webapp.auth import register_auth  # noqa: E402
register_auth(app)
# MODE2: correspondence / daily chess (async games in Neon) + MODE8 async swiss
from webapp.corr import register_corr  # noqa: E402
register_corr(app)
# 3-player Trident chess engine endpoints (hotseat)
from webapp.trident import register_trident  # noqa: E402
register_trident(app)
# 3-player Trident online lobby (WebSocket /ws3)
from webapp.trident_online import register_trident_online  # noqa: E402
register_trident_online(app)
# Cross (plus-shaped) 3/4-player chess: engine endpoints + online lobby (/wsc)
from webapp.cross import register_cross  # noqa: E402
register_cross(app)
from webapp.cross_online import register_cross_online  # noqa: E402
register_cross_online(app)

app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port)
