"""Trident Chess — a 3-player chess variant on a 96-cell hexagonal board.

Board model (our concrete, self-consistent geometry):
  * 3 sectors (0,1,2) arranged clockwise, one army each.
  * Each sector is 8 files (a-h = 0..7) x 4 ranks (1..4). Rank 1 is the player's
    home back rank; rank 4 faces the central hub. 3 * 8 * 4 = 96 cells.
  * A cell is idx = s*32 + (r-1)*8 + f.

Movement (only the hub crossing is new; everything else is standard chess):
  * FILE lines cross the hub. A file runs (s: rank 1->4, f) then continues into a
    neighbour (rank 4->1, 7-f). Left-half files (a-d) feed the left neighbour,
    right-half files (e-h) the right neighbour; the mapping f<->7-f is an
    involution and 120deg-symmetric. Rooks/queens/pawns/king use these.
  * RANK lines are the 8-cell rows inside a sector and do NOT wrap the hub.
  * DIAGONAL lines step (+-1 rank, +-1 file) inside a sector and cross the front
    seam via the file mapping, continuing inward in the neighbour. Built as
    explicit, reversible lines (see _build_diag_lines).
  * KNIGHT = (2,1) leaps derived from the line graph. KING = one step to any
    orthogonal or diagonal neighbour. PAWN advances up its file toward/through the
    hub, captures diagonally-forward, double-steps from rank 2, promotes on
    reaching any opponent's rank 1.

Rules: strict clockwise turns; you may never move into check and must escape every
check; the FIRST checkmate ends the game and the mating side wins outright (no
elimination phase — the kingmaker cure).
"""
from __future__ import annotations

COLORS = ("w", "g", "b")   # White, Grey, Black — sectors 0,1,2


def idx(s, r, f):
    return s * 32 + (r - 1) * 8 + f


def cell(i):
    s, rem = divmod(i, 32)
    r, f = divmod(rem, 8)
    return s, r + 1, f


def cross(s, f):
    """Where file f of sector s continues across the hub: (neighbour, file)."""
    if f < 4:
        return (s + 2) % 3, 7 - f     # left neighbour
    return (s + 1) % 3, 7 - f          # right neighbour


# --------------------------------------------------------------------------- #
# precomputed line structure
# --------------------------------------------------------------------------- #
def _build_file_lines():
    lines = []
    for s in range(3):
        for f in range(4):                     # each file-line authored once (f<4)
            L = (s + 2) % 3
            g = 7 - f
            lines.append([idx(s, 1, f), idx(s, 2, f), idx(s, 3, f), idx(s, 4, f),
                          idx(L, 4, g), idx(L, 3, g), idx(L, 2, g), idx(L, 1, g)])
    return lines


def _build_rank_lines():
    return [[idx(s, r, f) for f in range(8)] for s in range(3) for r in range(1, 5)]


FILE_LINES = _build_file_lines()
RANK_LINES = _build_rank_lines()


def _line_index(lines):
    """cell -> (line, position) for the (assumed unique) line containing it."""
    m = {}
    for ln in lines:
        for p, c in enumerate(ln):
            m[c] = (ln, p)
    return m


_FILE_OF = _line_index(FILE_LINES)
_RANK_OF = _line_index(RANK_LINES)


def _ortho_neighbours(c):
    """Up to 4 edge-adjacent cells (prev/next on the file-line and rank-line)."""
    out = []
    ln, p = _FILE_OF[c]
    if p > 0:
        out.append(ln[p - 1])
    if p < len(ln) - 1:
        out.append(ln[p + 1])
    ln, p = _RANK_OF[c]
    if p > 0:
        out.append(ln[p - 1])
    if p < len(ln) - 1:
        out.append(ln[p + 1])
    return out


def _diag_step(s, r, f, dr, df):
    """One diagonal step (dr,df in +-1). Returns (s2,r2,f2,dr2,df2) with the
    (possibly reflected) continuing direction, or None at a board edge."""
    nr, nf = r + dr, f + df
    if 1 <= nr <= 4 and 0 <= nf <= 7:
        return (s, nr, nf, dr, df)
    if nr == 5:                       # crossed the front (hub) edge
        nb, cf = cross(s, f)
        # entering the neighbour's front rank, now moving inward (dr flips to -1);
        # the mirror seam flips the file direction too.
        ndf = -df
        nnf = cf + ndf
        if 0 <= nnf <= 8 - 1 and 1 <= 4 <= 4:
            # take the diagonal step immediately into the neighbour
            if 0 <= nnf <= 7:
                return (nb, 4 - 1, nnf, -1, ndf) if (4 - 1) >= 1 else None
        return None
    return None


def _build_diag_lines():
    """Maximal, reversible diagonal lines. Walk each of the two diagonal
    orientations from every unused start until both ends terminate."""
    lines = []
    seen_pairs = set()   # dedupe by frozenset of an adjacent (a,b) pair signature
    for start in range(96):
        s0, r0, f0 = cell(start)
        for dr, df in ((1, 1), (1, -1)):
            # walk forward
            chain = [start]
            s, r, f, cdr, cdf = s0, r0, f0, dr, df
            while True:
                nxt = _diag_step(s, r, f, cdr, cdf)
                if nxt is None:
                    break
                s, r, f, cdr, cdf = nxt
                ci = idx(s, r, f)
                if ci in chain:
                    break
                chain.append(ci)
            # walk backward from start (reverse direction)
            back = []
            s, r, f, cdr, cdf = s0, r0, f0, -dr, -df
            while True:
                nxt = _diag_step(s, r, f, cdr, cdf)
                if nxt is None:
                    break
                s, r, f, cdr, cdf = nxt
                ci = idx(s, r, f)
                if ci in chain or ci in back:
                    break
                back.append(ci)
            full = list(reversed(back)) + chain
            if len(full) < 2:
                continue
            sig = tuple(full) if full[0] < full[-1] else tuple(reversed(full))
            if sig in seen_pairs:
                continue
            seen_pairs.add(sig)
            lines.append(full)
    return lines


DIAG_LINES = _build_diag_lines()


def _diag_positions():
    """cell -> list of (line, position) — a cell can be on up to 2 diagonals."""
    m = {}
    for ln in DIAG_LINES:
        for p, c in enumerate(ln):
            m.setdefault(c, []).append((ln, p))
    return m


_DIAG_OF = _diag_positions()


def _diag_neighbours(c):
    out = []
    for ln, p in _DIAG_OF.get(c, []):
        if p > 0:
            out.append(ln[p - 1])
        if p < len(ln) - 1:
            out.append(ln[p + 1])
    return out


# knight: two along one line + one perpendicular, via the ortho graph
def _knight_targets(c):
    out = set()
    for a in _ortho_neighbours(c):
        for b in _ortho_neighbours(a):
            if b == c:
                continue
            # b is 2 steps away; a knight target is one perpendicular step from b
            for t in _ortho_neighbours(b):
                if t == a or t == c:
                    continue
                # require the a->b and b->t steps to be "perpendicular-ish":
                # t must NOT be collinear with c through a (avoid straight 3-runs)
                if t in _ortho_neighbours(c):
                    continue
                # and the (c,a,b) must be a straight 2-run, (b,t) a turn
                if _collinear(c, a, b) and not _collinear(a, b, t):
                    out.add(t)
    return out


def _collinear(a, b, cc):
    """Are a-b and b-cc along the SAME line (file or rank)?"""
    for m in (_FILE_OF, _RANK_OF):
        la, pa = m[a]
        lb, pb = m[b]
        lc, pc = m[cc]
        if la is lb is lc and abs(pa - pb) == 1 and abs(pb - pc) == 1:
            return True
    return False


# =========================================================================== #
# board + move generation
# =========================================================================== #
START_PIECES = "RNBQKBNR"   # rank-1 order, files a..h


class Trident:
    def __init__(self):
        # board[i] = (color_index, piece_char) or None
        self.board = [None] * 96
        for s in range(3):
            for f in range(8):
                self.board[idx(s, 1, f)] = (s, START_PIECES[f])
                self.board[idx(s, 2, f)] = (s, "P")
        self.turn = 0            # sector to move (0->1->2 clockwise)
        self.winner = None       # sector index of the winner, or None
        self.over = False

    # ---- attack / move helpers ----
    def _slide(self, c, lines_of):
        out = []
        for ln, p in ([lines_of[c]] if not isinstance(lines_of.get(c), list) else lines_of[c]):
            for step in (-1, 1):
                q = p + step
                while 0 <= q < len(ln):
                    t = ln[q]
                    occ = self.board[t]
                    if occ is None:
                        out.append(t)
                    else:
                        out.append(t)
                        break
                    q += step
        return out

    def _slide_ortho(self, c, use_file, use_rank):
        out = []
        srcs = []
        if use_file:
            srcs.append(_FILE_OF[c])
        if use_rank:
            srcs.append(_RANK_OF[c])
        for ln, p in srcs:
            for step in (-1, 1):
                q = p + step
                while 0 <= q < len(ln):
                    t = ln[q]
                    if self.board[t] is None:
                        out.append(t)
                    else:
                        out.append(t); break
                    q += step
        return out

    def _slide_diag(self, c):
        out = []
        for ln, p in _DIAG_OF.get(c, []):
            for step in (-1, 1):
                q = p + step
                while 0 <= q < len(ln):
                    t = ln[q]
                    if self.board[t] is None:
                        out.append(t)
                    else:
                        out.append(t); break
                    q += step
        return out

    def _pawn_moves(self, c, col):
        """Pawns advance toward/through the hub (forward = up the file-line, away
        from home rank 1). Capture the two diagonal-forward neighbours."""
        out = []
        ln, p = _FILE_OF[c]
        # 'forward' (toward/through the hub) is whichever file-line direction leaves
        # home: positions 0..3 are a sector's own ranks 1..4 → forward = +1; the far
        # half (positions 4..7, a neighbour's ranks 4..1) → forward = -1.
        s, r, f = cell(c)
        forward = 1 if p <= 3 else -1
        one = p + forward
        if 0 <= one < len(ln) and self.board[ln[one]] is None:
            out.append(ln[one])
            # double-step only from the pawn's OWN starting rank 2
            if r == 2 and s == col:
                two = p + 2 * forward
                if 0 <= two < len(ln) and self.board[ln[two]] is None:
                    out.append(ln[two])
        # captures: the diagonal-forward neighbours
        fwd_cell = ln[one] if 0 <= one < len(ln) else None
        for d in _diag_neighbours(c):
            # a diagonal neighbour counts as "forward" if it's adjacent to fwd_cell
            if fwd_cell is not None and (d in _ortho_neighbours(fwd_cell) or d == fwd_cell):
                occ = self.board[d]
                if occ is not None and occ[0] != col:
                    out.append(d)
        return out

    def _piece_targets(self, c):
        occ = self.board[c]
        if occ is None:
            return []
        col, pc = occ
        if pc == "R":
            raw = self._slide_ortho(c, True, True)
        elif pc == "B":
            raw = self._slide_diag(c)
        elif pc == "Q":
            raw = self._slide_ortho(c, True, True) + self._slide_diag(c)
        elif pc == "N":
            raw = list(_knight_targets(c))
        elif pc == "K":
            raw = _ortho_neighbours(c) + _diag_neighbours(c)
        elif pc == "P":
            raw = self._pawn_moves(c, col)
        else:
            raw = []
        return list(dict.fromkeys(t for t in raw if t != c))   # dedupe seam overlaps

    def _is_attacked(self, target, by_cols):
        """Is `target` attacked by any piece whose colour is in by_cols?"""
        for c in range(96):
            occ = self.board[c]
            if occ is None or occ[0] not in by_cols:
                continue
            col, pc = occ
            if pc == "P":
                # pawns attack only their two diagonal-forward squares
                if target in self._pawn_attacks(c, col):
                    return True
            elif target in self._piece_targets(c):
                return True
        return False

    def _pawn_attacks(self, c, col):
        ln, p = _FILE_OF[c]
        forward = 1 if p <= 3 else -1
        one = p + forward
        fwd_cell = ln[one] if 0 <= one < len(ln) else None
        atk = []
        for d in _diag_neighbours(c):
            if fwd_cell is not None and (d in _ortho_neighbours(fwd_cell) or d == fwd_cell):
                atk.append(d)
        return atk

    def _king_of(self, col):
        for c in range(96):
            occ = self.board[c]
            if occ == (col, "K"):
                return c
        return None

    def in_check(self, col):
        k = self._king_of(col)
        if k is None:
            return False
        others = tuple(x for x in range(3) if x != col)
        return self._is_attacked(k, others)

    def legal_moves(self, col=None):
        """All legal (from,to) moves for `col` (default: side to move), i.e. moves
        that do not leave your own king in check."""
        if col is None:
            col = self.turn
        moves = []
        for c in range(96):
            occ = self.board[c]
            if occ is None or occ[0] != col:
                continue
            for t in self._piece_targets(c):
                dest = self.board[t]
                if dest is not None and dest[0] == col:
                    continue   # can't capture own piece
                # simulate
                sc, st = self.board[c], self.board[t]
                self.board[t] = self.board[c]
                self.board[c] = None
                promo = False
                # auto-queen a pawn reaching an opponent's rank 1
                if sc[1] == "P":
                    ts, tr, tf = cell(t)
                    if tr == 1 and ts != col:
                        self.board[t] = (col, "Q"); promo = True
                bad = self.in_check(col)
                self.board[c], self.board[t] = sc, st
                if not bad:
                    moves.append((c, t, "Q" if promo else None))
        return moves

    def push(self, c, t):
        occ = self.board[c]
        if occ is None:
            return False
        col = occ[0]
        legal = [(a, b, pr) for (a, b, pr) in self.legal_moves(col) if a == c and b == t]
        if not legal:
            return False
        _, _, pr = legal[0]
        self.board[t] = (col, pr) if pr else occ
        self.board[c] = None
        # first checkmate wins the whole game
        for other in (x for x in range(3) if x != col):
            if self.in_check(other) and not self.legal_moves(other):
                self.over = True
                self.winner = col
                return True
        # advance the turn clockwise (skip an already-mated seat — none in this
        # design, since the game ends at the first mate)
        self.turn = (col + 1) % 3
        return True

    def to_dict(self):
        return {
            "board": [None if x is None else [x[0], x[1]] for x in self.board],
            "turn": self.turn, "over": self.over, "winner": self.winner,
        }


# --------------------------------------------------------------------------- #
# HTTP endpoints (stateless engine access — used by the hotseat client; the
# online lobby keeps authoritative state server-side and calls the engine directly)
# --------------------------------------------------------------------------- #
try:                                     # module-level so FastAPI can resolve it
    from pydantic import BaseModel

    class TMove(BaseModel):
        board: list
        turn: int
        frm: int
        to: int
except ImportError:                      # engine + self-test import without pydantic
    TMove = None


def register_trident(app) -> None:
    def _state(g):
        d = g.to_dict()
        d["ok"] = True
        d["moves"] = [] if g.over else [[a, b] for (a, b, pr) in g.legal_moves(g.turn)]
        return d

    @app.post("/api/trident/new")
    def trident_new():
        return _state(Trident())

    @app.post("/api/trident/move")
    def trident_move(req: TMove):
        g = Trident()
        try:
            g.board = [None if x is None else (int(x[0]), str(x[1])) for x in req.board]
        except Exception:
            return {"ok": False}
        if len(g.board) != 96:
            return {"ok": False}
        g.turn = int(req.turn) % 3
        if not g.push(int(req.frm), int(req.to)):
            return {"ok": False, "illegal": True}
        d = _state(g)
        d["last"] = [int(req.frm), int(req.to)]
        return d


# --------------------------------------------------------------------------- #
# self-test
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # 1) structure invariants
    assert len(FILE_LINES) == 12 and all(len(l) == 8 for l in FILE_LINES)
    assert len(RANK_LINES) == 12 and all(len(l) == 8 for l in RANK_LINES)
    covered = set()
    for l in FILE_LINES:
        covered |= set(l)
    assert len(covered) == 96, ("file-lines cover", len(covered))
    covered = set()
    for l in RANK_LINES:
        covered |= set(l)
    assert len(covered) == 96, "rank-lines cover"
    dcov = set()
    for l in DIAG_LINES:
        dcov |= set(l)
    print("diag lines:", len(DIAG_LINES), "cells on a diagonal:", len(dcov), "/96")

    # 2) file crossing is an involution
    for s in range(3):
        for f in range(8):
            nb, nf = cross(s, f)
            b2, f2 = cross(nb, nf)
            assert (b2, f2) == (s, f), ("cross not involution", s, f, nb, nf)
    print("cross involution: OK")

    # 3) 120deg rotational symmetry of the start position
    t = Trident()
    for c in range(96):
        s, r, f = cell(c)
        occ = t.board[c]
        rot = t.board[idx((s + 1) % 3, r, f)]
        if occ is None:
            assert rot is None
        else:
            assert rot is not None and rot[1] == occ[1] and rot[0] == (occ[0] + 1) % 3
    print("start rotational symmetry: OK")

    # 4) opening move counts (should be equal for all three by symmetry)
    counts = []
    for col in range(3):
        t2 = Trident(); t2.turn = col
        counts.append(len(t2.legal_moves(col)))
    print("opening legal moves per colour:", counts)
    assert counts[0] == counts[1] == counts[2], "asymmetric opening"
    assert counts[0] > 0

    # 5) no side starts in check
    for col in range(3):
        assert not Trident().in_check(col)
    print("no side in check at start: OK")

    print("ALL ENGINE SELF-TESTS PASSED")
