"use strict";

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
// ADD7 (feedback): the Render free tier sleeps when idle, so the FIRST server call
// after a nap can take many seconds. Track in-flight calls and, if any is slow,
// show a non-blocking "서버 깨우는 중" banner so a slow response reads as loading,
// not as a freeze. Fast calls (the common case) never trigger it.
let _apiInflight = 0, _warmTimer = null;
function _apiStart() {
  _apiInflight++;
  if (!_warmTimer) _warmTimer = setTimeout(() => { if (_apiInflight > 0 && typeof showWarming === "function") showWarming(); }, 4500);
}
function _apiEnd() {
  _apiInflight = Math.max(0, _apiInflight - 1);
  if (_apiInflight === 0) { clearTimeout(_warmTimer); _warmTimer = null; if (typeof hideWarming === "function") hideWarming(); }
}
async function api(path, body) {
  _apiStart();
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return await res.json();
  } finally { _apiEnd(); }
}
function showWarming() { const el = document.getElementById("warmBanner"); if (el) { el.textContent = (typeof t === "function") ? t("warming_msg") : "서버 깨우는 중…"; el.classList.remove("hidden"); } }
function hideWarming() { const el = document.getElementById("warmBanner"); if (el) el.classList.add("hidden"); }
const $ = (id) => document.getElementById(id);
// Trailing ︎ = text-presentation selector: forces iOS/Safari to render the
// chess symbols as TEXT (so our .pc.w/.pc.b CSS colors apply) instead of as
// same-colored emoji, which made white and black pieces look identical.
const GLYPH = { k: "♚︎", q: "♛︎", r: "♜︎", b: "♝︎", n: "♞︎", p: "♟︎" };

// Slide the piece that just moved from its origin square to its destination,
// so moves look smooth even though the board is re-rendered from scratch.
function animateMove(boardEl, fromSq, toSq, orient) {
  if (!boardEl || !fromSq || !toSq) return;
  const files = orient === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orient === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const fc = files.indexOf(fromSq[0]), fr = ranks.indexOf(+fromSq[1]);
  const tc = files.indexOf(toSq[0]), tr = ranks.indexOf(+toSq[1]);
  if (fc < 0 || tc < 0 || fr < 0 || tr < 0) return;
  const cell = (boardEl.clientWidth || 440) / 8;
  const dx = (fc - tc) * cell, dy = (fr - tr) * cell;
  const sqDiv = boardEl.children[tr * 8 + tc];
  const pc = sqDiv && sqDiv.querySelector(".pc");
  if (!pc) return;
  // start at the origin square, then transition to 0 (forced reflow so the
  // start position registers — more reliable than requestAnimationFrame).
  pc.style.transition = "none";
  pc.style.transform = `translate(${dx}px, ${dy}px)`;
  pc.style.zIndex = "12";
  void pc.offsetWidth;
  pc.style.transition = "transform .22s cubic-bezier(.22,.61,.36,1)";
  pc.style.transform = "translate(0, 0)";
}

// square <div> at board coordinate `sq`, honoring board orientation (same
// indexing renderBoard/animateMove use).
function _sqDivOf(boardEl, sq, orient) {
  const files = orient === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orient === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const fi = files.indexOf(sq[0]), ri = ranks.indexOf(+sq[1]);
  if (fi < 0 || ri < 0) return null;
  return boardEl.children[ri * 8 + fi];
}
// Move the piece in the DOM *now* for instant feedback, before the server
// confirms. The authoritative re-render (a moment later) fixes any special-move
// details. Handles the common cases (capture, castling rook) cleanly.
function optimisticMove(boardEl, from, to, orient) {
  const fromDiv = _sqDivOf(boardEl, from, orient), toDiv = _sqDivOf(boardEl, to, orient);
  if (!fromDiv || !toDiv) return;
  const pc = fromDiv.querySelector(".pc");
  if (!pc) return;
  const cap = toDiv.querySelector(".pc"); if (cap) cap.remove();
  toDiv.appendChild(pc);
  // castling: king moves two files → bring the matching rook along
  // (charAt(0): ignore the trailing text-presentation selector on the glyph)
  const _kg = pc.textContent.charAt(0);
  if (_kg === "♔" || _kg === "♚") {
    const ff = "abcdefgh".indexOf(from[0]), tf = "abcdefgh".indexOf(to[0]), rank = from[1];
    const shift = (rf, rt) => {
      const rFrom = _sqDivOf(boardEl, rf + rank, orient), rTo = _sqDivOf(boardEl, rt + rank, orient);
      const r = rFrom && rFrom.querySelector(".pc"); if (r && rTo) rTo.appendChild(r);
    };
    if (tf - ff === 2) shift("h", "f");        // kingside
    else if (ff - tf === 2) shift("a", "d");   // queenside
  }
  animateMove(boardEl, from, to, orient);
}

function overlay(show, msg) {
  $("overlay").classList.toggle("hidden", !show);
  if (msg) $("overlayMsg").textContent = msg;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// user settings (persisted)
// --------------------------------------------------------------------------- //
const SETTINGS = {
  showDots: localStorage.getItem("cc_showdots") !== "0",   // legal-move grey circles
  sound: localStorage.getItem("cc_sound") !== "0",         // move/capture/check sound effects
  coords: localStorage.getItem("cc_coords") !== "0",       // a–h / 1–8 board coordinates
  boardTheme: localStorage.getItem("cc_board") || "green", // board color theme
};

// board color themes — applied by overriding the --light / --dark CSS vars
const BOARD_THEMES = {
  green: { light: "#ebecd0", dark: "#779556" },
  wood:  { light: "#f0d9b5", dark: "#b58863" },
  blue:  { light: "#dee3e6", dark: "#8ca2ad" },
  gray:  { light: "#e8e8e8", dark: "#9a9a9a" },
  coral: { light: "#fde3da", dark: "#d38068" },
};
function applyBoardTheme(name) {
  const th = BOARD_THEMES[name] || BOARD_THEMES.green;
  document.documentElement.style.setProperty("--light", th.light);
  document.documentElement.style.setProperty("--dark", th.dark);
}
applyBoardTheme(SETTINGS.boardTheme);   // apply saved theme at startup

// --------------------------------------------------------------------------- //
// sound effects — synthesized with WebAudio (no audio files; works offline)
// --------------------------------------------------------------------------- //
const SFX = {
  ctx: null,
  _beep(freq, dur, type, gain) {
    if (!SETTINGS.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!SFX.ctx) SFX.ctx = new AC();
      if (SFX.ctx.state === "suspended") SFX.ctx.resume();
      const o = SFX.ctx.createOscillator(), g = SFX.ctx.createGain(), now = SFX.ctx.currentTime;
      o.type = type || "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(gain || 0.05, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (dur || 0.08));
      o.connect(g); g.connect(SFX.ctx.destination);
      o.start(now); o.stop(now + (dur || 0.08));
    } catch (e) {}
  },
  // a "wooden knock": short filtered-noise burst + a low body tock, fast decay
  _wood(freq, dur, gain) {
    if (!SETTINGS.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!SFX.ctx) SFX.ctx = new AC();
      const ctx = SFX.ctx; if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime; dur = dur || 0.09;
      const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, n, ctx.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);   // noise with built-in decay
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq || 850; bp.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain || 0.5, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(bp); bp.connect(g); g.connect(ctx.destination);
      src.start(now); src.stop(now + dur);
      const o = ctx.createOscillator(), og = ctx.createGain();   // warm low "tock" body
      o.type = "triangle"; o.frequency.value = (freq || 850) * 0.45;
      og.gain.setValueAtTime((gain || 0.5) * 0.6, now);
      og.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.85);
      o.connect(og); og.connect(ctx.destination);
      o.start(now); o.stop(now + dur);
    } catch (e) {}
  },
  move() { this._wood(900, 0.075, 0.5); },
  capture() { this._wood(520, 0.12, 0.7); },
  check() { this._wood(1300, 0.09, 0.5); },
  castle() { this._wood(700, 0.08, 0.5); setTimeout(() => this._wood(700, 0.07, 0.45), 70); },   // two-part knock
  turn() { this._beep(660, 0.09, "sine", 0.05); setTimeout(() => this._beep(880, 0.1, "sine", 0.05), 90); },   // "your turn" cue
  win() { this._beep(523, 0.12, "sine", 0.07); setTimeout(() => this._beep(784, 0.18, "sine", 0.07), 130); haptic([15, 40, 20]); },
  lose() { this._beep(300, 0.22, "sine", 0.06); haptic(40); },
};
// subtle haptic feedback (mobile), bundled with the sound/feedback setting
function haptic(pattern) {
  if (!SETTINGS.sound) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
// pick the right sound from the just-played SAN (…x = capture, + = check, # = mate)
function playMoveSfx(state) {
  if (!SETTINGS.sound || !state || !state.san || !state.san.length) return;
  const san = state.san[state.san.length - 1] || "";
  if (san.includes("#")) { haptic([15, 40, 20]); return; }   // checkmate → the result screen sound covers it
  if (san.charAt(0) === "O") { SFX.castle(); haptic(10); }    // castling (O-O / O-O-O)
  else if (san.includes("+")) { SFX.check(); haptic([10, 30, 10]); }
  else if (san.includes("x")) { SFX.capture(); haptic([12, 8]); }
  else { SFX.move(); haptic(6); }
}

// a–h / 1–8 coordinates: rank number on the left column, file letter on the
// bottom row (orientation-aware via the caller's files/ranks arrays).
function addCoords(div, f, rank, files, ranks) {
  if (!SETTINGS.coords) return;
  if (f === files[0]) {
    const r = document.createElement("span"); r.className = "coordtag rankco"; r.textContent = rank;
    div.appendChild(r);
  }
  if (rank === ranks[ranks.length - 1]) {
    const c = document.createElement("span"); c.className = "coordtag fileco"; c.textContent = f;
    div.appendChild(c);
  }
}

// --------------------------------------------------------------------------- //
// drag-to-move (works alongside click-to-move on every game board)
// --------------------------------------------------------------------------- //
let _dragJustMoved = false;   // suppress the click that follows a drag-drop

// cfg: { movable():bool, legal():{sq:[dests]}, commit(from,to) }  — commit plays
// the move (handling promotion). Attach ONCE per board element; survives the
// board's innerHTML re-renders because the listener lives on the board itself.
function enableBoardDrag(boardEl, cfg) {
  let d = null;
  const clearTargets = () => boardEl.querySelectorAll(".dnd-target").forEach((el) => el.classList.remove("dnd-target"));

  boardEl.addEventListener("pointerdown", (e) => {
    if (!cfg.movable()) return;
    const pc = e.target.closest(".pc");
    const sqEl = pc && pc.closest(".sq");
    const from = sqEl && sqEl.dataset.sq;
    if (!from) return;                 // must grab an actual piece
    // ANY piece can be picked up; only a legal target completes a move. A piece
    // with no legal moves just lifts and snaps back.
    // no preventDefault: touch-action:pan-y (CSS) lets a vertical swipe scroll the
    // page, while letting the native click through keeps tap-to-move working on touch.
    d = { from, pc, sx: e.clientX, sy: e.clientY, moved: false, clone: null, legal: cfg.legal() || {}, cell: boardEl.getBoundingClientRect().width / 8 };
    try { boardEl.setPointerCapture(e.pointerId); } catch (err) {}
  });

  boardEl.addEventListener("pointermove", (e) => {
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
    if (!d.moved) {
      d.moved = true;
      const c = d.pc.cloneNode(true);
      c.className = d.pc.className + " dragging";
      c.style.cssText = `position:fixed;width:${d.cell}px;height:${d.cell}px;display:flex;` +
        `align-items:center;justify-content:center;font-size:${getComputedStyle(d.pc).fontSize};` +
        `pointer-events:none;z-index:70;`;
      document.body.appendChild(c);
      d.clone = c;
      d.pc.style.opacity = "0";   // hide the original so the piece itself appears to move
      if (d.pc.parentElement) d.pc.parentElement.classList.add("dnd-from");   // highlight origin square
      if (SETTINGS.showDots) (d.legal[d.from] || []).forEach((t) => { const el = boardEl.querySelector(`.sq[data-sq="${t}"]`); if (el) el.classList.add("dnd-target"); });
    }
    d.clone.style.left = (e.clientX - d.cell / 2) + "px";
    d.clone.style.top = (e.clientY - d.cell / 2) + "px";
  });

  const cleanup = () => {
    if (!d) return null;
    const cur = d; d = null;
    clearTargets();
    boardEl.querySelectorAll(".dnd-from").forEach((el) => el.classList.remove("dnd-from"));
    if (cur.clone) cur.clone.remove();
    if (cur.pc) cur.pc.style.opacity = "";
    return cur;
  };
  const finish = (e) => {
    const cur = cleanup();
    if (!cur || !cur.moved) return;   // a tap, not a drag → let the click handler run
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const sqEl = el && el.closest(".sq");
    const to = sqEl && sqEl.dataset.sq;
    if (to && to !== cur.from && cur.legal[cur.from] && cur.legal[cur.from].includes(to)) {
      _dragJustMoved = true; setTimeout(() => { _dragJustMoved = false; }, 0);
      cfg.commit(cur.from, to);
    }
  };
  boardEl.addEventListener("pointerup", finish);
  // pointercancel = the browser took the gesture for scrolling → abort, never move
  boardEl.addEventListener("pointercancel", () => { cleanup(); });
}

// Keep the active move visible by scrolling ONLY the list container — never the
// page (element.scrollIntoView scrolls the whole window, which on phones makes
// the screen jump/scroll down on every move).
function scrollListToActive(list) {
  if (!list) return;
  const act = list.querySelector(".mv.active");
  if (!act) return;
  const lr = list.getBoundingClientRect(), ar = act.getBoundingClientRect();
  if (ar.top < lr.top) list.scrollTop -= (lr.top - ar.top) + 6;
  else if (ar.bottom > lr.bottom) list.scrollTop += (ar.bottom - lr.bottom) + 6;
}

// --------------------------------------------------------------------------- //
// tabs
// --------------------------------------------------------------------------- //
// FIX2: the mobile bottom-nav is generated from the desktop top tabs, so tab
// structure (which tabs, order, icons) is authored in ONE place. Short mobile
// labels come from the navs_* keys; applyLang keeps both bars translated.
function renderBottomNav() {
  const bot = document.getElementById("bottomNav"); if (!bot) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const shortKey = { home: "navs_home", play: "navs_play", puzzle: "navs_puzzle", learn: "navs_learn", my: "navs_my" };
  const btns = [...document.querySelectorAll(".tabs > button[data-tab]")];
  bot.innerHTML = btns.map((b) => {
    const tab = b.dataset.tab;
    const icEl = b.querySelector(".ti");
    const ic = icEl ? icEl.textContent : "";
    const k = shortKey[tab] || "";
    return `<button data-tab="${tab}"${b.classList.contains("active") ? ' class="active"' : ""}>` +
      `<span class="bi">${ic}</span><span class="bl" data-i18n="${k}">${T(k)}</span></button>`;
  }).join("");
}
renderBottomNav();
// Both the desktop top-tabs and the mobile bottom-nav use [data-tab] buttons.
document.querySelectorAll("[data-tab]").forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});
function exitImmersive() {
  document.body.classList.remove("ingame", "gameover");
  const ge = document.getElementById("gameExit"); if (ge) ge.classList.add("hidden");
}
// End a game WITHOUT leaving the full-screen board: mark it over and reveal the
// floating exit button, so the final position stays on screen to review.
function markGameOver() {
  document.body.classList.add("gameover");
  const ge = document.getElementById("gameExit"); if (ge) ge.classList.remove("hidden");
}
// Top-level nav is 5 groups; several old sections fold under two of them:
//   대국(play) ← ai + online   ·   나(my) ← growth + review + analysis
const TAB_GROUP = { ai: "play", online: "play", growth: "my", review: "my", analysis: "my" };
const MY_SECTIONS = ["growth", "review", "analysis"];

function switchTab(name) {
  exitImmersive(); hideResult();              // leaving into a browse tab always exits immersive
  // FIX4: 대국 lands straight on the last-used play mode (AI by default) instead of
  // a separate picker screen; the inline AI/온라인 switcher handles mode changes.
  if (name === "play") name = localStorage.getItem("cc_lastplay") || "ai";
  // resolve the section to actually show (virtual "my" tab lands on 성장)
  const section = (name === "my") ? "growth" : name;
  if (section === "ai" || section === "online") {
    try { localStorage.setItem("cc_lastplay", section); } catch (e) {}
    document.querySelectorAll("[data-pswitch]").forEach((b) =>
      b.classList.toggle("on", b.dataset.pswitch === section));
  }
  if (section === "review" || section === "analysis") {   // FIX1: sync the depth toggle
    document.querySelectorAll("[data-revswitch]").forEach((b) =>
      b.classList.toggle("on", b.dataset.revswitch === section));
  }
  const navName = TAB_GROUP[section] || section;   // which top-level nav button lights up
  if (section !== "review" && typeof coachStopSpeak === "function") coachStopSpeak();  // stop the coach voice
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === navName));
  document.querySelectorAll(".tab").forEach((tb) =>
    tb.classList.toggle("active", tb.id === "tab-" + section));
  window.scrollTo(0, 0);
  if (MY_SECTIONS.includes(section) && typeof renderMySubnav === "function") renderMySubnav(section);
  if (section === "online") {
    if (typeof loadLeaderboard === "function") loadLeaderboard();
    if (typeof loadFriends === "function") loadFriends();
    if (typeof updateOgAuthGate === "function") updateOgAuthGate();
  }
  if (section === "home" && typeof renderHome === "function") renderHome();
  if (section === "puzzle") {
    if (typeof renderDaily === "function") renderDaily();
    // first time the puzzle tab opens: initialize the board now (deferred from boot)
    if (PZ.list.length && !PZ.baseFen && typeof loadPuzzle === "function") loadPuzzle(PZ.bootIdx || 0);
  }
  if (section === "growth" && typeof renderGrowth === "function") renderGrowth();
  if (section === "ai") { if (typeof refreshDashboard === "function") refreshDashboard(); if (typeof ensureAiBoard === "function") ensureAiBoard(); }
  if (section === "analysis" && typeof initAnalysis === "function") initAnalysis();
  if (section === "review" && typeof maybeLoadLastReview === "function") maybeLoadLastReview();
}

// segmented sub-nav for the "나" group (성장 / 복기 / 분석), rendered into the
// [data-mynav] placeholder at the top of each of the three sections.
function renderMySubnav(active) {
  const T = (typeof t === "function") ? t : ((k) => k);
  // FIX1: 복기 and 분석 are one review destination now (a depth toggle lives inside
  // it), so the sub-nav is just 성장 / 복기; 분석 highlights 복기.
  if (active === "analysis") active = "review";
  const items = [["growth", "📈", T("nav_growth")], ["review", "📊", T("my_review")]];
  const html = items.map((it) =>
    '<button class="myseg' + (it[0] === active ? " on" : "") + '" data-seg="' + it[0] + '">' + it[1] + " " + it[2] + "</button>").join("");
  document.querySelectorAll("[data-mynav]").forEach((el) => {
    el.innerHTML = html;
    el.querySelectorAll(".myseg").forEach((b) => { b.onclick = () => switchTab(b.dataset.seg); });
  });
}

// FIX4: inline AI/온라인 switcher at the top of both play sections
document.querySelectorAll("[data-pswitch]").forEach((b) => {
  b.onclick = () => {
    const mode = b.dataset.pswitch;
    if (mode === "ai") { switchTab("ai"); }
    else { switchTab("online"); }
  };
});
// FIX1: 복기 ⇄ 자유 분석 depth switcher (review + analysis are one destination)
document.querySelectorAll("[data-revswitch]").forEach((b) => {
  b.onclick = () => switchTab(b.dataset.revswitch);
});
// "대국" hub → route each mode to the underlying section (kept intact)
document.querySelectorAll("#playPicker .play-mode").forEach((b) => {
  b.onclick = () => {
    const mode = b.dataset.mode;
    if (mode === "ai" || mode === "v960") {
      switchTab("ai");
      const c = document.getElementById("ai960"); if (c) c.checked = (mode === "v960");
    } else {
      switchTab("online");   // quick-match + friend both live in the online section
      if (mode === "friend") { const f = document.getElementById("ogJoinCode"); if (f) setTimeout(() => f.focus(), 60); }
    }
  };
});
// empty-state "go analyze" buttons
document.querySelectorAll("[data-goto]").forEach((b) => {
  b.onclick = () => switchTab(b.dataset.goto);
});

// --------------------------------------------------------------------------- //
// health
// --------------------------------------------------------------------------- //
(async () => {
  try {
    { const _el = $("sfStatus"); if (_el) _el.textContent = t("sf_checking"); }
    const h = await (await fetch("/api/health")).json();
    const el = $("sfStatus");
    if (h.stockfish) {
      el.innerHTML = t("sf_connected") + (h.coaching ? t("sf_coach_on") : t("sf_coach_off"));
    } else {
      el.className = "sf bad";
      el.innerHTML = t("sf_missing");
    }
  } catch (e) { $("sfStatus").textContent = t("sf_check_fail") + e.message; }
})();

// =========================================================================== //
// Shared board helpers
// =========================================================================== //
function parseFen(fen) {
  const rows = fen.split(" ")[0].split("/");
  const map = {};
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) file += +ch;
      else { map["abcdefgh"[file] + (8 - r)] = ch; file++; }
    }
  }
  return map;
}

// captured pieces + material lead to show next to `color`'s name in a player bar
// (uses the shared materialInfo()/GLYPH defined with the online player bars).
function capHtml(mat, color) {
  if (!mat) return "";
  const caps = color === "w" ? mat.capByWhite : mat.capByBlack;
  const lead = color === "w" ? mat.wLead : -mat.wLead;
  const pcs = caps.map((c) => GLYPH[c]).join("");
  return `<span class="pv-caps">${pcs}${lead > 0 ? `<b class="pv-lead">+${lead}</b>` : ""}</span>`;
}

function promoChooser(boardEl, isWhite, cb) {
  closePromo();
  const picker = document.createElement("div");
  picker.className = "promo"; picker.id = "promoPicker";
  // pieces keep their real colour via .pc.w / .pc.b; light popup bg for the black
  // side so dark pieces stay visible (the old hardcoded #111 made white pieces black)
  if (!isWhite) picker.style.background = "#e9edf2";
  ["q", "r", "b", "n"].forEach((p) => {
    const d = document.createElement("div");
    d.className = "pc " + (isWhite ? "w" : "b");
    d.textContent = GLYPH[p];
    d.onclick = () => { closePromo(); cb(p); };
    picker.appendChild(d);
  });
  const wrap = boardEl.getBoundingClientRect();
  picker.style.left = (wrap.left + wrap.width / 2 - 30) + "px";
  picker.style.top = (wrap.top + wrap.height / 2 - 80) + "px";
  document.body.appendChild(picker);
}
function closePromo() { const p = $("promoPicker"); if (p) p.remove(); }

function download(name, text, type) {
  const b = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = name; a.click();
}

function setStatus(id, msg, err) {
  const el = $(id);
  el.textContent = msg || "";
  el.className = "status" + (err ? " err" : "");
}

// "Failed to fetch" = the request never reached the server (server not running).
function isOffline(e) {
  return /failed to fetch|networkerror|load failed|connection refused/i.test((e && e.message) || "");
}
// Network-error message (translated live via t("offline_msg")).

// =========================================================================== //
// OPENING BOOK — map a game's LEADING move sequence to a named opening. Keyed by
// space-joined UCI (every live board tracks moves as UCI: AIG.moves / OG.moves /
// AN.moves), so no SAN conversion is needed. The name is stored as an i18n KEY
// (op_*) resolved through t() so it shows in the app's language. Shorter
// prefixes are included too, so a name appears early (e.g. "e4 c5" → Sicilian)
// and refines as more theory moves are played (e.g. the Najdorf).
// =========================================================================== //
const OPENING_BOOK = {
  // ---- first-move families ----
  "e2e4 e7e5": "op_open_game",
  "e2e4 c7c5": "op_sicilian",
  "e2e4 e7e6": "op_french",
  "e2e4 c7c6": "op_caro_kann",
  "e2e4 d7d5": "op_scandinavian",
  "e2e4 d7d6": "op_pirc",
  "e2e4 g7g6": "op_modern",
  "e2e4 g8f6": "op_alekhine",
  "d2d4 d7d5": "op_queens_pawn",
  "d2d4 g8f6": "op_indian_defense",
  "d2d4 f7f5": "op_dutch",
  "c2c4": "op_english",
  "g1f3": "op_reti",
  "f2f4": "op_bird",
  // ---- 1.e4 e5 open games ----
  "e2e4 e7e5 g1f3 b8c6 f1b5": "op_ruy_lopez",
  "e2e4 e7e5 g1f3 b8c6 f1c4": "op_italian",
  "e2e4 e7e5 g1f3 b8c6 d2d4": "op_scotch",
  "e2e4 e7e5 g1f3 b8c6 b1c3 g8f6": "op_four_knights",
  "e2e4 e7e5 g1f3 g8f6": "op_petrov",
  "e2e4 e7e5 g1f3 d7d6": "op_philidor",
  "e2e4 e7e5 f2f4": "op_kings_gambit",
  "e2e4 e7e5 b1c3": "op_vienna",
  // ---- Sicilian lines ----
  "e2e4 c7c5 c2c3": "op_sicilian_alapin",
  "e2e4 c7c5 b1c3": "op_sicilian_closed",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6": "op_sicilian_najdorf",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6": "op_sicilian_dragon",
  // ---- French ----
  "e2e4 e7e6 d2d4 d7d5 e4e5": "op_french_advance",
  // ---- 1.d4 d5 ----
  "d2d4 d7d5 c2c4": "op_queens_gambit",
  "d2d4 d7d5 c2c4 e7e6": "op_qgd",
  "d2d4 d7d5 c2c4 d5c4": "op_qga",
  "d2d4 d7d5 c2c4 c7c6": "op_slav",
  "d2d4 d7d5 c1f4": "op_london",
  "d2d4 d7d5 g1f3 g8f6 c1f4": "op_london",
  // ---- 1.d4 Nf6 2.c4 Indian systems ----
  "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4": "op_nimzo_indian",
  "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6": "op_queens_indian",
  "d2d4 g8f6 c2c4 e7e6 g2g3": "op_catalan",
  "d2d4 g8f6 c2c4 g7g6": "op_kings_indian",
  "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5": "op_grunfeld",
  "d2d4 g8f6 c2c4 c7c5": "op_benoni",
  "d2d4 g8f6 c1f4": "op_london",
};

// Longest-prefix match: given a UCI move list, return the i18n key of the most
// specific opening whose move sequence is a prefix of the game, or null.
function detectOpening(uciMoves) {
  if (!uciMoves || !uciMoves.length) return null;
  let best = null, bestLen = 0;
  for (const seq in OPENING_BOOK) {
    const plies = seq.split(" ");
    if (plies.length <= uciMoves.length && plies.length > bestLen) {
      let ok = true;
      for (let i = 0; i < plies.length; i++) { if (uciMoves[i] !== plies[i]) { ok = false; break; } }
      if (ok) { best = OPENING_BOOK[seq]; bestLen = plies.length; }
    }
  }
  return best;
}

// Set the small "오프닝: 루이 로페즈" label next to a board's move list. Blank
// (and hidden) when no opening matches. Re-derives from the UCI list so it also
// refreshes correctly on a language change.
function updateOpeningLine(elId, uciMoves) {
  const el = $(elId); if (!el) return;
  const key = detectOpening(uciMoves || []);
  if (!key) { el.textContent = ""; el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.textContent = t("opening_label") + ": " + t(key);
}

// =========================================================================== //
// RATING + GAME HISTORY — per device (localStorage).
// The rating changes ONLY through online matches; AI games are logged in the
// history but never move the rating.
//
// Scale: starts at 400, can never drop below 0; 2000 ≈ pro. The higher you
// are, the LESS a win gives and the MORE a loss costs. Gains/losses also depend
// on the OPPONENT's rating (standard Elo expected score: beating someone
// stronger pays more, losing to someone weaker costs more). Equal-opponent
// amounts:
//   win : +68 at 400, +50 at 1000, +20 at 2000 (floor +16)
//   loss: -18 at 400, -30 at 1000, -50 at 2000 (cap -60)
// =========================================================================== //
const RATING_START = 400;

// New storage key: values from earlier scales would be wrong here.
function myRating() {
  const v = localStorage.getItem("cc_rating3");
  return v === null ? RATING_START : Math.max(0, +v);
}
function setMyRating(r) { localStorage.setItem("cc_rating3", String(Math.max(0, Math.round(r)))); updateRatingChip(); authSchedulePush(); }
function kWin(r) { return Math.max(32, 160 - r * 0.06); }
function kLoss(r) { return Math.min(120, 20 + r * 0.04); }
function eloDelta(mine, opp, score) {
  const expected = 1 / (1 + Math.pow(10, (opp - mine) / 400));
  const raw = score - expected;
  const k = raw >= 0 ? kWin(mine) : kLoss(mine);
  return Math.round(k * raw);
}
// Rating tiers — a chess-piece symbol next to the number, ascending by piece
// value as the rating climbs. Same brackets everywhere the rating shows.
function ratingTier(r) {
  const T = (typeof t === "function") ? t : ((k) => k);
  if (r >= 2300) return { sym: "♔", name: T("tier_master"), cls: "t-king" };
  if (r >= 1900) return { sym: "♕", name: T("tier_queen"), cls: "t-queen" };
  if (r >= 1500) return { sym: "♖", name: T("tier_rook"), cls: "t-rook" };
  if (r >= 1100) return { sym: "♗", name: T("tier_bishop"), cls: "t-bishop" };
  if (r >= 700) return { sym: "♘", name: T("tier_knight"), cls: "t-knight" };
  return { sym: "♙", name: T("tier_pawn"), cls: "t-pawn" };
}
// HTML: colored tier symbol + number (e.g. for chips/badges/leaderboard)
function ratingHTML(r) {
  const t = ratingTier(r);
  return `<span class="tier ${t.cls}" title="${t.name}">${t.sym}</span>${r}`;
}
// plain text: symbol + number (for textContent contexts)
function ratingText(r) { return `${ratingTier(r).sym} ${r}`; }

function updateRatingChip() {
  const el = $("ratingChip");
  const loggedIn = !!(typeof AUTH !== "undefined" && AUTH && AUTH.token);
  if (el) {
    el.classList.toggle("hidden", !loggedIn);   // no rating shown when logged out
    if (loggedIn) el.innerHTML = `${t("word_rating")} <b>${ratingHTML(myRating())}</b>`;
  }
  const og = $("ogRating"); if (og && loggedIn) og.innerHTML = ratingHTML(myRating());
  if (typeof refreshDashboard === "function") refreshDashboard();
}

function gameHistory() {
  try { return JSON.parse(localStorage.getItem("cc_history") || "[]"); }
  catch (e) { return []; }
}
function addHistory(entry) {
  const h = gameHistory();
  h.unshift({ ...entry, date: new Date().toISOString().slice(0, 10) });
  localStorage.setItem("cc_history", JSON.stringify(h.slice(0, 50)));
  // update best win-streak record (current streak = leading wins in history)
  const cur = winStreak();
  if (cur > bestStreak()) localStorage.setItem("cc_streak_best", String(cur));
  renderHistory();
  authSchedulePush();
  if (typeof checkAchievements === "function") checkAchievements();
}
// consecutive wins ending at the most recent game (AI + online both count)
function winStreak() {
  let n = 0;
  for (const g of gameHistory()) { if (g.result === "win") n++; else break; }
  return n;
}
function bestStreak() { return +(localStorage.getItem("cc_streak_best") || 0); }
// " · 🔥 N연승" suffix for the result screen (only when it's a real streak ≥2)
function streakSuffix() {
  const n = winStreak();
  if (n < 2) return "";
  const T = (typeof t === "function") ? t : ((k) => k);
  return " · " + T("streak_win").replace("{n}", n);
}
function renderHistory() {
  const el = $("ogHistory"); if (!el) return;
  const h = gameHistory();
  if (!h.length) { el.innerHTML = `<div class="hist-empty">${t("hist_empty")}</div>`; return; }
  el.innerHTML = h.slice(0, 12).map((g) => {
    const res = g.result === "win" ? `<b class="w">${t("res_short_win")}</b>` : g.result === "loss" ? `<b class="l">${t("res_short_loss")}</b>` : `<b class="d">${t("res_short_draw")}</b>`;
    const delta = (g.ratingDelta === null || g.ratingDelta === undefined) ? '<span class="dim">—</span>'
      : (g.ratingDelta >= 0 ? `<span class="up">+${g.ratingDelta}</span>` : `<span class="down">${g.ratingDelta}</span>`);
    const mode = g.mode === "online" ? "🌐" : "🤖";
    return `<div class="hist-row"><span class="dim">${(g.date || "").slice(5)}</span>` +
      `<span>${mode} ${escapeHtml(g.opponent || "")}</span>${res}${delta}</div>`;
  }).join("");
}

// =========================================================================== //
// ANALYZE -> REVIEW
// =========================================================================== //
let LAST_REQ = null;

// the most recent finished game that can be replayed/reviewed
function lastPlayedGame() {
  return gameHistory().find((g) => g && Array.isArray(g.moves) && g.moves.length >= 2);
}
// opening the Review tab with nothing loaded auto-shows your latest game
function maybeLoadLastReview() {
  if (RV.view) return;
  const g = lastPlayedGame();
  if (!g) return;
  runAnalyze({ moves: g.moves, white: g.white || "White", black: g.black || "Black", movetime: REVIEW_MT });
}

// Review speed: analysis is PREFETCHED the moment a game ends and cached, so by
// the time the player opens the review it's usually already done. Keyed by the
// exact request so the button and the prefetch share one in-flight call.
const REVIEW_MT = 180;         // per-position engine budget (ms). The SERVER's native
                               // Stockfish is used for review (far stronger per ms than
                               // the client asm.js build, which searched too shallow and
                               // produced wrong move evaluations). Prefetch at game end
                               // hides most of the wait.
// The client-side asm.js engine proved far too weak for evaluation (shallow
// depth → bad best-moves/classifications), so review, hints and AI moves now
// run on the server's native engine. The client engine stays wired but disabled;
// flip this to true only with a genuinely fast (WASM) engine.
const USE_CLIENT_ENGINE = false;
const ANALYZE_CACHE = {};
const EVALS_CACHE = {};            // movesKey -> per-position evals (reused for the coach re-request)
const CLIENT_REVIEW_MT = 300;      // client per-position budget (asm.js on the user's CPU)
let _analyzeOnProg = null;         // set while the user is actively waiting, so prefetch stays silent
function _ckey(req) { return (req.moves || []).join("") + "|" + (req.movetime || "") + "|" + (req.white || "") + "/" + (req.black || ""); }

// Client-assisted analysis: the browser's Stockfish evaluates each position; the
// server turns those evals into the same review /api/analyze produces. Any
// failure (no engine, network) falls back to the fully server-side analysis.
async function analyzeClient(req, coach) {
  try {
    const key = (req.moves || []).join("");
    let evals = EVALS_CACHE[key];
    if (!evals) {
      if (window.SF && SF.newGame) SF.newGame();
      const pos = await api("/api/positions", { moves: req.moves });
      const fens = pos.fens || [], skip = pos.skip || 0;
      evals = new Array(fens.length).fill(null);
      const total = Math.max(1, fens.length - skip);
      let done = 0;
      for (let i = skip; i < fens.length; i++) {
        const r = await SF.bestMove(fens[i], { movetime: CLIENT_REVIEW_MT });
        evals[i] = { cp: r.cp, mate: r.mate, bestUci: r.bestmove, pv: (r.pv || []).slice(0, 12) };
        done++;
        if (_analyzeOnProg) _analyzeOnProg(done, total);
      }
      EVALS_CACHE[key] = evals;
    }
    const lang = (typeof CC_LANG !== "undefined") ? CC_LANG : "ko";
    return await api("/api/analyze_client", { moves: req.moves, white: req.white, black: req.black,
      evals, movetime: CLIENT_REVIEW_MT, coach: !!coach, lang });
  } catch (e) {
    const lang = (typeof CC_LANG !== "undefined") ? CC_LANG : "ko";
    return api("/api/analyze", coach ? { ...req, coach: true, lang } : req);   // graceful server fallback
  }
}

function prefetchAnalyze(req) {
  const k = _ckey(req);
  if (!ANALYZE_CACHE[k]) {
    const p = (USE_CLIENT_ENGINE && window.SF && SF.available) ? analyzeClient(req, false) : api("/api/analyze", req);
    ANALYZE_CACHE[k] = p.catch((e) => { delete ANALYZE_CACHE[k]; throw e; });
  }
  return ANALYZE_CACHE[k];
}
async function runAnalyze(req, statusId = "aiStatus") {
  LAST_REQ = req;
  overlay(true, t("analyze_running"));
  // show live per-position progress while the user waits (silent during prefetch)
  _analyzeOnProg = (n, m) => overlay(true, t("analyze_client_prog").replace("{n}", n).replace("{m}", m));
  try {
    const view = await prefetchAnalyze(req);   // reuse the in-flight/finished prefetch
    loadReview(view);
    if (typeof questBump === "function") questBump("reviews");   // daily quest progress
    if (typeof metric === "function") metric("review_done", { once: true });   // ADD10 funnel
    switchTab("review");
  } catch (e) {
    _analyzeOnProg = null;
    overlay(false);
    setStatus(statusId, isOffline(e) ? t("offline_msg") : t("analyze_fail") + e.message, true);
    return;
  }
  _analyzeOnProg = null;
  overlay(false);
}

const RV = { view: null, idx: 0, N: 0 };

function clsColor(c) {
  return ({ Brilliant: "#1aa7a0", Great: "#3f7fd6", Best: "#2e7d32", Excellent: "#2e7d32", Good: "#9e9e9e",
    Inaccuracy: "#c9a227", Mistake: "#e07a1f", Blunder: "#c62828" })[c] || "#ddd";
}
function clsLabel(c) {
  return ({ Brilliant: t("cls_brilliant"), Great: t("cls_great"), Best: t("cls_best"), Excellent: t("cls_excellent"),
    Good: t("cls_good"), Inaccuracy: t("cls_inaccuracy"), Mistake: t("cls_mistake"), Blunder: t("cls_blunder") })[c] || c;
}

function loadReview(view) {
  RV.view = view; RV.N = view.svgs.length - 1; RV.idx = 0;
  $("rvEmpty").classList.add("hidden");      // hide the "analyze first" prompt
  $("rvContent").classList.remove("hidden"); // reveal the review

  $("rvSummary").innerHTML =
    `<b>${view.title}</b> &nbsp; <span style="color:#9aa0a6">${view.opening || ""}</span><br>` +
    t("rv_accuracy_label") +
    `<b>${t("side_white")} ${view.white.accuracy.toFixed(1)}%</b> &nbsp;·&nbsp; <b>${t("side_black")} ${view.black.accuracy.toFixed(1)}%</b>`;

  // ADD3 + ADD6: turn this game's mistakes into active practice.
  const nMiss = (typeof rvHumanMistakes === "function") ? rvHumanMistakes().length : 0;
  const acts = $("rvActions");
  if (acts) {
    acts.hidden = false;
    let html = "";
    if (nMiss > 0) {
      html += `<button class="rv-act" id="rvQuizBtn">🎯 ${t("qz_start_btn")}</button>` +
        `<button class="rv-act" id="rvRxBtn">🩺 ${t("rx_start_btn")}</button>`;
    }
    html += `<button class="rv-act" id="rvOpenBtn">♟️ ${t("op_btn")}</button>`;
    if (nMiss > 0) html += `<span class="rv-act-note">${t("rv_acts_note").replace("{n}", nMiss)}</span>`;
    acts.innerHTML = html;
    const q = $("rvQuizBtn"), r = $("rvRxBtn"), o = $("rvOpenBtn");
    if (q) q.onclick = () => startActiveReview();
    if (r) r.onclick = () => startPrescription();
    if (o) o.onclick = () => renderOpeningReport();
  }
  const opDiv = document.getElementById("rvOpening"); if (opDiv) { opDiv.hidden = true; opDiv.innerHTML = ""; }

  // movelist
  let html = "";
  view.moves.forEach((m) => {
    if (m.color === "white") html += `<span class="num">${m.moveNumber}.</span>`;
    html += `<span class="mv" data-idx="${m.ply}" style="color:${m.clsColor}" ` +
      `title="${clsLabel(m.classification)} — ${(m.explain || "").replace(/"/g, "'")}">` +
      `${m.san}${m.symbol}</span> `;
  });
  $("rvMoves").innerHTML = html;
  $("rvMoves").querySelectorAll(".mv").forEach((el) =>
    el.onclick = () => rvGo(+el.dataset.idx));

  renderCoach(view.coach);
  rvRender();
}

// Build a short, plain-language coach line for one move from the engine's own
// classification — instant, no LLM, correct in every language.
function moveCoachText(m) {
  const key = ({
    Brilliant: "move_cmt_brilliant", Great: "move_cmt_great", Best: "move_cmt_best",
    Excellent: "move_cmt_excellent", Good: "move_cmt_good",
    Inaccuracy: "move_cmt_inaccuracy", Mistake: "move_cmt_mistake", Blunder: "move_cmt_blunder",
  })[m.classification] || (m.isBest ? "move_cmt_best" : "move_cmt_good");
  let s = t(key).replace("{mv}", m.san + (m.symbol || ""));
  const weak = (m.classification === "Inaccuracy" || m.classification === "Mistake" || m.classification === "Blunder");
  const strong = !weak && (m.classification === "Brilliant" || m.classification === "Great" || m.classification === "Best" || m.isBest);
  // Korean object particle (을/를) depends on the piece's final sound
  const KO_OBJ = { pawn: "을", knight: "를", bishop: "을", rook: "을", queen: "을", king: "을" };
  const koUI2 = (typeof CC_LANG === "undefined" || CC_LANG === "ko");
  const pieceName = (code) => {
    const nm = t("piece_" + (code || "pawn"));
    return (koUI2 && code) ? nm + (KO_OBJ[code] || "을") : nm;
  };
  // ---- causal WHY (localized; the rich Korean `explain` is shown separately to ko users) ----
  if (m.isMate) {
    // checkmate — the classification comment already says it
  } else if (weak) {
    if (m.replyCapType && m.replySan) {
      s += " " + t("why_hangs").replace("{mv}", m.replySan).replace("{piece}", pieceName(m.replyCapType));
    } else {
      const pts = Math.round((m.cpl || 0) / 100);
      if (pts >= 1) s += " " + t("why_loss").replace("{n}", pts);
    }
    if (m.best) s += " " + (m.bestIsCapture ? t("why_better_cap") : t("move_cmt_better")).replace("{best}", m.best);
    if (m.missedWin) s += " " + t("rv_missed_win");
  } else if (strong) {
    let why = "";
    if (m.onlyMove) why = t("why_only");
    else if (m.capturedType) why = t("why_capture").replace("{piece}", pieceName(m.capturedType));
    else if (m.isCastle) why = t("why_castle");
    else if (m.givesCheck) why = t("why_check");
    else if (m.develops) why = t("why_develop").replace("{piece}", pieceName(m.movedType));
    if (why) s += " " + why;
  }
  return s;
}
function coachVoiceOn() { return localStorage.getItem("cc_coach_voice") !== "0"; }

function rvDetail() {
  coachStopSpeak();
  if (RV.idx === 0) {
    $("rvDetail").innerHTML = `<div class="r">${t("rv_start_pos")}</div>`;
    return;
  }
  const m = RV.view.moves[RV.idx - 1];
  const turn = m.color === "white" ? t("side_white") : t("side_black");
  // Brilliant/Great take priority over the plain "Best" tag even when the move
  // is also the engine's top choice.
  const special = m.classification === "Brilliant" || m.classification === "Great";
  const tag = special
    ? `<span class="tag" style="background:${clsColor(m.classification)};color:#fff">${clsLabel(m.classification)} ${m.symbol}</span>`
    : m.isBest
      ? `<span class="tag" style="background:#2e7d32;color:#fff">${t("cls_best")}</span>`
      : `<span class="tag" style="background:${m.clsColor}">${clsLabel(m.classification)} ${m.symbol}</span>`;
  const missed = m.missedWin ? ` <b style="color:#c62828">${t("rv_missed_win")}</b>` : "";
  // the rich rule-based `explain` text is Korean-only; show it only to ko users.
  // Other languages get the localized causal "why" inside moveCoachText instead.
  const koUI = (typeof CC_LANG === "undefined" || CC_LANG === "ko");
  const explain = (m.explain && koUI)
    ? `<div class="aiexplain">🤖 ${escapeHtml(m.explain)}</div>` : "";
  const pv = (m.pv || []).slice(0, 8).join(" ");
  const pvRow = pv ? `<div class="r">${t("rv_pv_label")}<span class="pv">${pv}</span></div>` : "";
  // automatic per-move coach (avatar + spoken comment)
  const cmt = moveCoachText(m);
  const vOn = coachVoiceOn();
  const coachMini =
    `<div class="coach-card coach-mini">` +
      `<div class="coach-av" id="coachAvatar">🧑‍🏫</div>` +
      `<div class="coach-body"><div class="coach-head"><b>${t("coach_title")}</b>` +
        `<button class="ghost coach-speak" id="coachVoiceToggle">${vOn ? t("coach_voice_on") : t("coach_voice_off")}</button></div>` +
        `<div class="coach-text">${escapeHtml(cmt)}</div></div>` +
    `</div>`;
  // FIX8: if this weak move maps to a trainable theme, offer a one-tap drill.
  const tc = (typeof moveThemeCat === "function") ? moveThemeCat(m) : null;
  const themeChip = tc
    ? `<div class="rv-theme"><span class="rv-theme-tag">${t("rv_theme_label").replace("{theme}", t("pztheme_" + tc.theme))}</span>` +
      `<button class="rv-theme-cta" data-cat="${tc.cat}">${t("rv_theme_practice")}</button></div>`
    : "";
  $("rvDetail").innerHTML =
    coachMini +
    `<div><b style="font-size:16px">${m.moveNumber}${m.color === "white" ? "." : "..."} ${turn} ${m.san}${m.symbol}</b> &nbsp; ${tag}${missed}</div>` +
    explain +
    themeChip +
    pvRow;
  const tcBtn = $("rvDetail").querySelector(".rv-theme-cta");
  if (tcBtn) tcBtn.onclick = () => practiceThemeBand(+tcBtn.dataset.cat);
  $("coachVoiceToggle").onclick = () => {
    const on = coachVoiceOn();
    localStorage.setItem("cc_coach_voice", on ? "0" : "1");
    if (on) coachStopSpeak();
    $("coachVoiceToggle").textContent = on ? t("coach_voice_off") : t("coach_voice_on");
    if (!on) coachSpeak(cmt);
  };
  if (vOn) coachSpeak(cmt);   // speak this move's comment automatically
}

function rvGraph() {
  const g = $("rvGraph");
  const w = g.clientWidth || 480, h = 90;
  g.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const ww = RV.view.whiteWin;
  const xs = (i) => (RV.N === 0 ? 0 : (i / RV.N) * w);
  const ys = (v) => h - (v / 100) * h;
  const pts = ww.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const cx = xs(RV.idx);
  g.innerHTML =
    `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="#555" stroke-dasharray="3 3"/>` +
    `<polygon points="${area}" fill="#3b82f622"/>` +
    `<polyline points="${pts}" fill="none" stroke="#9ecbff" stroke-width="1.5"/>` +
    `<line x1="${cx}" y1="0" x2="${cx}" y2="${h}" stroke="#fff" stroke-width="1.5"/>`;
}

function rvRender() {
  $("rvBoard").innerHTML = RV.view.svgs[RV.idx];
  $("rvBar").style.height = RV.view.whiteWin[RV.idx] + "%";
  $("rvBarLbl").textContent = RV.view.evalLabels[RV.idx];
  $("rvSlider").max = RV.N; $("rvSlider").value = RV.idx;
  document.querySelectorAll("#rvMoves .mv").forEach((el) =>
    el.classList.toggle("active", +el.dataset.idx === RV.idx));
  scrollListToActive($("rvMoves"));
  rvDetail(); rvGraph();
}
function rvGo(i) { RV.idx = Math.max(0, Math.min(RV.N, i)); rvRender(); }

$("rvFirst").onclick = () => rvGo(0);
$("rvPrev").onclick = () => rvGo(RV.idx - 1);
$("rvNext").onclick = () => rvGo(RV.idx + 1);
$("rvLast").onclick = () => rvGo(RV.N);
$("rvSlider").oninput = (e) => rvGo(+e.target.value);
$("rvGraph").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  rvGo(Math.round(((e.clientX - r.left) / r.width) * RV.N));
});
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("tab-review").classList.contains("active")) return;
  if (e.key === "ArrowLeft") { rvGo(RV.idx - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { rvGo(RV.idx + 1); e.preventDefault(); }
  if (e.key === "Home") rvGo(0);
  if (e.key === "End") rvGo(RV.N);
});
window.addEventListener("resize", () => { if (RV.view) rvGraph(); });

// =========================================================================== //
// REVIEW → LEARNING: theme classifier (FIX8), prescription drills (ADD6),
// active "guess the move" review (ADD3). All reuse the puzzle board + engine.
// =========================================================================== //
const REVIEW_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// FIX8: classify what a weak move got wrong into a trainable theme, from the
// engine's own move fields (client-side heuristic). Returns {cat, theme} | null.
function moveThemeCat(m) {
  if (!m) return null;
  const weak = (m.classification === "Blunder" || m.classification === "Mistake" || m.classification === "Inaccuracy");
  if (!weak && !m.missedWin) return null;
  // hung a real piece: the opponent's best reply just wins material
  if (m.replyCapType && m.replyCapType !== "pawn") return { cat: THEME_CAT.hanging, theme: "hanging" };
  // missed a winning shot / a better capture → a tactic; without a richer motif
  // signal, route to fork drills (the most common decisive beginner tactic).
  if (m.missedWin || m.bestIsCapture) return { cat: THEME_CAT.fork, theme: "fork" };
  if (m.replyCapType === "pawn") return { cat: THEME_CAT.hanging, theme: "hanging" };
  return null;
}
// which colour did the human play? request carries it; else the side with more
// (blunders+mistakes) is the human (the AI/opponent plays cleaner on average).
function rvHumanColor() {
  const h = LAST_REQ && LAST_REQ.human;
  if (h === "w" || h === "white") return "white";
  if (h === "b" || h === "black") return "black";
  if (!RV.view) return "white";
  let w = 0, b = 0;
  RV.view.moves.forEach((m) => {
    if (m.classification === "Blunder" || m.classification === "Mistake") { if (m.color === "white") w++; else b++; }
  });
  return b >= w ? "black" : "white";
}
function rvHumanMistakes() {
  if (!RV.view) return [];
  const hc = rvHumanColor();
  return RV.view.moves
    .filter((m) => m.color === hc && (m.classification === "Blunder" || m.classification === "Mistake"))
    .sort((a, b) => (b.cpl || 0) - (a.cpl || 0));
}

// pick the band-closest puzzle within a single theme (used by prescription + the
// per-move "practice this" chip).
function pickThemePuzzle(cat) {
  const my = (typeof pzRatingGet === "function") ? pzRatingGet() : 800;
  const { start, count } = pzCatRange(cat);
  const pool = [];
  for (let i = start; i < start + count; i++) {
    const p = PZ.list[i]; if (!p) continue;
    pool.push({ i, r: (typeof p.rating === "number" ? p.rating : my), solved: PZ.solved.has(p.level) });
  }
  const uns = pool.filter((x) => !x.solved);
  const use = uns.length ? uns : pool;
  use.sort((a, b) => Math.abs(a.r - my) - Math.abs(b.r - my));
  return use.length ? use[0].i : start;
}
function practiceThemeBand(cat) { PZ.cat = cat; switchTab("puzzle"); loadPuzzle(pickThemePuzzle(cat), { force: true }); }

// ---- ADD6: per-game prescription — 3 puzzles targeting this game's mistakes ----
const RX = { queue: [], i: 0 };
function startPrescription() {
  if (typeof metric === "function") metric("prescription");
  const mistakes = rvHumanMistakes();
  const cats = [], seen = new Set();
  for (const m of mistakes) {
    const tc = moveThemeCat(m); if (!tc) continue;
    if (seen.has(tc.cat)) continue; seen.add(tc.cat); cats.push(tc.cat);
    if (cats.length >= 3) break;
  }
  const q = cats.map((c) => pickThemePuzzle(c));
  while (q.length < 3) { const a = pickAdaptivePuzzle(); if (!q.includes(a)) q.push(a); else break; }
  RX.queue = [...new Set(q)]; RX.i = 0;
  if (!RX.queue.length) { if (typeof shareFlash === "function") shareFlash(t("rx_none")); return; }
  if (!PZ.baseFen) PZ.baseFen = REVIEW_START_FEN;   // suppress the tab's deferred boot-load
  switchTab("puzzle");
  PZ.rxActive = true;
  loadPuzzle(RX.queue[0], { force: true, rx: true });
  if (typeof shareFlash === "function") shareFlash(t("rx_started").replace("{n}", RX.queue.length));
}
function rxAdvance() {
  RX.i++;
  if (RX.i < RX.queue.length) {
    showResult({ kind: "win", icon: "🩺", title: t("rx_next_title"),
      sub: t("rx_progress").replace("{i}", RX.i).replace("{n}", RX.queue.length),
      actions: [{ label: t("rx_next_btn"), primary: true, onClick: () => loadPuzzle(RX.queue[RX.i], { force: true, rx: true }) }] });
  } else {
    PZ.rxActive = false;
    showResult({ kind: "win", icon: "✅", title: t("rx_done_title"), sub: t("rx_done_sub"),
      actions: [
        { label: t("rx_back_review"), primary: true, onClick: () => { hideResult(); switchTab("review"); } },
        { label: t("pz_theme_list_btn"), onClick: () => { hideResult(); renderPzGrid(); } },
      ] });
  }
}

// ---- ADD3: active "guess the move" review — replay your mistake positions and
// try to FIND the best move yourself, checked live by the engine. ----
const QZ = { items: [], i: 0 };
async function startActiveReview() {
  if (typeof metric === "function") metric("active_review");
  const mistakes = rvHumanMistakes().filter((m) => m.best).slice(0, 5);
  if (!mistakes.length) { if (typeof shareFlash === "function") shareFlash(t("qz_none")); return; }
  const all = (LAST_REQ && LAST_REQ.moves) || [];
  QZ.items = mistakes.map((m) => ({ ply: m.ply, before: all.slice(0, m.ply - 1), bestSan: m.best, playedSan: m.san }));
  QZ.i = 0;
  if (!PZ.baseFen) PZ.baseFen = REVIEW_START_FEN;   // suppress the tab's deferred boot-load
  switchTab("puzzle");
  await loadQuizItem();
}
async function loadQuizItem() {
  const it = QZ.items[QZ.i]; if (!it) return;
  if (typeof overlay === "function") overlay(true, t("qz_loading"));
  let st;
  try { st = await api("/api/eval_fen", { fen: REVIEW_START_FEN, moves: it.before, movetime: 220 }); }
  catch (e) { if (typeof overlay === "function") overlay(false); if (typeof shareFlash === "function") shareFlash(t("qz_none")); return; }
  if (typeof overlay === "function") overlay(false);
  if (!st.bestUci) { QZ.i++; if (QZ.i < QZ.items.length) return loadQuizItem(); return qzFinish(); }
  const adhoc = { fen: st.fen, solution: [st.bestUci], solutionSan: [it.bestSan], mateIn: 0,
    theme: "tactic", level: -1, rating: null };
  loadPuzzle(-1, { force: true, adhoc, quiz: true });
  $("pzPrompt").innerHTML = t("qz_prompt").replace("{i}", QZ.i + 1).replace("{n}", QZ.items.length);
  setStatus("pzFeedback", t("qz_hint_played").replace("{mv}", it.playedSan), false);
}
function qzSolved() {
  QZ.i++;
  if (QZ.i < QZ.items.length) {
    showResult({ kind: "win", icon: "🎯", title: t("qz_correct_title"),
      sub: t("qz_progress").replace("{i}", QZ.i).replace("{n}", QZ.items.length),
      actions: [{ label: t("qz_next_btn"), primary: true, onClick: () => { hideResult(); loadQuizItem(); } }] });
  } else { qzFinish(); }
}
function qzFinish() {
  showResult({ kind: "win", icon: "🏆", title: t("qz_done_title"), sub: t("qz_done_sub"),
    actions: [
      { label: t("rx_back_review"), primary: true, onClick: () => { hideResult(); switchTab("review"); } },
      { label: t("pz_theme_list_btn"), onClick: () => { hideResult(); renderPzGrid(); } },
    ] });
}

// ---- coach ----
// ---- coach voice (Web Speech API — free, on-device, follows app language) ----
const TTS_LANG = { ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN", es: "es-ES" };
function coachStopSpeak() {
  try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
  const av = document.getElementById("coachAvatar"); if (av) av.classList.remove("speaking");
  const b = document.getElementById("coachSpeakBtn"); if (b) b.textContent = t("coach_speak");
}
function coachSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  // strip markdown so it reads naturally
  const clean = String(text).replace(/[#*`_>]/g, "").replace(/\n{2,}/g, ". ").replace(/\s+/g, " ").trim();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = TTS_LANG[(typeof CC_LANG !== "undefined") ? CC_LANG : "ko"] || "ko-KR";
  u.rate = 1.02;
  const av = document.getElementById("coachAvatar");
  const b = document.getElementById("coachSpeakBtn");
  u.onstart = () => { if (av) av.classList.add("speaking"); if (b) b.textContent = t("coach_stop"); };
  u.onend = () => { if (av) av.classList.remove("speaking"); if (b) b.textContent = t("coach_speak"); };
  u.onerror = u.onend;
  window.speechSynthesis.speak(u);
}
function coachToggleSpeak(text) {
  if ("speechSynthesis" in window && window.speechSynthesis.speaking) coachStopSpeak();
  else coachSpeak(text);
}

function renderCoach(coach) {
  const el = $("rvCoach");
  coachStopSpeak();
  if (!coach) { el.textContent = ""; return; }
  if (coach.available && coach.text) {
    const canTTS = ("speechSynthesis" in window);
    el.innerHTML =
      `<div class="coach-card">` +
        `<div class="coach-av" id="coachAvatar">🧑‍🏫</div>` +
        `<div class="coach-body">` +
          `<div class="coach-head"><b>${t("coach_title")}</b>` +
            (canTTS ? `<button class="ghost coach-speak" id="coachSpeakBtn">${t("coach_speak")}</button>` : "") +
          `</div>` +
          `<div class="coach-text" style="white-space:pre-wrap; font-size:14px; line-height:1.6">${escapeHtml(coach.text)}</div>` +
        `</div>` +
      `</div>`;
    if (canTTS) {
      $("coachSpeakBtn").onclick = () => coachToggleSpeak(coach.text);
      coachSpeak(coach.text);   // auto-read once when the report appears
    }
  } else if (coach.available) {
    el.innerHTML = `<div style="color:#9aa0a6; font-size:14px">${t("coach_prompt")}</div>` +
      `<button class="ghost" id="coachBtn" style="margin-top:8px">${t("coach_btn")}</button>`;
    $("coachBtn").onclick = genCoach;
  } else {
    el.innerHTML = `<div style="color:#9aa0a6; font-size:14px">${escapeHtml(coach.message || t("coach_disabled"))}</div>`;
  }
}
async function genCoach() {
  if (!LAST_REQ) return;
  overlay(true, t("coach_running"));
  try {
    const lang = (typeof CC_LANG !== "undefined") ? CC_LANG : "ko";
    const view = (USE_CLIENT_ENGINE && window.SF && SF.available)
      ? await analyzeClient(LAST_REQ, true)
      : await api("/api/analyze", { ...LAST_REQ, coach: true, lang });
    RV.view.coach = view.coach;
    renderCoach(view.coach);
  } catch (e) { renderCoach({ available: false, message: t("coach_err") + e.message }); }
  overlay(false);
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---- review players / title / shapes for export ----
function reviewMeta() {
  const v = RV.view;
  const [white, black] = (v.title || "White vs Black").split(" vs ");
  return { v, white: white || "White", black: black || "Black" };
}

// AI explanations keyed by position index (ply). Each move's explanation describes
// the move that REACHED that position, so it attaches to index = ply.
function aiCommentsByIndex() {
  const c = {};
  RV.view.moves.forEach((m) => { if (m.explain) c[String(m.ply)] = m.explain; });
  return c;
}

// ---- export annotated PGN (with AI explanations) ----
$("rvExport").onclick = () => {
  const { v, white, black } = reviewMeta();
  let txt = `[Event "Matevio"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${v.result}"]\n\n`;
  let body = "";
  v.moves.forEach((m) => {
    if (m.color === "white") body += `${m.moveNumber}. `;
    body += `${m.san}${m.symbol} `;
    if (m.explain) body += `{ ${m.explain} } `;
  });
  txt += body + v.result + "\n";
  download("annotated.pgn", txt, "application/x-chess-pgn");
  setStatus("rvShareStatus", t("rv_pgn_saved"));
};

// ---- share: standalone HTML study with AI explanations + arrows ----
$("rvShare").onclick = async () => {
  const { v, white, black } = reviewMeta();
  setStatus("rvShareStatus", t("rv_share_gen"));
  try {
    const res = await fetch("/api/study_html", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moves: v.moves.map((m) => m.uci),
        comments: aiCommentsByIndex(),
        shapes: {},
        white, black, title: v.title || t("rv_study_title"),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const html = await res.text();
    const name = (v.title || "study").replace(/[^\w가-힣 -]/g, "").trim() + ".html";
    download(name || "study.html", html, "text/html");
    setStatus("rvShareStatus", t("rv_share_done"));
  } catch (e) { setStatus("rvShareStatus", t("rv_share_fail") + e.message, true); }
};

// =========================================================================== //
// PLAY vs AI (levels 1-10) -> auto-evaluate when the game ends
// =========================================================================== //
const AIG = { moves: [], state: null, sel: null, orient: "w", level: 3, human: "w", over: false, thinking: false, started: false, style: "default", variant: false, startFen: null, hint: null, viewState: null, viewLast: null, viewIdx: null };

// Progress: the highest level beaten (persisted in localStorage). Shown as a
// plain level number — no titles.
function bestLevel() { return +(localStorage.getItem("cc_best_level") || 0); }
function setBestLevel(n) { localStorage.setItem("cc_best_level", String(n)); authSchedulePush(); }
function updateRankBadge() {
  const b = bestLevel(), el = $("aiRank");
  if (!el) return;
  const rb = (typeof t === "function") ? t("rank_best") : "내 최고 기록";
  if (b > 0) { el.textContent = `${rb}: ${aiLevelText(b)}`; el.classList.toggle("master", b >= 10); }
  else { el.textContent = (typeof t === "function") ? t("rank_none") : "아직 클리어한 레벨이 없습니다"; el.classList.remove("master"); }
}

// ---- big win/loss/draw result screen ----
function showResult(o) {
  const box = $("resultBox");
  box.className = "result-box " + o.kind;
  $("resultIcon").textContent = o.icon;
  $("resultTitle").textContent = o.title;
  $("resultSub").textContent = o.sub || "";
  const badge = $("resultBadge");
  if (o.badge) {
    badge.classList.remove("hidden");
    badge.classList.toggle("master", !!o.badge.master);
    badge.innerHTML = `<span class="small">${o.badge.small || t("badge_newrecord")}</span>${o.badge.text}`;
  } else { badge.classList.add("hidden"); }
  const act = $("resultActions"); act.innerHTML = "";
  (o.actions || []).forEach((a) => {
    const btn = document.createElement("button");
    btn.className = a.primary ? "primary" : "ghost";
    btn.textContent = a.label;
    btn.onclick = () => { hideResult(); if (a.onClick) a.onClick(); };
    act.appendChild(btn);
  });
  if (o.kind === "win") SFX.win(); else if (o.kind === "loss") SFX.lose();
  const conf = $("confetti"); conf.innerHTML = "";
  const reduceMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (o.kind === "win" && !reduceMotion) {
    // brand palette: green + gold + white (was a random 6-colour rainbow)
    const colors = ["#4fb877", "#e9b23a", "#ffffff", "#3fa268", "#f5c451"];
    for (let i = 0; i < 44; i++) {
      const p = document.createElement("i");
      p.style.left = Math.round(Math.random() * 100) + "%";
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (1.4 + Math.random() * 1.5) + "s";
      p.style.animationDelay = (Math.random() * 0.5) + "s";
      conf.appendChild(p);
    }
  }
  $("resultOverlay").classList.remove("hidden");
}
function hideResult() { $("resultOverlay").classList.add("hidden"); }
(function () { const c = $("resultClose"); if (c) c.onclick = hideResult; })();

// The result window floats over the game screen without blocking it and can be
// closed with its × — so the player can study the final position / last move.
function presentResult(opts) { setTimeout(() => showResult(opts), 420); }

function renderAiBoard() {
  const board = $("aiBoard"); board.innerHTML = "";
  const viewing = !!AIG.viewState;                 // browsing an earlier position?
  const st = viewing ? AIG.viewState : AIG.state; if (!st) return;
  const map = parseFen(st.fen);
  const files = AIG.orient === "w" ? [..."abcdefgh"] : [..."hgfedcba"];
  const ranks = AIG.orient === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const lastUci = viewing ? AIG.viewLast : (AIG.moves.length ? AIG.moves[AIG.moves.length - 1] : null);
  const lf = lastUci ? lastUci.slice(0, 2) : null, lt = lastUci ? lastUci.slice(2, 4) : null;
  const kingChar = st.turn === "w" ? "K" : "k";
  let kingSq = null;
  for (const s in map) if (map[s] === kingChar) kingSq = s;
  const canMove = !viewing && !AIG.over && !AIG.thinking && st.turn === AIG.human;
  const legal = canMove ? (st.legal || {}) : {};
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      if (sq === lf || sq === lt) div.classList.add("last");
      if (!viewing && AIG.hint && (sq === AIG.hint.from || sq === AIG.hint.to)) div.classList.add("hintsq");
      if (!viewing && AIG.sel === sq) div.classList.add("sel");
      if (st.check && sq === kingSq) div.classList.add("check");
      const p = map[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      if (SETTINGS.showDots && AIG.sel && legal[AIG.sel] && legal[AIG.sel].includes(sq)) {
        const d = document.createElement("div"); d.className = "dot" + (map[sq] ? " cap" : "");
        div.appendChild(d);
      }
      addCoords(div, f, rank, files, ranks);
      div.dataset.sq = sq;
      div.onclick = () => onAiClick(sq);
      board.appendChild(div);
    }
  }
}

function onAiClick(sq) {
  if (_dragJustMoved) return;
  if (AIG.viewState) { aiViewLive(); return; }       // browsing history → snap back to live, ignore the click
  const st = AIG.state;
  if (!AIG.started || AIG.over || AIG.thinking || !st || st.turn !== AIG.human) return;
  const map = parseFen(st.fen), legal = st.legal || {};
  if (AIG.sel) {
    if (legal[AIG.sel] && legal[AIG.sel].includes(sq)) {
      const from = AIG.sel, piece = map[from], r = +sq[1];
      AIG.sel = null;
      if (piece && piece.toLowerCase() === "p" && (r === 8 || r === 1)) {
        promoChooser($("aiBoard"), piece === "P", (pp) => aiHumanMove(from + sq + pp));
      } else {
        aiHumanMove(from + sq);
      }
      return;
    }
    if (legal[sq]) { AIG.sel = sq; renderAiBoard(); return; }
    AIG.sel = null; renderAiBoard(); return;
  }
  if (legal[sq]) { AIG.sel = sq; renderAiBoard(); }
}

// ---- AI opponent identity for the player bar (name + rating) ----
const AI_STYLE_LABEL = { tal: "name_tal", fischer: "name_fischer", carlsen: "name_carlsen", petrosian: "name_petrosian" };
// 10-level ladder: title (호칭) per level + a friendly display rating that
// shows the widening gap. Titles are translated via i18n (lvl_1..lvl_10).
const AI_LEVEL_RATING = [0, 200, 400, 600, 800, 1100, 1400, 1700, 2000, 2300, 2850];
// each AI opponent gets a face — friendlier at low levels, fiercer at the top
// one cohesive family — facial expressions growing from friendly → fierce,
// with a crown for the top level (was a mismatched chick/ninja/robot/crown mix).
const AI_FACE = { 1: "😀", 2: "🙂", 3: "😊", 4: "🤔", 5: "😎", 6: "🧐", 7: "😏", 8: "😤", 9: "😈", 10: "👑" };
const AI_STYLE_FACE = { tal: "⚔️", fischer: "🎯", carlsen: "♟️", petrosian: "🛡️" };
function aiFace(n) { return AI_FACE[Math.max(1, Math.min(10, +n || 1))] || "🤖"; }
function aiOppFace() {
  if (AIG.style && AIG.style !== "default") return AI_STYLE_FACE[AIG.style] || "🤖";
  return aiFace(AIG.level);
}
function aiTitle(n) { n = Math.max(1, Math.min(10, +n || 1)); return (typeof t === "function") ? t("lvl_" + n) : String(n); }
function aiRatingOf(n) { return AI_LEVEL_RATING[Math.max(1, Math.min(10, +n || 1))] || 2850; }
function aiLevelWord() { return (typeof t === "function") ? t("word_rating") : "레이팅"; }
// AI is presented by target RATING (not a step number): "레이팅 1100 · 클럽".
function aiLevelText(n) { return `${aiLevelWord()} ${aiRatingOf(n)} · ${aiTitle(n)}`; }
function aiOppInfo() {
  if (AIG.style && AIG.style !== "default")
    return { name: `${t(AI_STYLE_LABEL[AIG.style]) || "AI"} AI`, rating: (typeof t === "function") ? t("word_max") : "최강" };
  const lv = AIG.level;
  return { name: `AI · ${aiTitle(lv)}`, rating: aiRatingOf(lv) };
}
function renderAiPbars() {
  const top = $("aiTopBar"), bottom = $("aiBottomBar");
  if (!top || !bottom) return;
  if (!AIG.started || !AIG.state) { top.classList.add("hidden"); bottom.classList.add("hidden"); return; }
  top.classList.remove("hidden"); bottom.classList.remove("hidden");
  const mine = AIG.human, theirs = mine === "w" ? "b" : "w";
  const turnOf = (c) => AIG.started && !AIG.over && AIG.state.turn === c;
  const mat = materialInfo(AIG.state.fen);
  const html = (name, rating, isMe, active, color, face) =>
    `<span class="pv-ava ${isMe ? "me" : ""}${face ? " face" : ""}">${face || escapeHtml(String(name).charAt(0).toUpperCase())}</span>` +
    `<span class="pv-name">${escapeHtml(name)}</span>` +
    capHtml(mat, color) +
    `<span class="pv-rating">${typeof rating === "number" ? ratingHTML(rating) : escapeHtml(rating)}</span>` +
    `<span class="pv-turn ${active ? "active" : ""}"></span>`;
  const opp = aiOppInfo();
  top.innerHTML = html(opp.name, opp.rating, false, turnOf(theirs), theirs, aiOppFace());
  bottom.innerHTML = html(AUTH.id || t("og_me"), myRating(), true, turnOf(mine), mine, null);
}

function updateAiTurn() {
  renderAiPbars();
  const el = $("aiTurn"), st = AIG.state;   // NB: use 'el' — 't' is the i18n function
  const T = (typeof t === "function") ? t : ((k) => k);
  if (!st || !AIG.started) { el.innerHTML = '<span class="pill"></span>' + T("turn_start"); return; }
  if (AIG.over) { el.innerHTML = "<b>" + T("turn_over") + "</b>"; return; }
  if (AIG.thinking) { el.innerHTML = '<span class="pill b"></span>' + T("turn_thinking"); return; }
  const w = st.turn === "w", mine = st.turn === AIG.human;
  el.innerHTML = `<span class="pill ${w ? "" : "b"}"></span>${w ? T("turn_white") : T("turn_black")}` +
    (mine ? " " + T("turn_you") : " " + T("turn_ai")) +
    (st.check ? ` · <b style='color:#ff8a80'>${T("turn_check")}</b>` : "");
}

function renderAiMoves() {
  const el = $("aiMoves");
  const san = (AIG.state && AIG.state.san) ? AIG.state.san : [];
  if (!san.length) { el.innerHTML = `<span class="num">${t("ai_moves_empty")}</span>`; }
  else {
    let html = "";
    san.forEach((s, i) => {
      if (i % 2 === 0) html += `<span class="num">${i / 2 + 1}.</span>`;
      html += `<span class="mv" style="cursor:default">${s}</span> `;
    });
    el.innerHTML = html; el.scrollTop = el.scrollHeight;
  }
  renderMoveStrip("aiMoveStrip", san);
  if (typeof updateAiNav === "function") updateAiNav();
  updateOpeningLine("aiOpening", AIG.moves);
}

// Compact horizontal notation strip shown in the board column — stays visible
// during full-screen (immersive) play so you can glance back at earlier moves.
function renderMoveStrip(elId, san) {
  const el = document.getElementById(elId); if (!el) return;
  if (!san || !san.length) { el.innerHTML = ""; el.classList.add("empty"); return; }
  el.classList.remove("empty");
  let html = "";
  san.forEach((s, i) => {
    if (i % 2 === 0) html += `<span class="ms-num">${i / 2 + 1}.</span>`;
    const last = i === san.length - 1;
    html += `<span class="ms-mv${last ? " cur" : ""}">${s}</span>`;
  });
  el.innerHTML = html;
  el.scrollLeft = el.scrollWidth;   // keep the latest move in view
}

async function aiHumanMove(uci) {
  // Instant feedback: move the piece right away, don't wait for the server.
  AIG.sel = null; AIG.hint = null; AIG.viewState = null; AIG.viewIdx = null; AIG.viewLast = null;
  optimisticMove($("aiBoard"), uci.slice(0, 2), uci.slice(2, 4), AIG.orient);
  const moves = [...AIG.moves, uci];
  let st;
  try { st = await api("/api/legal", { moves, startFen: AIG.startFen }); }
  catch (e) { renderAiBoard(); setStatus("aiStatus", isOffline(e) ? t("offline_msg") : t("ai_move_err") + e.message, true); return; }
  AIG.moves = moves; AIG.state = st;
  renderAiBoard(); renderAiMoves(); updateAiTurn();   // authoritative — fixes any special move / check
  playMoveSfx(st);
  if (st.gameOver) { aiEndGame(); return; }
  await aiReply();   // no artificial delay
}

// ---- client-side AI move (Stockfish in the browser; server is the fallback) ----
// Mirrors the server ladder (chess_coach/engine.py _LADDER): low levels mostly
// blunder a random legal move; higher levels play at a capped Elo.
const AI_LADDER = {
  1: { rand: 0.30, elo: 1320 }, 2: { rand: 0.20, elo: 1320 }, 3: { rand: 0.10, elo: 1320 },
  4: { rand: 0.05, elo: 1320 }, 5: { rand: 0.02, elo: 1400 }, 6: { rand: 0.00, elo: 1550 },
  7: { rand: 0.00, elo: 1750 }, 8: { rand: 0.00, elo: 2000 }, 9: { rand: 0.00, elo: 2400 },
  10: { rand: 0.00, elo: null },
};
function randomLegalUci(state) {
  const legal = (state && state.legal) || {};
  const froms = Object.keys(legal).filter((f) => legal[f] && legal[f].length);
  if (!froms.length) return null;
  const from = froms[Math.floor(Math.random() * froms.length)];
  const tos = legal[from];
  let uci = from + tos[Math.floor(Math.random() * tos.length)];
  try { const m = parseFen(state.fen); if (m[from] && m[from].toLowerCase() === "p" && (uci[3] === "8" || uci[3] === "1")) uci += "q"; } catch (e) {}
  return uci;
}
// FIX7: a tiny, engine-free move policy for the WEAKEST levels — "grab material
// that looks free, otherwise play randomly". It offloads trivial games from the
// 0.1-CPU server entirely (and makes level 1-2 replies instant) without shipping
// a GPL engine to the browser. Only the two lowest tiers use it; 3+ keep the
// stronger server engine so difficulty still scales.
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
function aiWeakMoveLocal(state, level) {
  const legal = (state && state.legal) || {};
  let map; try { map = parseFen(state.fen); } catch (e) { return null; }
  if (!map) return null;
  const froms = Object.keys(legal).filter((f) => legal[f] && legal[f].length);
  if (!froms.length) return null;
  let best = [], bestScore = 0;
  for (const f of froms) {
    const mover = PIECE_VAL[(map[f] || "p").toLowerCase()] || 1;
    for (const to of legal[f]) {
      const tgt = map[to]; if (!tgt) continue;                  // captures only
      const gain = PIECE_VAL[tgt.toLowerCase()] || 0;
      if (gain < mover) continue;                                // only obviously-good grabs
      const score = gain * 10 - mover;
      if (score > bestScore) { bestScore = score; best = [[f, to]]; }
      else if (score === bestScore) best.push([f, to]);
    }
  }
  const toUci = (ft) => {
    let uci = ft[0] + ft[1];
    if ((map[ft[0]] || "").toLowerCase() === "p" && (ft[1][1] === "8" || ft[1][1] === "1")) uci += "q";
    return uci;
  };
  const randChance = level <= 1 ? 0.6 : 0.25;                    // level 1 blunders more
  if (best.length && Math.random() >= randChance) return toUci(best[Math.floor(Math.random() * best.length)]);
  return randomLegalUci(state);
}

async function aiComputeMoveLocal() {
  // FIX7: weakest tiers run entirely client-side (no engine, no server call).
  if (!AIG.variant && (!AIG.style || AIG.style === "default") && AIG.level <= 2) {
    const wm = aiWeakMoveLocal(AIG.state, AIG.level);
    if (wm) return wm;
  }
  if (!USE_CLIENT_ENGINE) return null;                     // client engine too weak → use the server
  if (!(window.SF && SF.available)) return null;
  if (AIG.variant) return null;                            // Chess960 castling → server
  if (AIG.style && AIG.style !== "default") return null;   // famous-player styles → server
  const st = AIG.state; if (!st || !st.fen) return null;
  const cfg = AI_LADDER[Math.max(1, Math.min(10, AIG.level))] || AI_LADDER[10];
  if (cfg.rand && Math.random() < cfg.rand) { const r = randomLegalUci(st); if (r) return r; }
  const movetime = cfg.elo == null ? 1500 : 180 + AIG.level * 35;
  try { const res = await SF.bestMove(st.fen, { elo: cfg.elo, movetime }); return (res && res.bestmove) || null; }
  catch (e) { return null; }
}

async function aiReply() {
  // NOTE: do not re-render the board here — that would wipe the player's
  // in-flight slide animation. Input is already gated by AIG.thinking.
  AIG.thinking = true; updateAiTurn();
  let res = null;
  // Try the local engine first (offloads the slow 0.1-CPU server search).
  const localUci = await aiComputeMoveLocal();
  if (localUci) {
    try { res = await api("/api/legal", { moves: [...AIG.moves, localUci], startFen: AIG.startFen }); res.move = localUci; }
    catch (e) { res = null; }
  }
  if (!res) {
    try { res = await api("/api/ai_move", { moves: AIG.moves, level: AIG.level, style: AIG.style, startFen: AIG.startFen }); }
    catch (e) { AIG.thinking = false; updateAiTurn(); setStatus("aiStatus", isOffline(e) ? t("offline_msg") : t("ai_reply_err") + e.message, true); return; }
  }
  AIG.thinking = false;
  if (res.move) AIG.moves.push(res.move);
  AIG.state = res;
  AIG.viewState = null; AIG.viewIdx = null; AIG.viewLast = null;   // new move → back to live
  renderAiBoard(); renderAiMoves(); updateAiTurn();
  if (res.move) animateMove($("aiBoard"), res.move.slice(0, 2), res.move.slice(2, 4), AIG.orient);
  playMoveSfx(res);
  if (res.gameOver) aiEndGame();
}

function aiPlayerNames() {
  const lv = AIG.level;
  const ai = `AI ${aiTitle(lv)}`;
  return AIG.human === "w"
    ? { white: t("ai_you"), black: ai }
    : { white: ai, black: t("ai_you") };
}

function aiEndGame() {
  AIG.over = true; markGameOver(); renderAiBoard(); updateAiTurn();  // stay full-screen; board keeps the final position
  const r = AIG.state.result, lv = AIG.level;
  let kind = "draw";
  if (r === "1-0") kind = AIG.human === "w" ? "win" : "loss";
  else if (r === "0-1") kind = AIG.human === "b" ? "win" : "loss";
  if (typeof questBump === "function") questBump("aiGames");   // daily quest progress
  if (kind === "win" && typeof suggestSaveProgress === "function") suggestSaveProgress();   // guests: save nudge
  if (kind === "win" && typeof metric === "function") metric("first_win", { once: true });   // ADD10 funnel
  if (kind === "win" && typeof maybeFirstSuccessSoftAsk === "function") setTimeout(maybeFirstSuccessSoftAsk, 1400);   // ADD5

  // Beating this level grants its title (if it's a new personal best).
  const T = (typeof t === "function") ? t : ((k) => k);
  let badge = null;
  if (kind === "win" && lv > bestLevel()) {
    setBestLevel(lv); updateRankBadge();
    badge = { text: `${aiLevelText(lv)} ${T("word_cleared")}`, master: lv >= 10 };
  }
  const { white, black } = aiPlayerNames();
  const aiName = `AI ${aiTitle(lv)}`;
  setStatus("aiStatus", `${T("ai_over")} (${r}).`);
  // Chess960 games can't be replayed from the standard start, so they skip the
  // review + history (which assume the normal opening position).
  const actions = [];
  if (!AIG.variant) {
    addHistory({ mode: "ai", opponent: aiName, result: kind, ratingDelta: null,
      moves: [...AIG.moves], white, black });
    $("aiAnalyze").classList.remove("hidden");
    const reviewReq = { moves: [...AIG.moves], white, black, movetime: REVIEW_MT, human: AIG.human };
    prefetchAnalyze(reviewReq).catch(() => {});
    actions.push({ label: T("ai_review_btn"), primary: true, onClick: () => runAnalyze(reviewReq) });
  }
  actions.push({ label: T("ai_again_btn"), onClick: () => aiStart() });
  const _nextAi = (typeof nextTodoAction === "function") ? nextTodoAction(["📊"]) : null;   // ADD9 (skip if it'd dup 복기)
  if (_nextAi) actions.push(_nextAi);
  actions.push({ label: T("card_share"), onClick: () => shareResultCard({
    icon: kind === "win" ? "🏆" : kind === "loss" ? "😢" : "🤝",
    title: kind === "win" ? T("res_win") : kind === "loss" ? T("res_loss") : T("res_draw"),
    sub: "vs " + aiName, fen: AIG.state && AIG.state.fen }) });
  actions.push({ label: T("exit_btn"), onClick: () => exitImmersive() });
  const opts = kind === "win"
    ? { kind, icon: "🏆", title: T("res_win"), sub: T("won_vs").replace("{ai}", aiName) + streakSuffix(), badge, actions }
    : kind === "loss"
      ? { kind, icon: "😢", title: T("res_loss"), sub: T("lost_vs").replace("{ai}", aiName), actions }
      : { kind, icon: "🤝", title: T("res_draw"), sub: T("drew_vs").replace("{ai}", aiName), actions };
  presentResult(opts);
}

async function aiStart() {
  hideResult();
  document.body.classList.remove("gameover");
  const ge = $("gameExit"); if (ge) ge.classList.add("hidden");
  AIG.level = +$("aiLevel").value;
  AIG.human = $("aiColor").value;
  AIG.style = $("aiStyle") ? $("aiStyle").value : "default";
  AIG.orient = AIG.human;
  AIG.moves = []; AIG.sel = null; AIG.over = false; AIG.thinking = false; AIG.started = true; AIG.hint = null;
  AIG.variant = !!($("ai960") && $("ai960").checked);
  AIG.startFen = null;
  if (USE_CLIENT_ENGINE && window.SF && SF.available) { SF.warmup(); SF.newGame(); }   // preload engine + clear hash
  $("aiAnalyze").classList.add("hidden");
  const T = (typeof t === "function") ? t : ((k) => k);
  if (AIG.variant) {
    try { const v = await (await fetch("/api/variant960")).json(); AIG.startFen = v.startFen || null; }
    catch (e) { AIG.variant = false; }
  }
  try { AIG.state = await api("/api/legal", { moves: [], startFen: AIG.startFen }); }
  catch (e) { AIG.started = false; setStatus("aiStatus", isOffline(e) ? t("offline_msg") : T("err_start") + ": " + e.message, true); return; }
  const who = AIG.style !== "default" ? T("style_" + AIG.style) : aiLevelText(AIG.level);
  const side = AIG.human === "w" ? T("side_white") : T("side_black");
  setStatus("aiStatus", T("ai_start_msg").replace("{who}", who).replace("{side}", side));
  document.body.classList.add("ingame");     // immersive: board + opponent only
  if (typeof setResume === "function") setResume({ kind: "ai" });   // ADD3 continuity
  renderAiBoard(); renderAiMoves(); updateAiTurn();
  if (typeof maybeGuideFirstGame === "function") maybeGuideFirstGame();   // ADD1
  if (AIG.human === "b") await aiReply();   // AI (white) moves first
}
// ADD1: one-time coaching the very first time a player faces the AI — point them
// at the hint + takeback safety nets so a first game feels winnable, not scary.
function maybeGuideFirstGame() {
  try {
    if (localStorage.getItem("cc_guided_first") === "1") return;
    const hist = (typeof gameHistory === "function") ? gameHistory() : [];
    if (hist && hist.length > 1) return;   // not their first game
    localStorage.setItem("cc_guided_first", "1");
    if (typeof shareFlash === "function") setTimeout(() => shareFlash(t("guide_first_game")), 700);
    const hb = $("aiHint");
    if (hb) { hb.classList.add("pulse-hint"); setTimeout(() => hb.classList.remove("pulse-hint"), 6000); }
  } catch (e) {}
}

// ---- ⑤ takeback + hint (AI games) ----
// Undo the player's last move (and the AI's reply). Re-derives the authoritative
// position from the trimmed move list; if it lands on the AI's turn (e.g. player
// is Black and undid their first move down to the empty start), the AI replays.
async function aiTakeback() {
  if (!AIG.started || AIG.over || AIG.thinking) return;
  const hp = AIG.human === "w" ? 0 : 1;          // parity of the human's plies
  let cut = -1;
  for (let i = AIG.moves.length - 1; i >= 0; i--) { if ((i % 2) === hp) { cut = i; break; } }
  if (cut < 0) return;                            // no human move to undo yet
  const moves = AIG.moves.slice(0, cut);
  AIG.sel = null; AIG.hint = null;
  let st;
  try { st = await api("/api/legal", { moves, startFen: AIG.startFen }); }
  catch (e) { setStatus("aiStatus", isOffline(e) ? t("offline_msg") : t("ai_move_err") + e.message, true); return; }
  AIG.moves = moves; AIG.state = st; AIG.over = false;
  renderAiBoard(); renderAiMoves(); updateAiTurn();
  if (st.turn !== AIG.human && !st.gameOver) await aiReply();   // hand the move back to the AI when needed
}

// Ask the engine for the best move in the current position and flash it.
async function aiHint() {
  if (!AIG.started || AIG.over || AIG.thinking || !AIG.state) return;
  if (AIG.state.turn !== AIG.human) return;       // only when it's your move
  setStatus("aiStatus", t("hint_thinking"), false);
  // hint from the server's native engine (the client asm.js build is too weak).
  let uci = null;
  if (USE_CLIENT_ENGINE && window.SF && SF.available && !AIG.variant) {
    try { const lr = await SF.bestMove(AIG.state.fen, { movetime: 500 }); uci = lr && lr.bestmove; } catch (e) {}
  }
  if (!uci) {
    let r;
    try { r = await api("/api/eval_fen", { fen: AIG.state.fen, movetime: 300 }); }
    catch (e) { setStatus("aiStatus", isOffline(e) ? t("offline_msg") : t("ai_move_err") + e.message, true); return; }
    uci = r && r.bestUci;
  }
  if (!uci) { setStatus("aiStatus", t("hint_none"), false); return; }
  AIG.hint = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  renderAiBoard();
  setStatus("aiStatus", t("hint_shown").replace("{sq}", uci.slice(0, 2) + "→" + uci.slice(2, 4)), false);
  clearTimeout(aiHint._t);
  aiHint._t = setTimeout(() => { AIG.hint = null; renderAiBoard(); }, 4000);
}

// ---- in-game move navigation (VIEW previous moves only — not takeback) ----
// Shows the board at an earlier ply without altering the live game. Making a
// move (or tapping the board / ▶ to the end) returns to the live position.
async function aiView(idx) {
  if (!AIG.started) return;
  const total = AIG.moves.length;
  idx = Math.max(0, Math.min(total, idx));
  if (idx === total) { aiViewLive(); return; }        // back at the live position
  const sub = AIG.moves.slice(0, idx);
  let st;
  try { st = await api("/api/legal", { moves: sub, startFen: AIG.startFen }); }
  catch (e) { return; }
  AIG.viewIdx = idx;
  AIG.viewState = st;
  AIG.viewLast = idx > 0 ? AIG.moves[idx - 1] : null;
  AIG.sel = null;
  renderAiBoard(); updateAiNav();
}
function aiViewLive() {
  AIG.viewIdx = null; AIG.viewState = null; AIG.viewLast = null;
  renderAiBoard(); updateAiNav();
}
function updateAiNav() {
  const total = AIG.moves.length;
  const cur = AIG.viewIdx == null ? total : AIG.viewIdx;
  const prev = $("aiPrev"), next = $("aiNext"), strip = $("aiMoveStrip");
  if (prev) prev.disabled = cur <= 0;
  if (next) next.disabled = cur >= total;
  if (strip) strip.classList.toggle("viewing", AIG.viewIdx != null);
}
if ($("aiPrev")) $("aiPrev").onclick = () => aiView((AIG.viewIdx == null ? AIG.moves.length : AIG.viewIdx) - 1);
if ($("aiNext")) $("aiNext").onclick = () => aiView((AIG.viewIdx == null ? AIG.moves.length : AIG.viewIdx) + 1);

$("aiLevel").oninput = (e) => {
  $("aiLevelLabel").textContent = aiLevelText(+e.target.value);
};

// ---- difficulty as a button grid (replaces the slider) ----
const AI_LEVEL_PRESETS = [1, 3, 5, 7, 9, 10];
function renderAiLevels() {
  const el = document.getElementById("aiLevelBtns"); if (!el) return;
  const cur = +($("aiLevel").value) || 3;
  const T = (typeof t === "function") ? t : ((k) => k);
  el.innerHTML = AI_LEVEL_PRESETS.map((lv) =>
    '<button type="button" class="diflevel' + (lv === cur ? " active" : "") + '" data-lv="' + lv + '">' +
      '<span class="dif-face">' + aiFace(lv) + "</span>" +
      "<b>" + aiTitle(lv) + "</b><span>" + aiLevelWord() + " " + aiRatingOf(lv) + "</span></button>").join("");
  el.querySelectorAll(".diflevel").forEach((b) => { b.onclick = () => setAiLevel(+b.dataset.lv); });
}
function setAiLevel(lv) {
  const inp = $("aiLevel"); inp.value = lv;
  const lab = $("aiLevelLabel"); if (lab) lab.textContent = aiLevelText(lv);
  renderAiLevels();
}

$("aiStyle").onchange = (e) => {
  const styled = e.target.value !== "default";
  $("aiStyleNote").style.display = styled ? "block" : "none";
  $("aiLevel").disabled = styled;
  $("aiLevelLabel").style.opacity = styled ? "0.4" : "1";
  const g = document.getElementById("aiLevelBtns"); if (g) g.classList.toggle("dim", styled);
};
$("aiStart").onclick = aiStart;

// --- Segmented chip controls: a nicer UI mirroring the hidden <select>s.
// Each ".segmented[data-seg-for]" wraps a chip per option of its target
// select. Clicking a chip sets select.value + fires a real "change" event so
// existing onchange handlers run. Chip labels are (re)read from option text so
// they stay translated; call this on load and after any language change.
function segShortLabel(text) {
  var s = (text || "").trim();
  var emoji = "";
  try {
    var m = s.match(/\s([\p{Extended_Pictographic}][️‍\p{Extended_Pictographic}]*)\s*$/u);
    if (m) emoji = m[1];
  } catch (e) {}
  // take the name before an em/en dash or an opening parenthesis
  var name = s.split(/\s[—–-]\s|\s*[（(]/)[0].trim() || s;
  return emoji ? name + " " + emoji : name;
}
function syncSegmentedControls() {
  var wraps = document.querySelectorAll(".segmented[data-seg-for]");
  wraps.forEach(function (wrap) {
    var sel = document.getElementById(wrap.getAttribute("data-seg-for"));
    if (!sel) return;
    var opts = sel.options;
    if (wrap.children.length !== opts.length) {
      wrap.innerHTML = "";
      for (var i = 0; i < opts.length; i++) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "seg-btn";
        b.setAttribute("data-seg-val", opts[i].value);
        b.addEventListener("click", function () {
          sel.value = this.getAttribute("data-seg-val");
          sel.dispatchEvent(new Event("change"));
          syncSegmentedControls();
        });
        wrap.appendChild(b);
      }
    }
    for (var j = 0; j < opts.length; j++) {
      var chip = wrap.children[j];
      if (!chip) continue;
      chip.textContent = segShortLabel(opts[j].textContent);
      chip.title = opts[j].textContent.trim();
      var on = opts[j].value === sel.value;
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
  });
}
syncSegmentedControls();

$("aiFlip").onclick = () => { AIG.orient = AIG.orient === "w" ? "b" : "w"; renderAiBoard(); };
$("aiUndo").onclick = aiTakeback;
$("aiHint").onclick = aiHint;
$("aiResign").onclick = () => {
  if (!AIG.moves.length) { setStatus("aiStatus", t("ai_need_move"), true); return; }
  AIG.over = true; markGameOver(); renderAiBoard(); updateAiTurn();   // stay full-screen
  const { white, black } = aiPlayerNames();
  const moves = [...AIG.moves], lv = AIG.level;
  setStatus("aiStatus", t("ai_resigned"));
  $("aiAnalyze").classList.remove("hidden");
  addHistory({ mode: "ai", opponent: `AI ${aiTitle(lv)}`, result: "loss", ratingDelta: null,
    moves: [...moves], white, black });
  // AI review is OPTIONAL — offered as a button, not run automatically.
  showResult({
    kind: "loss", icon: "🏳️", title: t("ai_resign_title"),
    sub: t("ai_resign_sub").replace("{ai}", aiTitle(lv)),
    actions: [
      { label: t("ai_review_btn"), primary: true, onClick: () => runAnalyze({ moves, white, black, movetime: REVIEW_MT }) },
      { label: t("ai_again_btn"), onClick: () => aiStart() },
      { label: t("exit_btn"), onClick: () => exitImmersive() },
    ],
  });
};
$("aiAnalyze").onclick = () => {
  if (!AIG.moves.length) return;
  const { white, black } = aiPlayerNames();
  runAnalyze({ moves: AIG.moves, white, black, movetime: REVIEW_MT, human: AIG.human });
};

// =========================================================================== //
// CHECKMATE PUZZLES
// =========================================================================== //
const PZ = { list: [], idx: 0, cat: 0, baseFen: null, fen: null, mateIn: 0, movesLeft: 0,
  sel: null, legal: {}, lastUci: null, hintSq: null, busy: false, locked: false, solved: pzLoadSolved() };
// category (theme group) helpers — robust to variable per-category counts.
function pzCatOf(idx) {
  const p = PZ.list[idx];
  return (p && typeof p.cat === "number") ? p.cat : Math.floor(idx / 25);
}
function pzCatRange(cat) {
  let start = -1, count = 0;
  for (let i = 0; i < PZ.list.length; i++) {
    const c = (typeof PZ.list[i].cat === "number") ? PZ.list[i].cat : Math.floor(i / 25);
    if (c === cat) { if (start < 0) start = i; count++; }
  }
  if (start < 0) { start = cat * 25; count = 25; }
  return { start, count };
}
// FIX1: puzzles are no longer gated by a sequential unlock — every puzzle is
// open and we steer the player to level-appropriate problems via the rating
// band (pickAdaptivePuzzle). Kept as a function so existing call-sites still work.
function pzUnlocked(idx) { return !!PZ.list[idx]; }

function pzLoadSolved() {
  try { return new Set(JSON.parse(localStorage.getItem("cc_puzzles_solved") || "[]")); }
  catch (e) { return new Set(); }
}
function pzSaveSolved() { localStorage.setItem("cc_puzzles_solved", JSON.stringify([...PZ.solved])); authSchedulePush(); }

// ---- ADAPTIVE puzzle rating (ADD2 / FIX1) ---------------------------------
// A lightweight skill estimate JUST for puzzles, so we serve problems near the
// player's level (rating band) instead of a fixed sequential ladder. Elo-lite:
// seeded from onboarding skill / online rating, nudged up on a clean solve and
// down when the player needed the answer.
const PZ_RATING_DEFAULT = 800, PZ_BAND = 100, PZ_K = 28;
function pzRatingGet() {
  const v = +localStorage.getItem("cc_pz_rating");
  if (v && v > 0) return v;
  const online = +(localStorage.getItem("cc_rating3") || 0);
  const skill = localStorage.getItem("cc_skill") || "";
  let seed = PZ_RATING_DEFAULT;
  if (online > 0) seed = 700 + online * 0.6;
  else if (skill === "new") seed = 550; else if (skill === "beg") seed = 750;
  else if (skill === "mid") seed = 1050; else if (skill === "adv") seed = 1400;
  seed = Math.max(500, Math.min(1900, Math.round(seed)));
  localStorage.setItem("cc_pz_rating", String(seed));
  return seed;
}
function pzRatingSet(v) {
  localStorage.setItem("cc_pz_rating", String(Math.max(400, Math.min(2200, Math.round(v)))));
  if (typeof authSchedulePush === "function") authSchedulePush();
}
function pzExpected(myR, pR) { return 1 / (1 + Math.pow(10, ((pR || myR) - myR) / 400)); }
function pzRatingUpdate(pRating, win) {
  const my = pzRatingGet();
  pzRatingSet(my + PZ_K * ((win ? 1 : 0) - pzExpected(my, pRating)));
}
// Pick the best UNSOLVED puzzle within the rating band (widen if empty); ties
// broken by closeness to the target. All solved → allow a replay of the closest.
function pickAdaptivePuzzle() {
  if (!PZ.list || !PZ.list.length) return 0;
  const my = pzRatingGet();
  const rated = PZ.list.map((p, i) => ({ i, r: (typeof p.rating === "number" ? p.rating : my), solved: PZ.solved.has(p.level) }));
  const unsolved = rated.filter((x) => !x.solved);
  const pool = unsolved.length ? unsolved : rated;
  let band = PZ_BAND, pick = null;
  while (band <= 900 && !pick) {
    const inB = pool.filter((x) => Math.abs(x.r - my) <= band);
    if (inB.length) { inB.sort((a, b) => Math.abs(a.r - my) - Math.abs(b.r - my)); pick = inB[0]; }
    band += 150;
  }
  if (!pick) { pool.sort((a, b) => Math.abs(a.r - my) - Math.abs(b.r - my)); pick = pool[0]; }
  return pick ? pick.i : 0;
}
function loadAdaptivePuzzle() { loadPuzzle(pickAdaptivePuzzle(), { force: true }); }

// =========================================================================== //
// DAILY PUZZLE + STREAK CALENDAR — one puzzle a day (same for everyone, chosen
// by the date), a consecutive-day streak, and a month calendar of solved days.
// A strong return hook: miss a day and the streak resets.
// =========================================================================== //
function dateStr(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// deterministic index from today's date → everyone gets the same daily puzzle
function dailyIndex() {
  if (!PZ.list.length) return 0;
  const s = dateStr(); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h % PZ.list.length;
}
function dailySolvedDates() { try { return JSON.parse(localStorage.getItem("cc_daily_solved") || "[]") || []; } catch (e) { return []; } }
function isDailySolved(d) { return dailySolvedDates().includes(d || dateStr()); }
function markDailySolved() {
  const arr = dailySolvedDates(), today = dateStr();
  if (!arr.includes(today)) {
    arr.push(today);
    localStorage.setItem("cc_daily_solved", JSON.stringify(arr));
    if (typeof authSchedulePush === "function") authSchedulePush();
  }
  maintainStreak();
}

// ---- streak freeze: a missed day doesn't instantly reset the streak. One
// freeze is available per ISO week; on app open we retroactively "freeze" a
// single missed day per week so the run survives. Duolingo-style. ----
function frozenDates() { try { return JSON.parse(localStorage.getItem("cc_freeze_dates") || "[]") || []; } catch (e) { return []; } }
function _isoWeekKey(d) {
  // Monday-based week key "YYYY-Wn" (stable enough to cap 1 freeze per week)
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;               // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3);            // nearest Thursday
  const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + "-W" + wk;
}
function maintainStreak() {
  const solvedArr = dailySolvedDates();
  if (!solvedArr.length) return;
  const solved = new Set(solvedArr);
  const earliest = solvedArr.slice().sort()[0];       // don't walk past the first solved day
  const frozen = new Set(frozenDates());
  const weekUsed = {};
  frozen.forEach((f) => { weekUsed[_isoWeekKey(new Date(f))] = true; });
  // Walk back from yesterday to the earliest solved day. Pass THROUGH covered days
  // (solved or already frozen); when a day is uncovered, spend that week's single
  // freeze on it — if the week's freeze is already used, the streak truly breaks
  // there and we stop (nothing before it matters to the current run).
  const d = new Date(); d.setDate(d.getDate() - 1);
  let guard = 0, changed = false;
  while (guard++ < 800) {
    const ds = dateStr(d);
    if (ds < earliest) break;                          // gone past all solved history
    if (!solved.has(ds) && !frozen.has(ds)) {          // an uncovered gap
      const wk = _isoWeekKey(d);
      if (weekUsed[wk]) break;                          // no freeze left this week → streak ends here
      frozen.add(ds); weekUsed[wk] = true; changed = true;
    }
    d.setDate(d.getDate() - 1);
  }
  if (changed) {
    localStorage.setItem("cc_freeze_dates", JSON.stringify([...frozen]));
    if (typeof authSchedulePush === "function") authSchedulePush();
  }
}
// consecutive days (solved OR frozen) ending today (or yesterday if today pending)
function dailyStreakCount() {
  const solved = new Set(dailySolvedDates()), frozen = new Set(frozenDates());
  const has = (ds) => solved.has(ds) || frozen.has(ds);
  let n = 0; const d = new Date();
  if (!has(dateStr(d))) d.setDate(d.getDate() - 1);   // today pending → don't break the run yet
  while (has(dateStr(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
// milestone badges at 7 / 30 / 100 consecutive days
const STREAK_MILES = [7, 30, 100];
function streakMilesReached() { try { return JSON.parse(localStorage.getItem("cc_streak_miles") || "[]") || []; } catch (e) { return []; } }
// returns a newly-crossed milestone number (or 0), recording it
function checkStreakMilestone() {
  const n = dailyStreakCount(), got = streakMilesReached();
  const hit = STREAK_MILES.find((m) => n >= m && !got.includes(m));
  if (hit) {
    got.push(hit);
    localStorage.setItem("cc_streak_miles", JSON.stringify(got));
    if (typeof authSchedulePush === "function") authSchedulePush();
    if (typeof xpAdd === "function") xpAdd(40);      // milestone bonus XP
    return hit;
  }
  return 0;
}
// load today's puzzle, bypassing the sequential lock
function loadDaily() {
  if (!PZ.list.length) return;
  if (typeof switchTab === "function") switchTab("puzzle");
  loadPuzzle(dailyIndex(), { force: true });
}
function monthCalendarHTML() {
  const set = new Set(dailySolvedDates()), fz = new Set(frozenDates());
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const firstDow = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), todayD = now.getDate();
  const dow = (t("cal_dow") || "S,M,T,W,T,F,S").split(",");
  let head = dow.map((d) => '<span class="cal-dow">' + d + "</span>").join("");
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += '<span class="cal-cell empty"></span>';
  for (let d = 1; d <= days; d++) {
    const ds = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    let cls = "cal-cell";
    if (set.has(ds)) cls += " solved";
    else if (fz.has(ds)) cls += " frozen";       // covered by a streak freeze
    if (d === todayD) cls += " today";
    const label = fz.has(ds) && !set.has(ds) ? "❄" : d;
    cells += '<span class="' + cls + '">' + label + "</span>";
  }
  return '<div class="pz-cal"><div class="cal-head">' + head + '</div><div class="cal-grid">' + cells + "</div></div>";
}
function renderDaily() {
  const el = document.getElementById("pzDaily"); if (!el) return;
  if (!PZ.list.length) { el.innerHTML = ""; return; }
  if (typeof maintainStreak === "function") maintainStreak();   // keep the streak honest on open
  const solved = isDailySolved(), streak = dailyStreakCount();
  // milestone chips + next target
  const got = (typeof streakMilesReached === "function") ? streakMilesReached() : [];
  const next = STREAK_MILES.find((m) => m > streak);
  const mileHtml = got.length
    ? '<span class="pzd-miles">' + got.map((m) => '<span class="pzd-badge">🏅' + m + "</span>").join("") + "</span>" : "";
  const nextHtml = next ? '<span class="pzd-next">' + t("streak_next").replace("{n}", next - streak).replace("{m}", next) + "</span>" : "";
  el.innerHTML =
    '<div class="pzd-main">' +
      '<div class="pzd-info"><div class="pzd-title">🗓️ ' + t("daily_title") + "</div>" +
        '<div class="pzd-sub">' + (solved ? t("daily_done") : t("daily_go_sub")) + "</div></div>" +
      '<button class="pzd-btn' + (solved ? " done" : "") + '" id="pzDailyBtn">' +
        (solved ? "✓ " + t("daily_btn_done") : t("daily_btn")) + "</button>" +
    "</div>" +
    '<div class="pzd-streak">🔥 ' + t("daily_streak").replace("{n}", streak) + mileHtml + nextHtml + "</div>" +
    monthCalendarHTML();
  const b = document.getElementById("pzDailyBtn"); if (b) b.onclick = loadDaily;
}

// =========================================================================== //
// SPACED-REPETITION REVIEW QUEUE (Leitner) — a puzzle you fail comes back after
// 1, then 3, then 7 days; solve it each time to graduate, fail and it resets.
// Retrieval practice is what makes a pattern actually stick.
// =========================================================================== //
const REVIEW_BOXES = [1, 3, 7];   // days until next review, per Leitner box
function addDays(ds, n) { const d = new Date(ds + "T00:00:00"); d.setDate(d.getDate() + n); return dateStr(d); }
function reviewQueue() { try { return JSON.parse(localStorage.getItem("cc_review_queue") || "{}") || {}; } catch (e) { return {}; } }
function saveReviewQueue(q) { localStorage.setItem("cc_review_queue", JSON.stringify(q)); if (typeof authSchedulePush === "function") authSchedulePush(); }
function reviewAdd(level) {                          // a failed puzzle → schedule (box 0)
  if (!level) return;
  const q = reviewQueue();
  q[level] = { box: 0, due: addDays(dateStr(), REVIEW_BOXES[0]) };
  saveReviewQueue(q);
}
function reviewSolved(level) {                       // solved a queued puzzle → advance/graduate
  const q = reviewQueue(); if (!q[level]) return;
  if (typeof xpAdd === "function") xpAdd(10);        // completing a review is high-value learning
  const nb = (q[level].box || 0) + 1;
  if (nb >= REVIEW_BOXES.length) delete q[level];    // graduated out of the queue
  else q[level] = { box: nb, due: addDays(dateStr(), REVIEW_BOXES[nb]) };
  saveReviewQueue(q);
}
function reviewDue() {                               // puzzle levels due today or earlier
  const q = reviewQueue(), today = dateStr(), due = [];
  for (const lv in q) { if ((q[lv].due || "") <= today) due.push(+lv); }
  return due;
}
function loadReviewPuzzle() {
  const due = reviewDue(); if (!due.length) return;
  switchTab("puzzle");
  loadPuzzle(due[0] - 1, { force: true });          // level is 1-based; index is level-1
}

async function loadPuzzles() {
  $("pzPrompt").textContent = t("pz_loading");
  try { PZ.list = await (await fetch("/static/puzzles.json")).json(); }
  catch (e) { PZ.list = []; }
  if (PZ.list.length) {
    renderPzGrid();
    renderPzStreak();
    renderDaily();
    let idx = pickAdaptivePuzzle();   // resume at a level-appropriate unsolved puzzle
    if (idx < 0) idx = 0;
    PZ.bootIdx = idx;
    // Defer the board's /api/legal_fen call until the puzzle tab is actually
    // opened — no need to hit the slow engine at boot for a hidden board.
    const puzzleActive = document.getElementById("tab-puzzle") && document.getElementById("tab-puzzle").classList.contains("active");
    if (puzzleActive) loadPuzzle(idx);
  } else { $("pzPrompt").textContent = t("pz_load_fail"); }
}

function renderPzGrid() {
  const grid = $("pzGrid"); grid.innerHTML = "";
  const { start, count } = pzCatRange(PZ.cat);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    const p = PZ.list[idx]; if (!p) continue;
    const lvl = p.level;
    const unlocked = pzUnlocked(idx);
    const b = document.createElement("button");
    b.textContent = unlocked ? (i + 1) : "";
    if (idx === PZ.idx) b.classList.add("cur");
    if (PZ.solved.has(lvl)) b.classList.add("solved");
    if (!unlocked) b.classList.add("locked");
    b.onclick = () => loadPuzzle(idx);
    grid.appendChild(b);
  }
  const solvedCount = PZ.list.filter((p) => PZ.solved.has(p.level)).length;
  $("pzProgress").textContent = t("pz_grid_progress").replace("{n}", solvedCount).replace("{total}", PZ.list.length);
  renderPzRatingLine();
}
// show the player's adaptive puzzle rating + the band we're serving from (ADD2)
function renderPzRatingLine() {
  const el = document.getElementById("pzRatingLine"); if (!el) return;
  if (typeof pzRatingGet !== "function") { el.textContent = ""; return; }
  const r = pzRatingGet();
  el.innerHTML = t("pz_rating_line").replace("{r}", r).replace("{lo}", Math.max(0, r - PZ_BAND)).replace("{hi}", r + PZ_BAND);
}

async function loadPuzzle(idx, opts) {
  // ADD3: ad-hoc puzzle (a reconstructed review position) — bypass PZ.list and
  // run it through the tactical single-move check as a "guess the move" quiz.
  if (opts && opts.adhoc) {
    const p = opts.adhoc;
    PZ.adhoc = p; PZ.quiz = !!opts.quiz; PZ.rxActive = false;
    PZ.idx = -1; PZ.fails = 0; PZ.beginner = false; PZ.revealed = false; PZ.locked = false;
    PZ.baseFen = p.fen; PZ.fen = p.fen; PZ.mateIn = 0; PZ.movesLeft = 0;
    PZ.line = p.solution || []; PZ.played = []; PZ.theme = p.theme || "tactic";
    PZ.sel = null; PZ.lastUci = null; PZ.hintSq = null; PZ.busy = false;
    $("pzFeedback").textContent = ""; $("pzFeedback").className = "status";
    try { PZ.legal = await api("/api/legal_fen", { fen: PZ.fen }); }
    catch (e) { PZ.legal = { legal: {} }; }
    renderPzBoard();
    return;
  }
  PZ.adhoc = null; PZ.quiz = false;
  if (!(opts && opts.rx)) PZ.rxActive = false;   // leaving a prescription session
  if (idx < 0 || idx >= PZ.list.length) return;
  PZ.idx = idx; PZ.cat = pzCatOf(idx);
  PZ.fails = 0;                     // reset wrong-attempt counter (auto-hint after 3)
  PZ.beginner = !!(opts && opts.beginner);   // rules-beginner first success → hint after 1 miss
  PZ.revealed = false;                        // did the player need a hint/answer? (gates rating gain)
  if (typeof setResume === "function") setResume({ kind: "puzzle", idx });   // ADD3 continuity
  document.querySelectorAll("#pzCats button").forEach((b) =>
    b.classList.toggle("active", +b.dataset.cat === PZ.cat));
  const p = PZ.list[idx];
  renderPzGrid();
  if (!(opts && opts.force) && !pzUnlocked(idx)) {   // sequential lock — must beat the previous level first (daily bypasses)
    PZ.locked = true; PZ.fen = p.fen; PZ.sel = null; PZ.lastUci = null; PZ.hintSq = null; PZ.busy = false;
    PZ.legal = { legal: {} };
    $("pzPrompt").innerHTML = t("pz_locked").replace("{n}", p.level).replace("{prev}", p.level - 1);
    setStatus("pzFeedback", t("pz_locked_fb"), true);
    renderPzBoard();
    return;
  }
  PZ.locked = false;
  PZ.baseFen = p.fen; PZ.fen = p.fen; PZ.mateIn = p.mateIn; PZ.movesLeft = p.mateIn;
  PZ.line = p.solution || []; PZ.played = []; PZ.theme = p.theme || (p.mateIn ? "mate" : "tactic");
  PZ.sel = null; PZ.lastUci = null; PZ.hintSq = null; PZ.busy = false;
  $("pzPrompt").innerHTML = p.mateIn
    ? t("pz_prompt").replace("{n}", p.level).replace("{mate}", p.mateIn)
    : t("pz_prompt_tac").replace("{n}", p.level).replace("{theme}", t("pztheme_" + PZ.theme));
  $("pzFeedback").textContent = ""; $("pzFeedback").className = "status";
  try { PZ.legal = await api("/api/legal_fen", { fen: PZ.fen }); }
  catch (e) { PZ.legal = { legal: {} }; }
  renderPzBoard();
}

function renderPzBoard() {
  const board = $("pzBoard"); board.innerHTML = "";
  if (!PZ.fen) return;
  const map = parseFen(PZ.fen);
  const files = [..."abcdefgh"], ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  const lf = PZ.lastUci ? PZ.lastUci.slice(0, 2) : null, lt = PZ.lastUci ? PZ.lastUci.slice(2, 4) : null;
  const legal = (PZ.busy ? {} : (PZ.legal.legal || {}));
  let kingSq = null;
  if (PZ.legal.check) { const kc = PZ.legal.turn === "w" ? "K" : "k"; for (const s in map) if (map[s] === kc) kingSq = s; }
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      if (sq === lf || sq === lt) div.classList.add("last");
      if (PZ.sel === sq) div.classList.add("sel");
      if (PZ.hintSq === sq) div.classList.add("sel");
      if (sq === kingSq) div.classList.add("check");
      const p = map[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      if (SETTINGS.showDots && PZ.sel && legal[PZ.sel] && legal[PZ.sel].includes(sq)) {
        const d = document.createElement("div"); d.className = "dot" + (map[sq] ? " cap" : "");
        div.appendChild(d);
      }
      addCoords(div, f, rank, files, ranks);
      div.dataset.sq = sq;
      div.onclick = () => onPzClick(sq);
      board.appendChild(div);
    }
  }
}

function onPzClick(sq) {
  if (_dragJustMoved || PZ.busy || PZ.locked) return;
  PZ.hintSq = null;
  const legal = PZ.legal.legal || {};
  if (PZ.sel) {
    if (legal[PZ.sel] && legal[PZ.sel].includes(sq)) { pzUserMove(PZ.sel + sq); return; }
    if (legal[sq]) { PZ.sel = sq; renderPzBoard(); return; }
    PZ.sel = null; renderPzBoard(); return;
  }
  if (legal[sq]) { PZ.sel = sq; renderPzBoard(); }
}

function pzWrongEffect() {
  const stack = $("pzStack"), flash = $("pzFlash");
  stack.classList.remove("shake"); void stack.offsetWidth; stack.classList.add("shake");
  flash.classList.remove("show"); void flash.offsetWidth; flash.classList.add("show");
}

async function pzUserMove(uci) {
  if (!PZ.mateIn) return pzUserMoveLine(uci);   // tactical puzzles: verify against the solution line
  PZ.busy = true; PZ.sel = null; renderPzBoard();
  const prevFen = PZ.fen, prevLast = PZ.lastUci;
  let res;
  try { res = await api("/api/puzzle_move", { fen: PZ.fen, move: uci, mateIn: PZ.movesLeft }); }
  catch (e) { PZ.busy = false; setStatus("pzFeedback", isOffline(e) ? t("offline_msg") : t("pz_err") + e.message, true); renderPzBoard(); return; }

  if (!res.correct) {
    // play the move, then shake the board + flash a big "오답!", then revert
    PZ.fen = res.userFen; PZ.lastUci = uci;
    renderPzBoard();
    animateMove($("pzBoard"), uci.slice(0, 2), uci.slice(2, 4), "w");
    await sleep(260);
    pzWrongEffect();
    await sleep(760);
    PZ.fen = prevFen; PZ.lastUci = prevLast;
    PZ.busy = false; renderPzBoard();
    PZ.fails = (PZ.fails || 0) + 1;
    if (PZ.fails >= (PZ.beginner ? 1 : 3)) { pzShowHint(); setStatus("pzFeedback", t("pz_autohint"), false); }  // struggling → auto hint
    return;
  }
  // show the user's move
  PZ.fen = res.userFen; PZ.lastUci = uci;
  renderPzBoard();
  animateMove($("pzBoard"), uci.slice(0, 2), uci.slice(2, 4), "w");

  if (res.solved) {
    PZ.busy = false; PZ.legal = { legal: {} };
    await sleep(300);   // let the final piece finish sliding before the result shows
    pzSolved();
    return;
  }

  // defender replies after a short beat
  await sleep(260);
  PZ.fen = res.fen; PZ.lastUci = res.replyUci; PZ.movesLeft = res.mateIn;
  renderPzBoard();
  if (res.replyUci) animateMove($("pzBoard"), res.replyUci.slice(0, 2), res.replyUci.slice(2, 4), "w");
  setStatus("pzFeedback", t("pz_correct").replace("{n}", res.mateIn), false);
  $("pzFeedback").style.color = "#7bd88f";
  try { PZ.legal = await api("/api/legal_fen", { fen: PZ.fen }); } catch (e) { PZ.legal = { legal: {} }; }
  PZ.busy = false;
  renderPzBoard();
}

// Tactical (non-mate) puzzles: verify the move against the stored solution line
// and auto-play the opponent's forced reply. Position updates come from the
// engine's apply-moves endpoint (base FEN + all confirmed moves).
async function pzApply(moves) {
  return api("/api/eval_fen", { fen: PZ.baseFen, moves, movetime: 1 });
}
async function pzUserMoveLine(uci) {
  PZ.busy = true; PZ.sel = null; renderPzBoard();
  const base = PZ.played.slice();
  const expected = PZ.line[base.length];
  const prevFen = PZ.fen, prevLast = PZ.lastUci;
  let uf;
  try { uf = await pzApply([...base, uci]); }
  catch (e) { PZ.busy = false; setStatus("pzFeedback", isOffline(e) ? t("offline_msg") : t("pz_err") + e.message, true); renderPzBoard(); return; }

  if (uci !== expected) {
    if (uf && uf.fen) {
      PZ.fen = uf.fen; PZ.lastUci = uci; renderPzBoard();
      animateMove($("pzBoard"), uci.slice(0, 2), uci.slice(2, 4), "w");
      await sleep(260);
    }
    pzWrongEffect();
    await sleep(760);
    PZ.fen = prevFen; PZ.lastUci = prevLast; PZ.busy = false; renderPzBoard();
    PZ.fails = (PZ.fails || 0) + 1;
    if (PZ.fails >= (PZ.beginner ? 1 : 3)) { pzShowHint(); setStatus("pzFeedback", t("pz_autohint"), false); }
    return;
  }
  // correct — show the player's move
  PZ.played.push(uci);
  PZ.fen = uf.fen; PZ.lastUci = uci;
  PZ.legal = { legal: uf.legal || {}, turn: uf.turn, check: uf.check };
  renderPzBoard();
  animateMove($("pzBoard"), uci.slice(0, 2), uci.slice(2, 4), "w");

  if (PZ.played.length >= PZ.line.length) {   // solved: that was the last move of the line
    PZ.busy = false; PZ.legal = { legal: {} };
    await sleep(320); pzSolved(); return;
  }
  // opponent's forced reply
  const reply = PZ.line[PZ.played.length];
  PZ.played.push(reply);
  await sleep(240);
  let rf;
  try { rf = await pzApply(PZ.played); } catch (e) { rf = null; }
  if (rf && rf.fen) {
    PZ.fen = rf.fen; PZ.lastUci = reply;
    PZ.legal = { legal: rf.legal || {}, turn: rf.turn, check: rf.check };
    renderPzBoard();
    animateMove($("pzBoard"), reply.slice(0, 2), reply.slice(2, 4), "w");
  }
  if (PZ.played.length >= PZ.line.length) {   // (defensive) line ended on the reply
    PZ.busy = false; PZ.legal = { legal: {} };
    await sleep(320); pzSolved(); return;
  }
  setStatus("pzFeedback", t("pz_correct_tac"), false);
  $("pzFeedback").style.color = "#7bd88f";
  PZ.busy = false;
}

function pzSolved() {
  // ADD3: ad-hoc quiz position solved → advance the guess-the-move session and
  // stop (no PZ.list entry, no rating/streak/daily side effects).
  if (PZ.adhoc) { PZ.adhoc = null; if (PZ.quiz) { PZ.quiz = false; return qzSolved(); } return; }
  const p = PZ.list[PZ.idx];
  const firstSolve = !PZ.solved.has(p.level);
  PZ.solved.add(p.level); pzSaveSolved(); renderPzGrid();
  // ADD2: move the adaptive puzzle rating — up on a clean solve, down if the
  // player needed a hint/answer (only the first time each puzzle is decided).
  if (firstSolve && typeof pzRatingUpdate === "function") pzRatingUpdate(p.rating, !PZ.revealed);
  pzStreakInc();   // consecutive-solve streak
  if (typeof reviewSolved === "function") reviewSolved(p.level);   // advance/graduate in the review queue
  if (typeof questBump === "function") questBump("puzzles");        // daily quest progress
  if (typeof xpAdd === "function") xpAdd(5);                        // learning XP (first solve only)
  if (typeof suggestSaveProgress === "function") suggestSaveProgress();   // guests: gentle save nudge
  if (typeof metric === "function") metric("first_puzzle", { once: true });   // ADD10 funnel
  // ADD5: first product success → soft-ask to install / enable notifications
  if (typeof maybeFirstSuccessSoftAsk === "function") setTimeout(maybeFirstSuccessSoftAsk, 1200);
  // refresh visit/streak state for the conditional daily reminder
  if (typeof stampVisitState === "function") stampVisitState();
  // if this was today's daily puzzle, log it for the streak + calendar
  const wasDaily = (typeof dailyIndex === "function" && PZ.idx === dailyIndex() && !isDailySolved());
  if (wasDaily) { markDailySolved(); if (typeof xpAdd === "function") xpAdd(15); }   // daily bonus XP
  if (typeof renderDaily === "function") renderDaily();
  if (typeof checkAchievements === "function") checkAchievements();

  if (wasDaily) {   // dedicated celebration for the daily puzzle + streak
    const mile = (typeof checkStreakMilestone === "function") ? checkStreakMilestone() : 0;
    const streak = dailyStreakCount();
    showResult(mile
      ? { kind: "win", icon: "🏅", title: t("streak_mile_title").replace("{n}", mile),
          sub: t("streak_mile_sub").replace("{n}", mile),
          badge: { small: t("streak_mile_badge"), text: "🔥 " + mile, master: mile >= 100 },
          actions: [
            { label: t("daily_more_btn"), primary: true, onClick: () => loadAdaptivePuzzle() },
            { label: t("pz_theme_list_btn"), onClick: () => renderPzGrid() },
          ] }
      : { kind: "win", icon: "🗓️", title: t("daily_solved_title"),
          sub: t("daily_solved_sub").replace("{n}", streak),
          actions: [
            { label: t("daily_more_btn"), primary: true, onClick: () => loadAdaptivePuzzle() },
            { label: t("pz_theme_list_btn"), onClick: () => renderPzGrid() },
          ] });
    return;
  }
  const sub = (p.mateIn
      ? t("pz_solved_sub").replace("{n}", p.level).replace("{mate}", p.mateIn)
      : t("pz_solved_sub_tac").replace("{n}", p.level).replace("{theme}", t("pztheme_" + (p.theme || "tactic"))))
    + pzStreakSuffix();

  // ADD6: inside a prescription session → advance to the next drill instead of
  // the normal solved screen (rating/streak/quest were still awarded above).
  if (PZ.rxActive) { rxAdvance(); return; }

  // Was this the last puzzle of its theme? If so, celebrate the theme and steer
  // the player toward another theme instead of clamping on the final puzzle.
  const { start, count } = pzCatRange(PZ.cat);
  if (PZ.idx >= start + count - 1) {
    const themeName = t("pztheme_" + (p.theme || "tactic"));
    const nextCat = pzSuggestTheme(PZ.cat);
    const actions = [];
    if (nextCat != null) {
      const np = PZ.list[pzCatRange(nextCat).start];
      const nName = t("pztheme_" + ((np && np.theme) || "tactic"));
      actions.push({ label: t("pz_theme_next_btn").replace("{theme}", nName), primary: true,
        onClick: () => { PZ.cat = nextCat; loadPuzzle(pzCatRange(nextCat).start); } });
    }
    actions.push({ label: t("pz_retry_btn"), onClick: () => loadPuzzle(PZ.idx) });
    actions.push({ label: t("pz_theme_list_btn"), onClick: () => renderPzGrid() });
    showResult({
      kind: "win", icon: "🎉", title: t("pz_theme_done_title"),
      sub: t("pz_theme_done_sub").replace("{theme}", themeName) + (sub ? " · " + sub : ""),
      actions,
    });
    return;
  }

  showResult({
    kind: "win", icon: "🏆", title: t("pz_solved_title"), sub,
    actions: [
      { label: t("pz_next_btn"), primary: true, onClick: () => loadAdaptivePuzzle() },
      { label: t("pz_share_btn"), onClick: () => sharePuzzleLink(p.level) },   // ADD4 challenge link
      { label: t("pz_retry_btn"), onClick: () => loadPuzzle(PZ.idx) },
    ],
  });
}

// Suggest the next theme (category) to try after finishing `curCat`: cycle to the
// next present category, preferring one that isn't fully solved yet. Returns a cat
// number, or null if this is the only theme.
function pzSuggestTheme(curCat) {
  const cats = [...new Set(PZ.list.map((p, i) => (typeof p.cat === "number") ? p.cat : Math.floor(i / 25)))].sort((a, b) => a - b);
  if (cats.length < 2) return null;
  const solvedAll = (c) => { const { start, count } = pzCatRange(c);
    for (let i = start; i < start + count; i++) if (!PZ.solved.has(PZ.list[i].level)) return false; return true; };
  const idx = cats.indexOf(curCat);
  // first pass: next unfinished theme; fallback: just the next theme in the cycle
  for (let step = 1; step <= cats.length; step++) {
    const c = cats[(idx + step) % cats.length];
    if (c !== curCat && !solvedAll(c)) return c;
  }
  return cats[(idx + 1) % cats.length];
}

// ---- puzzle solve streak (consecutive solves; reveal-answer breaks it) ----
function pzStreak() { return +(localStorage.getItem("cc_pz_streak") || 0); }
function pzStreakBest() { return +(localStorage.getItem("cc_pz_streak_best") || 0); }
function pzStreakInc() {
  const s = pzStreak() + 1;
  localStorage.setItem("cc_pz_streak", String(s));
  if (s > pzStreakBest()) localStorage.setItem("cc_pz_streak_best", String(s));
  authSchedulePush(); renderPzStreak();
}
function pzStreakReset() { localStorage.setItem("cc_pz_streak", "0"); renderPzStreak(); }
function pzStreakSuffix() { const n = pzStreak(); return n >= 2 ? " · " + t("pzstreak_msg").replace("{n}", n) : ""; }
function renderPzStreak() {
  const el = document.getElementById("pzStreakLine"); if (!el) return;
  el.innerHTML = t("pzstreak_line").replace("{n}", pzStreak()).replace("{best}", pzStreakBest());
}
// show the next-move hint (used by the button AND auto after 3 wrong tries)
async function pzShowHint() {
  const p = PZ.adhoc || PZ.list[PZ.idx];
  PZ.revealed = true;                                            // needed help → no rating gain on solve
  if (p && p.level > 0 && typeof reviewAdd === "function") reviewAdd(p.level);   // needed help → schedule a review
  if (!p.mateIn) {                                   // tactical: hint the next move in the line
    PZ.hintSq = ((PZ.line[PZ.played.length] || p.solution[0] || "")).slice(0, 2);
    renderPzBoard(); return;
  }
  if (PZ.fen !== PZ.baseFen) await loadPuzzle(PZ.idx);
  PZ.hintSq = (p.solution[0] || "").slice(0, 2);
  renderPzBoard();
}

document.querySelectorAll("#pzCats button").forEach((b) => {
  b.onclick = () => { PZ.cat = +b.dataset.cat; loadPuzzle(pzCatRange(PZ.cat).start); };
});
if ($("pzRecommend")) $("pzRecommend").onclick = () => loadAdaptivePuzzle();
$("pzPrev").onclick = () => loadPuzzle(PZ.idx - 1);
$("pzNext").onclick = () => loadPuzzle(PZ.idx + 1);
$("pzReset").onclick = () => loadPuzzle(PZ.idx);
$("pzHint").onclick = async () => {
  await pzShowHint();
  setStatus("pzFeedback", t("pz_hint_fb"), false);
};
$("pzSolution").onclick = () => {
  const p = PZ.adhoc || PZ.list[PZ.idx];
  PZ.revealed = true;
  pzStreakReset();   // revealing the full answer breaks the streak
  setStatus("pzFeedback", t("pz_sol_fb") + (p.solutionSan || []).join(" "), false);
};

async function aiBoot() {
  loadPuzzles();
  updateRatingChip();
  renderHistory();
  updateRankBadge();
  // ADD1 (diagnostic): a brand-new player's first AI game defaults to a level
  // calibrated from their onboarding skill / rating, not the generic default.
  try {
    const hist0 = (typeof gameHistory === "function") ? gameHistory() : [];
    const solvedN0 = (typeof PZ !== "undefined" && PZ.solved) ? PZ.solved.size : 0;
    if ((!hist0 || !hist0.length) && !solvedN0 && localStorage.getItem("cc_ailevel_touched") !== "1") {
      const seed = (typeof pzRatingGet === "function") ? pzRatingGet() : ((typeof myRating === "function") ? myRating() : 400);
      const lv = aiLevelForRating(seed);
      const sel = $("aiLevel"); if (sel) sel.value = String(lv);
    }
  } catch (e) {}
  const _al = $("aiLevel");
  if (_al) _al.addEventListener("change", () => localStorage.setItem("cc_ailevel_touched", "1"));
  $("aiLevelLabel").textContent = aiLevelText($("aiLevel").value);
  // AI board is initialized lazily when the 대국 tab opens (ensureAiBoard) — no
  // need to hit /api/legal at boot for a hidden starting position.
}
// show the standard start position on the AI board the first time it's viewed
async function ensureAiBoard() {
  if (AIG.state || AIG.started) return;
  try { AIG.state = await api("/api/legal", { moves: [] }); renderAiBoard(); updateAiTurn(); }
  catch (e) { /* board stays empty until 새 대국 시작 */ }
}

// =========================================================================== //
// LEARN CHESS BASICS — visualize how each piece moves + the rules
// =========================================================================== //
function _sq(fx, fy) { return "abcdefgh"[fx] + (fy + 1); }
function _inb(x, y) { return x >= 0 && x < 8 && y >= 0 && y < 8; }
function _slide(fx, fy, dirs) {
  const out = [];
  for (const [dx, dy] of dirs) {
    let x = fx + dx, y = fy + dy;
    while (_inb(x, y)) { out.push(_sq(x, y)); x += dx; y += dy; }
  }
  return out;
}
function _steps(fx, fy, offs) {
  return offs.filter(([dx, dy]) => _inb(fx + dx, fy + dy)).map(([dx, dy]) => _sq(fx + dx, fy + dy));
}
const _DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const _ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const _ALL8 = [..._DIAG, ..._ORTHO];

function learnTopic(topic) {
  // d4 = fx 3, fy 3
  switch (topic) {
    case "pawn": return {
      title: t("learn_t_pawn"), pieces: { e2: "P", d3: "p", f3: "p" },
      moves: ["e3", "e4"], captures: ["d3", "f3"],
      desc: t("learn_d_pawn"),
    };
    case "knight": return {
      title: t("learn_t_knight"), pieces: { d4: "N" }, moves: _steps(3, 3, _KNIGHT), captures: [],
      desc: t("learn_d_knight"),
    };
    case "bishop": return {
      title: t("learn_t_bishop"), pieces: { d4: "B" }, moves: _slide(3, 3, _DIAG), captures: [],
      desc: t("learn_d_bishop"),
    };
    case "rook": return {
      title: t("learn_t_rook"), pieces: { d4: "R" }, moves: _slide(3, 3, _ORTHO), captures: [],
      desc: t("learn_d_rook"),
    };
    case "queen": return {
      title: t("learn_t_queen"), pieces: { d4: "Q" }, moves: _slide(3, 3, _ALL8), captures: [],
      desc: t("learn_d_queen"),
    };
    case "king": return {
      title: t("learn_t_king"), pieces: { d4: "K" }, moves: _steps(3, 3, _ALL8), captures: [],
      desc: t("learn_d_king"),
    };
    case "castle": return {
      title: t("learn_t_castle"), pieces: { e1: "K", h1: "R", a1: "R" }, moves: ["g1", "f1", "c1", "d1"], captures: [],
      desc: t("learn_d_castle"),
    };
    case "enpassant": return {
      title: t("learn_t_enp"), pieces: { e5: "P", d5: "p" }, moves: [], captures: ["d6"],
      desc: t("learn_d_enp"),
    };
    case "promotion": return {
      title: t("learn_t_promo"), pieces: { e7: "P" }, moves: ["e8"], captures: [],
      desc: t("learn_d_promo"),
    };
    // ---- tactical concepts (static illustrations; `atk` = attacked/key squares) ----
    case "fork": return {
      title: t("learn_t_fork"), pieces: { c7: "N", a8: "r", e8: "k" }, moves: [], captures: [], atk: ["a8", "e8"],
      desc: t("learn_d_fork"), puzzleCat: 1,
    };
    case "pin": return {
      title: t("learn_t_pin"), pieces: { b5: "B", c6: "n", e8: "k" }, moves: [], captures: [], atk: ["c6"],
      desc: t("learn_d_pin"), puzzleCat: 2,
    };
    case "skewer": return {
      title: t("learn_t_skewer"), pieces: { a1: "R", a4: "k", a6: "q" }, moves: [], captures: [], atk: ["a4", "a6"],
      desc: t("learn_d_skewer"), puzzleCat: 3,
    };
    case "discovered": return {
      title: t("learn_t_disc"), pieces: { e1: "R", e4: "N", e8: "k" }, moves: ["c5", "d6", "f6", "g5"], captures: [], atk: ["e8"],
      desc: t("learn_d_disc"), puzzleCat: 4,
    };
    case "hanging": return {
      title: t("learn_t_hang"), pieces: { d5: "n", c3: "N" }, moves: [], captures: [], atk: ["d5"],
      desc: t("learn_d_hang"), puzzleCat: 5,
    };
    case "backrank": return {
      title: t("learn_t_backrank"), pieces: { g8: "k", f7: "p", g7: "p", h7: "p", e1: "R" }, moves: ["e8"], captures: [], atk: ["g8"],
      desc: t("learn_d_backrank"), puzzleCat: 0,
    };
    // ---- endgame essentials ----
    case "kqmate": return {
      title: t("learn_t_kqmate"), pieces: { f6: "K", h8: "k", g1: "Q" }, moves: ["g7"], captures: [], atk: ["h8"],
      desc: t("learn_d_kqmate"),
    };
    case "krmate": return {
      title: t("learn_t_krmate"), pieces: { f6: "K", h8: "k", a1: "R" }, moves: ["a8"], captures: [], atk: ["h8"],
      desc: t("learn_d_krmate"),
    };
    case "opposition": return {
      title: t("learn_t_oppo"), pieces: { e6: "K", e8: "k", e5: "P" }, moves: [], captures: [], atk: [],
      desc: t("learn_d_oppo"),
    };
    default: return learnTopic("pawn");
  }
}

function renderLearnBoard(cfg) {
  const board = $("learnBoard"); board.innerHTML = "";
  const files = [..."abcdefgh"], ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  const moves = new Set(cfg.moves || []), caps = new Set(cfg.captures || []), atk = new Set(cfg.atk || []);
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      const p = (cfg.pieces || {})[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      if (moves.has(sq)) { const d = document.createElement("div"); d.className = "lmove"; div.appendChild(d); }
      if (caps.has(sq)) { const d = document.createElement("div"); d.className = "lcap"; div.appendChild(d); }
      if (atk.has(sq)) div.classList.add("latk");   // attacked/key square in a tactic lesson
      board.appendChild(div);
    }
  }
}

function showLearn(topic) {
  const cfg = learnTopic(topic);
  if (typeof setResume === "function") setResume({ kind: "learn", topic });   // ADD3 continuity
  renderLearnBoard(cfg);
  $("learnTitle").textContent = cfg.title;
  $("learnDesc").innerHTML = cfg.desc;
  // tactic lessons link straight to that theme's puzzles
  const btn = $("learnPuzzleBtn");
  if (btn) {
    if (cfg.puzzleCat != null) {
      btn.classList.remove("hidden");
      btn.onclick = () => { if (typeof practiceTheme === "function") practiceTheme(cfg.puzzleCat); };
    } else { btn.classList.add("hidden"); }
  }
}
document.querySelectorAll("#learnSel button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#learnSel button").forEach((x) => x.classList.toggle("active", x === b));
    showLearn(b.dataset.topic);
  };
});
showLearn("pawn");

// =========================================================================== //
// ONLINE MULTIPLAYER — WebSocket matchmaking + play. The server validates all
// moves and broadcasts state; this client only renders and sends intents.
// =========================================================================== //
const OG = {
  ws: null, started: false, over: false, color: null, opponent: null,
  state: null, moves: [], sel: null, orient: "w", lastUci: null, pingTimer: null,
  viewState: null, viewLast: null, viewIdx: null,
  oppRating: RATING_START, ratingApplied: false,
  gid: null, reconnecting: false, reconnectDeadline: null,   // mid-game reconnect
  fallbackTimer: null, fallbackTick: null,                   // empty-lobby → play AI
  clock: { w: 600, b: 600 }, clockSyncedAt: 0,
};

// ---- chess clock (server-authoritative; we only tick the display) ----
function ogSyncClock(state) {
  if (typeof state.clockW === "number") OG.clock = { w: state.clockW, b: state.clockB };
  OG.clockSyncedAt = performance.now();
}
function ogClockNow(color) {
  let v = color === "w" ? OG.clock.w : OG.clock.b;
  // only the side to move's clock runs
  if (OG.started && !OG.over && OG.state && OG.state.turn === color) {
    v -= (performance.now() - OG.clockSyncedAt) / 1000;
  }
  return Math.max(0, v);
}
function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

// ---- captured material from the FEN (points: P1 N3 B3 R5 Q9) ----
const PIECE_PTS = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function materialInfo(fen) {
  const cnt = {};
  for (const c of "PNBRQpnbrq") cnt[c] = 0;
  for (const ch of fen.split(" ")[0]) if (cnt[ch] !== undefined) cnt[ch]++;
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const capByWhite = [], capByBlack = [];
  let wPts = 0, bPts = 0;
  for (const t of ["q", "r", "b", "n", "p"]) {
    for (let i = 0; i < Math.max(0, start[t] - cnt[t]); i++) { capByWhite.push(t); wPts += PIECE_PTS[t]; }
    for (let i = 0; i < Math.max(0, start[t] - cnt[t.toUpperCase()]); i++) { capByBlack.push(t); bPts += PIECE_PTS[t]; }
  }
  return { capByWhite, capByBlack, wLead: wPts - bPts };
}

// ---- player bars: [profile] [name + timer side by side] ... [captured +pts] ----
function renderPbars() {
  const top = $("ogTopBar"), bottom = $("ogBottomBar");
  if (!OG.started || !OG.state) { top.classList.add("hidden"); bottom.classList.add("hidden"); return; }
  top.classList.remove("hidden"); bottom.classList.remove("hidden");
  const mat = materialInfo(OG.state.fen);
  const mine = OG.color, theirs = mine === "w" ? "b" : "w";
  const bar = (el, color, name, rating, isMe) => {
    const caps = color === "w" ? mat.capByWhite : mat.capByBlack;
    const lead = color === "w" ? mat.wLead : -mat.wLead;
    const active = OG.started && !OG.over && OG.state.turn === color;
    const t = ogClockNow(color);
    el.innerHTML =
      `<span class="pv-ava ${isMe ? "me" : ""}">${escapeHtml((name || "?").charAt(0).toUpperCase())}</span>` +
      `<span class="pv-name">${escapeHtml(name || "")}</span>` +
      `<span class="pv-rating">${ratingHTML(rating)}</span>` +
      `<span class="pv-clock ${active ? "active" : ""} ${t < 60 ? "low" : ""}">⏱ ${fmtClock(t)}</span>` +
      `<span class="pv-caps">${caps.map((c) => GLYPH[c]).join("")}` +
      `${lead > 0 ? `<b class="pv-lead">+${lead}</b>` : ""}</span>`;
  };
  bar(top, theirs, OG.opponent || t("og_opp"), OG.oppRating, false);
  bar(bottom, mine, ogName(), myRating(), true);
}
setInterval(() => { if (OG.started) renderPbars(); }, 250);

function ogSend(payload) {
  if (OG.ws && OG.ws.readyState === WebSocket.OPEN) OG.ws.send(JSON.stringify(payload));
}

function ogConnect(then) {
  if (OG.ws && OG.ws.readyState === WebSocket.OPEN) { then && then(); return; }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  OG.ws = ws;
  ws.onopen = () => {
    if (OG.pingTimer) clearInterval(OG.pingTimer);
    OG.pingTimer = setInterval(() => ogSend({ type: "ping" }), 25000); // keep proxies from closing us
    then && then();
  };
  ws.onmessage = (e) => { try { ogHandle(JSON.parse(e.data)); } catch (err) {} };
  ws.onclose = () => {
    if (OG.pingTimer) { clearInterval(OG.pingTimer); OG.pingTimer = null; }
    OG.ws = null;
    // dropped mid-game → try to resume (server holds the game for 60s) instead
    // of forfeiting. Only give up once that window elapses.
    if (OG.started && !OG.over && OG.gid) { ogTryReconnect(); }
  };
  ws.onerror = () => { setStatus("ogSetupStatus", t("og_conn_err"), true); };
}

// Reconnect after an unexpected drop: repeatedly open a socket and ask the
// server to resume our game. The server keeps it alive for 60s (our clock keeps
// running), so we retry until we're back in or the window elapses.
function ogTryReconnect() {
  if (OG.over || !OG.gid) return;
  if (!OG.reconnectDeadline) OG.reconnectDeadline = Date.now() + 60000;
  if (Date.now() >= OG.reconnectDeadline) {           // grace elapsed — truly lost
    OG.reconnecting = false; OG.reconnectDeadline = null;
    if (!OG.over) { OG.over = true; updateOgTurn(); }
    setStatus("ogStatus", t("og_disconnected"), true);
    return;
  }
  OG.reconnecting = true;
  setStatus("ogStatus", t("og_reconnecting"), true);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  OG.ws = ws;
  ws.onopen = () => {
    if (OG.pingTimer) clearInterval(OG.pingTimer);
    OG.pingTimer = setInterval(() => ogSend({ type: "ping" }), 25000);
    ogSend({ type: "resume", gid: OG.gid, token: ogToken() });
  };
  ws.onmessage = (e) => { try { ogHandle(JSON.parse(e.data)); } catch (err) {} };
  ws.onclose = () => {
    if (OG.pingTimer) { clearInterval(OG.pingTimer); OG.pingTimer = null; }
    OG.ws = null;
    if (OG.reconnecting && !OG.over) setTimeout(ogTryReconnect, 2000);
  };
  ws.onerror = () => {};
}

function ogName() { return ($("ogName").value || t("og_player")).trim().slice(0, 20) || t("og_player"); }
// auth token → the server resolves it to the account and owns the rating.
function ogToken() { return (typeof AUTH !== "undefined" && AUTH && AUTH.token) || ""; }

// it's your turn online — a triple cue (sound + haptic + board pulse) so mobile
// players don't miss their move and lose on the clock.
function ogMyTurnCue() {
  SFX.turn(); haptic([12, 30, 12]);
  const b = document.getElementById("ogBoard");
  if (b) { b.classList.remove("myturn-pulse"); void b.offsetWidth; b.classList.add("myturn-pulse"); }
}

// quick-match empty-lobby BOT BACKFILL: the queue is often empty on a small
// free-tier server, so a lone new player would wait forever. After ~15s with no
// opponent we honestly offer an AI game at a level matched to their rating —
// every first "online" tap ends in an actual game, not an empty screen.
function ogClearFallback() {
  if (OG.fallbackTimer) { clearTimeout(OG.fallbackTimer); OG.fallbackTimer = null; }
  if (OG.fallbackTick) { clearInterval(OG.fallbackTick); OG.fallbackTick = null; }
  const el = $("ogFallback"); if (el) el.classList.add("hidden");
}
function ogArmFallback() {
  ogClearFallback();
  OG.searchStart = Date.now();
  let left = 12;
  setStatus("ogSetupStatus", t("og_searching_count").replace("{n}", left));
  OG.fallbackTick = setInterval(() => {
    if (OG.started) { ogClearFallback(); return; }
    left--;
    if (left > 0) setStatus("ogSetupStatus", t("og_searching_count").replace("{n}", left));
  }, 1000);
  OG.fallbackTimer = setTimeout(() => {
    if (OG.fallbackTick) { clearInterval(OG.fallbackTick); OG.fallbackTick = null; }
    if (OG.started) return;                       // matched in the meantime
    const el = $("ogFallback"); if (el) el.classList.remove("hidden");
    setStatus("ogSetupStatus", "");
    // FIX9: the AI offer is up, but we DON'T leave the queue — a real opponent
    // can still match. Show a live elapsed timer so the wait feels transparent.
    OG.fallbackTick = setInterval(() => {
      if (OG.started) { ogClearFallback(); return; }
      const secs = Math.round((Date.now() - (OG.searchStart || Date.now())) / 1000);
      const note = document.getElementById("ogfbNote");
      if (note) note.textContent = t("og_fb_searching").replace("{n}", secs);
    }, 1000);
  }, 12000);
}
// map the player's rating to a comparable AI difficulty level (1-10)
function aiLevelForRating(r) {
  if (r < 500) return 2; if (r < 800) return 3; if (r < 1100) return 4;
  if (r < 1400) return 5; if (r < 1700) return 6; if (r < 2000) return 7;
  return 8;
}
if ($("ogFallbackBtn")) $("ogFallbackBtn").onclick = () => {
  ogSend({ type: "cancel" });                     // leave the queue cleanly
  ogClearFallback();
  $("ogCancel").classList.add("hidden");
  setStatus("ogSetupStatus", "");
  // start an AI game right away, at a level near the player's rating
  switchTab("ai");
  const lv = aiLevelForRating((typeof myRating === "function") ? myRating() : 400);
  if (typeof setAiLevel === "function") setAiLevel(lv); else { const s = $("aiLevel"); if (s) s.value = String(lv); }
  const st = $("aiStyle"); if (st) st.value = "default";
  const c960 = $("ai960"); if (c960) c960.checked = false;
  if (typeof aiStart === "function") aiStart();
};

// Matchmaking always starts on a FRESH socket: closing the old one makes the
// server clean up any stale queue/room/game state for us, so the user can
// never get stuck in "이미 대국 중입니다".
function ogFresh(then) {
  if (OG.ws) {
    try { OG.ws.onclose = null; OG.ws.close(); } catch (e) {}
    OG.ws = null;
  }
  OG.started = false; OG.over = false;
  OG.reconnecting = false; OG.reconnectDeadline = null;   // fresh match, not a resume
  ogClearFallback();
  ogConnect(then);
}

function ogHandle(msg) {
  switch (msg.type) {
    case "waiting":
      setStatus("ogSetupStatus", t("og_searching"));
      $("ogCancel").classList.remove("hidden");
      ogArmFallback();          // if nobody shows up in ~15s, offer "play AI now"
      break;
    case "room":
      $("ogCodeBox").classList.remove("hidden");
      $("ogCode").textContent = msg.code;
      setStatus("ogSetupStatus", t("og_room_wait"));
      $("ogCancel").classList.remove("hidden");
      break;
    case "cancelled":
      ogClearFallback();
      setStatus("ogSetupStatus", t("og_cancelled"));
      $("ogCancel").classList.add("hidden");
      $("ogCodeBox").classList.add("hidden");
      break;
    case "start":
      ogClearFallback();
      OG.started = true; OG.over = false; OG.ratingApplied = false;
      OG.gid = msg.gid || null; OG.reconnecting = false; OG.reconnectDeadline = null;
      OG.oppRating = +(msg.opponentRating || RATING_START);
      OG.color = msg.color; OG.orient = msg.color;
      OG.opponent = msg.opponent || t("og_opp");
      OG.state = msg.state; OG.moves = msg.state.moves || []; OG.sel = null; OG.lastUci = null;
      ogSyncClock(msg.state);
      $("ogSetup").classList.add("hidden");
      $("ogGameInfo").classList.remove("hidden");
      $("ogCancel").classList.add("hidden"); $("ogCodeBox").classList.add("hidden");
      $("ogVs").innerHTML = `${escapeHtml(ogName())} (${ratingHTML(myRating())}) vs ${escapeHtml(OG.opponent)} (${ratingHTML(OG.oppRating)})`;
      $("ogColorInfo").textContent = t("og_you_are").replace("{side}", OG.color === "w" ? t("og_first") : t("og_second"));
      setStatus("ogStatus", t("og_start_luck"));
      setStatus("ogSetupStatus", "");
      ogEnterGame();
      renderOgBoard(); renderOgMoves(); updateOgTurn(); renderPbars();
      break;
    case "state":
      OG.state = msg.state; OG.moves = msg.state.moves || []; OG.sel = null;
      OG.viewState = null; OG.viewIdx = null; OG.viewLast = null;   // a new move snaps back to live
      OG.lastUci = msg.lastUci || null;
      ogSyncClock(msg.state);
      $("ogDrawPrompt").classList.add("hidden");   // a move voids any pending draw offer
      renderOgBoard(); renderOgMoves(); updateOgTurn(); renderPbars();
      if (OG.lastUci) animateMove($("ogBoard"), OG.lastUci.slice(0, 2), OG.lastUci.slice(2, 4), OG.orient);
      playMoveSfx(OG.state);
      // it's now MY turn (opponent just moved) → cue so I don't miss it and flag
      if (!OG.over && OG.state.turn === OG.color) ogMyTurnCue();
      break;
    case "draw_offered":
      $("ogDrawPrompt").classList.remove("hidden");
      break;
    case "draw_declined":
      setStatus("ogStatus", t("og_draw_declined"), true);
      break;
    case "chat":
      ogAppendChat(OG.opponent || t("og_opp"), msg.text || "", false);
      break;
    case "end":
      // a real result ends the game for good — stop any reconnect attempts
      OG.reconnecting = false; OG.reconnectDeadline = null;
      ogEnd(msg.result, msg.reason, msg.rating);
      break;
    case "opp_disconnected":
      setStatus("ogStatus", t("og_opp_disconnected").replace("{s}", msg.seconds || 60), true);
      break;
    case "opp_reconnected":
      setStatus("ogStatus", t("og_opp_reconnected"));
      break;
    case "resume_ok":
      OG.reconnecting = false; OG.reconnectDeadline = null;
      OG.started = true; OG.over = false;
      OG.gid = msg.gid || OG.gid;
      OG.color = msg.color; OG.orient = msg.color;
      OG.opponent = msg.opponent || t("og_opp");
      OG.oppRating = +(msg.opponentRating || RATING_START);
      OG.state = msg.state; OG.moves = (msg.state && msg.state.moves) || []; OG.sel = null; OG.lastUci = null;
      OG.viewState = null; OG.viewIdx = null; OG.viewLast = null;
      ogSyncClock(msg.state);
      $("ogSetup").classList.add("hidden");
      $("ogGameInfo").classList.remove("hidden");
      $("ogCancel").classList.add("hidden"); $("ogCodeBox").classList.add("hidden");
      $("ogVs").innerHTML = `${escapeHtml(ogName())} (${ratingHTML(myRating())}) vs ${escapeHtml(OG.opponent)} (${ratingHTML(OG.oppRating)})`;
      ogEnterGame();
      renderOgBoard(); renderOgMoves(); updateOgTurn(); renderPbars();
      setStatus("ogStatus", t("og_reconnected"));
      break;
    case "resume_fail":
      // maybe the server hasn't noticed our old socket drop yet — retry within
      // the window; only surface failure once the 60s grace has elapsed.
      if (OG.reconnecting && OG.reconnectDeadline && Date.now() < OG.reconnectDeadline) {
        try { if (OG.ws) { OG.ws.onclose = null; OG.ws.close(); } } catch (e) {}
        OG.ws = null;
        setTimeout(ogTryReconnect, 2500);
      } else {
        OG.reconnecting = false; OG.reconnectDeadline = null;
        if (!OG.over) { OG.over = true; updateOgTurn(); }
        setStatus("ogStatus", t("og_resume_fail"), true);
      }
      break;
    case "error":
      setStatus(OG.started ? "ogStatus" : "ogSetupStatus", msg.message || t("og_error"), true);
      break;
  }
}

function renderOgBoard() {
  const board = $("ogBoard"); board.innerHTML = "";
  const viewing = !!OG.viewState;
  const st = viewing ? OG.viewState : OG.state; if (!st) return;
  const map = parseFen(st.fen);
  const files = OG.orient === "w" ? [..."abcdefgh"] : [..."hgfedcba"];
  const ranks = OG.orient === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const lastUci = viewing ? OG.viewLast : OG.lastUci;
  const lf = lastUci ? lastUci.slice(0, 2) : null, lt = lastUci ? lastUci.slice(2, 4) : null;
  const myTurn = !viewing && OG.started && !OG.over && st.turn === OG.color;
  const legal = myTurn ? (st.legal || {}) : {};
  let kingSq = null;
  if (st.check) { const kc = st.turn === "w" ? "K" : "k"; for (const s in map) if (map[s] === kc) kingSq = s; }
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      if (sq === lf || sq === lt) div.classList.add("last");
      if (!viewing && OG.sel === sq) div.classList.add("sel");
      if (sq === kingSq) div.classList.add("check");
      const p = map[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      if (SETTINGS.showDots && OG.sel && legal[OG.sel] && legal[OG.sel].includes(sq)) {
        const d = document.createElement("div"); d.className = "dot" + (map[sq] ? " cap" : "");
        div.appendChild(d);
      }
      addCoords(div, f, rank, files, ranks);
      div.dataset.sq = sq;
      div.onclick = () => onOgClick(sq);
      board.appendChild(div);
    }
  }
}

function onOgClick(sq) {
  if (_dragJustMoved) return;
  if (OG.viewState) { ogViewLive(); return; }        // browsing history → snap back to live
  const st = OG.state;
  if (!OG.started || OG.over || !st || st.turn !== OG.color) return;
  const map = parseFen(st.fen), legal = st.legal || {};
  if (OG.sel) {
    if (legal[OG.sel] && legal[OG.sel].includes(sq)) {
      const from = OG.sel, piece = map[from], r = +sq[1];
      OG.sel = null;
      if (piece && piece.toLowerCase() === "p" && (r === 8 || r === 1)) {
        promoChooser($("ogBoard"), piece === "P", (pp) => ogSend({ type: "move", uci: from + sq + pp }));
      } else {
        ogSend({ type: "move", uci: from + sq });
      }
      renderOgBoard();
      return;
    }
    if (legal[sq]) { OG.sel = sq; renderOgBoard(); return; }
    OG.sel = null; renderOgBoard(); return;
  }
  if (legal[sq]) { OG.sel = sq; renderOgBoard(); }
}

function renderOgMoves() {
  const el = $("ogMoves");
  const san = (OG.state && OG.state.san) ? OG.state.san : [];
  if (!san.length) { el.innerHTML = `<span class="num">${t("og_moves_empty")}</span>`; }
  else {
    let html = "";
    san.forEach((s, i) => {
      if (i % 2 === 0) html += `<span class="num">${i / 2 + 1}.</span>`;
      html += `<span class="mv" style="cursor:default">${s}</span> `;
    });
    el.innerHTML = html; el.scrollTop = el.scrollHeight;
  }
  renderMoveStrip("ogMoveStrip", san);
  if (typeof updateOgNav === "function") updateOgNav();
  updateOpeningLine("ogOpening", OG.moves);
}

function updateOgTurn() {
  const el = $("ogTurn"), st = OG.state;
  const T = (typeof t === "function") ? t : ((k) => k);
  if (!OG.started || !st) { el.innerHTML = '<span class="pill"></span>' + T("og_turn_wait"); return; }
  if (OG.over) { el.innerHTML = "<b>" + T("turn_over") + "</b>"; return; }
  const w = st.turn === "w", mine = st.turn === OG.color;
  el.innerHTML = `<span class="pill ${w ? "" : "b"}"></span>${w ? T("turn_white") : T("turn_black")}` +
    (mine ? " " + T("turn_you") : ` (${escapeHtml(OG.opponent || t("og_opp"))})`) +
    (st.check ? ` · <b style='color:#ff8a80'>${T("turn_check")}</b>` : "");
}

function ogEnd(result, reason, rInfo) {
  OG.over = true; ogExitGame(); renderOgBoard(); updateOgTurn();
  let kind = "draw";
  if (result === "1-0") kind = OG.color === "w" ? "win" : "loss";
  else if (result === "0-1") kind = OG.color === "b" ? "win" : "loss";
  const reasonTxt = { checkmate: t("og_r_checkmate"), resign: t("og_r_resign"), forfeit: t("og_r_forfeit"), timeout: t("og_r_timeout"), agreement: t("og_r_agreement"), draw: t("og_r_draw") }[reason] || "";
  const me = ogName();
  const white = OG.color === "w" ? me : (OG.opponent || t("og_opp"));
  const black = OG.color === "b" ? me : (OG.opponent || t("og_opp"));
  const movesCopy = [...OG.moves];
  const actions = [];
  if (movesCopy.length) {
    const reviewReq = { moves: movesCopy, white, black, movetime: REVIEW_MT, human: OG.color };
    prefetchAnalyze(reviewReq).catch(() => {});   // start analysis now → instant review
    actions.push({ label: t("ai_review_btn"), primary: true,
      onClick: () => runAnalyze(reviewReq, "ogStatus") });
  }
  actions.push({ label: t("og_new_match"), onClick: ogReset });
  const _nextOg = (typeof nextTodoAction === "function") ? nextTodoAction(["📊"]) : null;   // ADD9
  if (_nextOg) actions.push(_nextOg);
  actions.push({ label: t("card_share"), onClick: () => shareResultCard({
    icon: kind === "win" ? "🏆" : kind === "loss" ? "😢" : "🤝",
    title: kind === "win" ? t("res_win") : kind === "loss" ? t("res_loss") : t("res_draw"),
    sub: "vs " + (OG.opponent || t("og_opp")), fen: OG.state && OG.state.fen }) });

  // Rating changes ONLY here — an online match result. Apply exactly once.
  // The SERVER is authoritative: it sends this player's {before, after, delta}
  // in the end message. We only fall back to a client estimate if it's absent
  // (e.g. a guest game, or an older server).
  let badge = null;
  if (!OG.ratingApplied) {
    OG.ratingApplied = true;
    let before, newRating, applied;
    if (rInfo && typeof rInfo.after === "number") {
      before = rInfo.before; newRating = rInfo.after; applied = rInfo.delta;
    } else {
      before = myRating();
      const score = kind === "win" ? 1 : kind === "loss" ? 0 : 0.5;
      newRating = Math.max(0, before + eloDelta(before, OG.oppRating, score));
      applied = newRating - before;   // what actually changed (0-floor aware)
    }
    setMyRating(newRating);
    addHistory({ mode: "online", opponent: OG.opponent || t("og_opp"), result: kind, ratingDelta: applied,
      moves: [...movesCopy], white, black });
    badge = { small: t("og_rating_change"), text: `${applied >= 0 ? "+" + applied : applied} → ${ratingHTML(newRating)}` };
    setTimeout(loadLeaderboard, 1600);   // after the debounced progress push lands
  }

  const T = (typeof t === "function") ? t : ((k) => k);
  const opts = kind === "win"
    ? { kind, icon: "🏆", title: T("res_win"), sub: T("og_won_sub").replace("{opp}", OG.opponent).replace("{reason}", reasonTxt) + streakSuffix(), badge, actions }
    : kind === "loss"
      ? { kind, icon: "😢", title: T("res_loss"), sub: T("og_lost_sub").replace("{opp}", OG.opponent).replace("{reason}", reasonTxt), badge, actions }
      : { kind, icon: "🤝", title: T("res_draw"), sub: T("og_drew_sub").replace("{opp}", OG.opponent), badge, actions };
  setStatus("ogStatus", T("og_game_end").replace("{result}", result).replace("{reason}", reasonTxt));
  presentResult(opts);
}

function ogReset() {
  hideResult();
  OG.started = false; OG.over = false; OG.color = null; OG.opponent = null;
  OG.gid = null; OG.reconnecting = false; OG.reconnectDeadline = null;
  OG.state = null; OG.moves = []; OG.sel = null; OG.lastUci = null;
  $("ogSetup").classList.remove("hidden");
  $("ogGameInfo").classList.add("hidden");
  $("ogCodeBox").classList.add("hidden");
  $("ogCancel").classList.add("hidden");
  $("ogTopBar").classList.add("hidden");
  $("ogBottomBar").classList.add("hidden");
  $("ogDrawPrompt").classList.add("hidden");
  ogExitGame();
  updateOgAuthGate();
  setStatus("ogStatus", ""); setStatus("ogSetupStatus", "");
  renderOgBoard(); renderOgMoves(); updateOgTurn();
  switchTab("online");
}

$("ogQuick").onclick = () => {
  if (!requireLogin()) return;
  setStatus("ogSetupStatus", t("og_connecting"));
  ogFresh(() => ogSend({ type: "quick", name: ogName(), rating: myRating(), token: ogToken() }));
};
$("ogCreate").onclick = () => {
  if (!requireLogin()) return;
  setStatus("ogSetupStatus", t("og_connecting"));
  ogFresh(() => ogSend({ type: "create", name: ogName(), rating: myRating(), token: ogToken() }));
};
$("ogJoin").onclick = () => {
  if (!requireLogin()) return;
  const code = ($("ogJoinCode").value || "").trim().toUpperCase();
  if (code.length !== 4) { setStatus("ogSetupStatus", t("og_code_len"), true); return; }
  setStatus("ogSetupStatus", t("og_joining"));
  ogFresh(() => ogSend({ type: "join", code, name: ogName(), rating: myRating(), token: ogToken() }));
};
$("ogCancel").onclick = () => ogSend({ type: "cancel" });
$("ogResign").onclick = () => {
  if (!OG.started || OG.over) { setStatus("ogStatus", t("og_no_game"), true); return; }
  ogSend({ type: "resign" });
};
$("ogDraw").onclick = () => {
  if (!OG.started || OG.over) { setStatus("ogStatus", t("og_no_game"), true); return; }
  ogSend({ type: "draw_offer" });
  setStatus("ogStatus", t("og_draw_sent"));
};
$("ogDrawAccept").onclick = () => { ogSend({ type: "draw_accept" }); $("ogDrawPrompt").classList.add("hidden"); };
$("ogDrawDecline").onclick = () => { ogSend({ type: "draw_decline" }); $("ogDrawPrompt").classList.add("hidden"); };
$("ogFlip").onclick = () => { OG.orient = OG.orient === "w" ? "b" : "w"; renderOgBoard(); };

// ---- online in-game move navigation (view earlier moves only) ----
async function ogView(idx) {
  if (!OG.started) return;
  const total = OG.moves.length;
  idx = Math.max(0, Math.min(total, idx));
  if (idx === total) { ogViewLive(); return; }
  let st;
  try { st = await api("/api/legal", { moves: OG.moves.slice(0, idx) }); }
  catch (e) { return; }
  OG.viewIdx = idx; OG.viewState = st; OG.viewLast = idx > 0 ? OG.moves[idx - 1] : null; OG.sel = null;
  renderOgBoard(); updateOgNav();
}
function ogViewLive() {
  OG.viewIdx = null; OG.viewState = null; OG.viewLast = null;
  renderOgBoard(); updateOgNav();
}
function updateOgNav() {
  const total = OG.moves.length;
  const cur = OG.viewIdx == null ? total : OG.viewIdx;
  const prev = $("ogPrev"), next = $("ogNext"), strip = $("ogMoveStrip");
  if (prev) prev.disabled = cur <= 0;
  if (next) next.disabled = cur >= total;
  if (strip) strip.classList.toggle("viewing", OG.viewIdx != null);
}
if ($("ogPrev")) $("ogPrev").onclick = () => ogView((OG.viewIdx == null ? OG.moves.length : OG.viewIdx) - 1);
if ($("ogNext")) $("ogNext").onclick = () => ogView((OG.viewIdx == null ? OG.moves.length : OG.viewIdx) + 1);

// ---- login gate: online rated play requires an account ----
function openAuth() { $("authModal").classList.remove("hidden"); setStatus("authStatus", ""); $("authId").focus(); }
function updateOgAuthGate() {
  const gate = $("ogLoginGate"), body = $("ogMatchBody");
  if (!gate || !body) return;
  const on = !!AUTH.token;
  gate.classList.toggle("hidden", on);
  body.classList.toggle("hidden", !on);
  if (on && $("ogName")) $("ogName").value = AUTH.id || t("og_player");
}
$("ogLoginBtn").onclick = openAuth;
function requireLogin() {
  if (AUTH.token) return true;
  setStatus("ogSetupStatus", t("og_login_first"), true);
  openAuth();
  return false;
}

// ---- immersive in-game mode (hide menus) ----
function ogEnterGame() {
  document.body.classList.add("ingame");
  $("ogChat").classList.add("hidden");   // minimal by default; opened via the 💬 toggle
  $("ogChatLog").innerHTML = "";
}
function ogExitGame() {
  document.body.classList.remove("ingame");
  $("ogChat").classList.add("hidden");
}
$("ogChatToggle").onclick = () => $("ogChat").classList.toggle("hidden");

// ---- in-game chat ----
function ogAppendChat(who, text, me) {
  const log = $("ogChatLog");
  const d = document.createElement("div");
  d.className = "chatmsg" + (me ? " me" : "");
  d.innerHTML = `<b>${escapeHtml(who)}</b> ${escapeHtml(text)}`;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function ogSendChat() {
  const inp = $("ogChatInput"), t = (inp.value || "").trim();
  if (!t || !OG.started || OG.over) return;
  ogSend({ type: "chat", text: t });
  ogAppendChat(AUTH.id || (typeof window.t === "function" ? window.t("og_me") : "나"), t, true);
  inp.value = "";
}
$("ogChatSend").onclick = ogSendChat;
$("ogChatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ogSendChat(); } });

// =========================================================================== //
// ACCOUNTS — register/login with id+password; progress lives on the server.
// Register uploads this device's current progress; login pulls the account's
// progress down (overwriting local); while logged in every change is pushed
// (debounced) via authSchedulePush() calls in the setters above.
// =========================================================================== //
const AUTH = {
  token: localStorage.getItem("cc_token") || null,
  id: localStorage.getItem("cc_uid") || null,
  pushTimer: null,
};

function collectProgress() {
  return {
    rating: myRating(),
    history: gameHistory(),
    bestLevel: bestLevel(),
    puzzles: [...PZ.solved],
    bestStreak: bestStreak(),
    pzStreak: pzStreak(),
    pzStreakBest: pzStreakBest(),
    achievements: [...achUnlocked()],
    dailySolved: (typeof dailySolvedDates === "function") ? dailySolvedDates() : [],
    freezeDates: (typeof frozenDates === "function") ? frozenDates() : [],
    streakMiles: (typeof streakMilesReached === "function") ? streakMilesReached() : [],
    reviewQueue: (typeof reviewQueue === "function") ? reviewQueue() : {},
    xp: (typeof xpGet === "function") ? xpGet() : 0,
    pzRating: (typeof pzRatingGet === "function") ? pzRatingGet() : 0,
    referred_by: localStorage.getItem("cc_ref") || undefined,   // ADD4: attribution
  };
}

function applyProgress(p) {
  p = p || {};
  if (typeof p.rating === "number") localStorage.setItem("cc_rating3", String(Math.max(0, Math.round(p.rating))));
  if (Array.isArray(p.history)) localStorage.setItem("cc_history", JSON.stringify(p.history));
  if (typeof p.bestLevel === "number") localStorage.setItem("cc_best_level", String(p.bestLevel));
  if (typeof p.bestStreak === "number") localStorage.setItem("cc_streak_best", String(Math.max(p.bestStreak, bestStreak())));
  // daily-puzzle streak: keep the most advanced (later date / higher best)
  if (typeof p.pzStreak === "number") localStorage.setItem("cc_pz_streak", String(Math.max(p.pzStreak, pzStreak())));
  if (typeof p.pzStreakBest === "number") localStorage.setItem("cc_pz_streak_best", String(Math.max(p.pzStreakBest, pzStreakBest())));
  if (Array.isArray(p.puzzles)) {
    localStorage.setItem("cc_puzzles_solved", JSON.stringify(p.puzzles));
    PZ.solved = new Set(p.puzzles);
  }
  if (Array.isArray(p.achievements)) {
    const merged = new Set([...achUnlocked(), ...p.achievements]);   // union across devices
    localStorage.setItem("cc_achievements", JSON.stringify([...merged]));
  }
  if (Array.isArray(p.dailySolved)) {   // union daily-solved dates across devices
    const cur = (typeof dailySolvedDates === "function") ? dailySolvedDates() : [];
    const merged = [...new Set([...cur, ...p.dailySolved])].sort();
    localStorage.setItem("cc_daily_solved", JSON.stringify(merged));
  }
  if (Array.isArray(p.freezeDates)) {   // union streak-freeze days across devices
    const cur = (typeof frozenDates === "function") ? frozenDates() : [];
    localStorage.setItem("cc_freeze_dates", JSON.stringify([...new Set([...cur, ...p.freezeDates])].sort()));
  }
  if (Array.isArray(p.streakMiles)) {   // union reached milestones
    const cur = (typeof streakMilesReached === "function") ? streakMilesReached() : [];
    localStorage.setItem("cc_streak_miles", JSON.stringify([...new Set([...cur, ...p.streakMiles])].sort((a, b) => a - b)));
  }
  if (typeof p.xp === "number") localStorage.setItem("cc_xp", String(Math.max(p.xp, (typeof xpGet === "function") ? xpGet() : 0)));
  if (typeof p.pzRating === "number" && p.pzRating > 0) localStorage.setItem("cc_pz_rating", String(Math.round(p.pzRating)));
  if (p.reviewQueue && typeof p.reviewQueue === "object") {   // merge review queue (keep more-graduated box)
    const cur = (typeof reviewQueue === "function") ? reviewQueue() : {};
    const merged = { ...cur };
    for (const lv in p.reviewQueue) {
      const a = merged[lv], b = p.reviewQueue[lv];
      if (!a || (b && (b.box || 0) > (a.box || 0))) merged[lv] = b;
    }
    localStorage.setItem("cc_review_queue", JSON.stringify(merged));
  }
  updateRatingChip(); renderHistory(); updateRankBadge();
  if (typeof renderAchievements === "function") renderAchievements();
  if (typeof renderDaily === "function") renderDaily();
  if (PZ.list.length) renderPzGrid();
  // Refresh every progress-driven view so a freshly loaded account's numbers
  // (home hub stats, XP/quests/league, growth report) replace the old account's
  // on screen immediately — not just in storage.
  if (typeof renderHome === "function") renderHome();
  if (typeof renderGrowth === "function") renderGrowth();
  if (typeof renderPzRatingLine === "function") renderPzRatingLine();
}

function authSchedulePush() {
  if (!AUTH.token) return;
  clearTimeout(AUTH.pushTimer);
  AUTH.pushTimer = setTimeout(async () => {
    try { await api("/api/auth/save", { token: AUTH.token, progress: collectProgress() }); }
    catch (e) { if (/세션/.test(e.message || "")) authClearSession(); }
  }, 800);
}

// Wipe all per-account progress from this device so the NEXT account (or guest)
// starts clean — otherwise the previous user's XP/streaks/puzzles leak in via the
// cross-device merge logic in applyProgress.
function clearLocalProgress() {
  ["cc_rating3", "cc_history", "cc_best_level", "cc_streak_best", "cc_pz_streak",
   "cc_pz_streak_best", "cc_puzzles_solved", "cc_achievements", "cc_daily_solved",
   "cc_freeze_dates", "cc_streak_miles", "cc_review_queue", "cc_xp", "cc_quests", "cc_skill",
   "cc_pz_rating", "cc_league",
  ].forEach((k) => localStorage.removeItem(k));
  if (typeof PZ !== "undefined") PZ.solved = new Set();
}
function authClearSession() {
  AUTH.token = null; AUTH.id = null;
  localStorage.removeItem("cc_token"); localStorage.removeItem("cc_uid");
  clearLocalProgress();                       // fresh slate for the next user
  renderAuthArea();
  updateRatingChip();
  if (typeof renderHistory === "function") renderHistory();
  if (typeof renderHome === "function") renderHome();
  if (typeof PZ !== "undefined" && PZ.list && PZ.list.length && typeof renderPzGrid === "function") renderPzGrid();
  if (typeof updateOgAuthGate === "function") updateOgAuthGate();
  // now signed out — offer the login gate again (clear the "guest this session"
  // suppression so it actually reappears after an explicit logout).
  sessionStorage.removeItem("cc_guest");
  if (typeof maybeShowLoginGate === "function") maybeShowLoginGate();
}

function authSetSession(id, token, progress, opts) {
  AUTH.id = id; AUTH.token = token;
  if (typeof hideLoginGate === "function") hideLoginGate();
  localStorage.setItem("cc_token", token); localStorage.setItem("cc_uid", id);
  // Switching INTO an account: wipe whatever the previous account / guest left in
  // localStorage FIRST, so the max/union merge in applyProgress can't leak the old
  // account's XP, streaks, puzzles, league, etc. into the new one. (Register passes
  // keepLocal — the just-built guest progress is what's being uploaded and echoed
  // back in `progress`, so there's nothing stale to clear.)
  if (!(opts && opts.keepLocal) && typeof clearLocalProgress === "function") clearLocalProgress();
  applyProgress(progress);
  const nick = $("ogName"); if (nick) nick.value = id;   // nickname = account id
  renderAuthArea();
  updateRatingChip();
  if (typeof updateOgAuthGate === "function") updateOgAuthGate();
}

function renderAuthArea() {
  const el = $("authArea"); if (!el) return;
  if (AUTH.token) {
    // ADD1: the identity chip doubles as the entry to the settings/identity hub
    el.innerHTML = `<button class="user-chip" id="userChip" title="${t("tt_settings")}">👤 <b>${escapeHtml(AUTH.id || "")}</b></button>` +
      `<button class="ghost" id="authLogout">${t("auth_logout")}</button>`;
    if ($("userChip")) $("userChip").onclick = () => { const s = $("settingsBtn"); if (s) s.click(); };
    $("authLogout").onclick = async () => {
      try { await api("/api/auth/logout", { token: AUTH.token }); } catch (e) {}
      authClearSession();
    };
  } else {
    el.innerHTML = `<button class="ghost" id="authOpen">${t("auth_open")}</button>`;
    $("authOpen").onclick = () => {
      $("authModal").classList.remove("hidden");
      setStatus("authStatus", "");
      $("authId").focus();
    };
  }
}

async function authSubmit(mode) {
  // NFC-normalize so Korean typed as decomposed jamo (iOS/macOS) matches what
  // was stored at registration — otherwise a correct id/pw can be rejected.
  const id = ($("authId").value || "").trim().normalize("NFC");
  const pw = ($("authPw").value || "").normalize("NFC");
  if (!id || !pw) { setStatus("authStatus", t("auth_need"), true); return; }
  // signup requires agreeing to the Terms + Privacy Policy
  if (mode === "register" && $("authConsent") && !$("authConsent").checked) {
    setStatus("authStatus", t("auth_consent_req"), true);
    const row = $("authConsentRow"); if (row) { row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
    return;
  }
  setStatus("authStatus", mode === "register" ? t("auth_registering") : t("auth_logging"));
  try {
    const email = ($("authEmail") ? ($("authEmail").value || "").trim() : "");
    let body;
    if (mode === "register") {
      const prog = collectProgress();
      prog.agreedTermsAt = new Date().toISOString();   // record consent (proof) with the account
      body = { id, pw, email, progress: prog };
    } else { body = { id, pw }; }
    const r = await api("/api/auth/" + mode, body);
    // register keeps the guest progress it just uploaded; login replaces local
    // wholesale so a previous account's data can't bleed into this one.
    authSetSession(r.id, r.token, r.progress, { keepLocal: mode === "register" });
    $("authModal").classList.add("hidden");
    $("authPw").value = "";
    // show the recovery code to save ONLY when no email was given (email is the recovery path)
    if (mode === "register" && r.recovery && !r.hasEmail) {
      const T = (typeof t === "function") ? t : ((k) => k);
      alert(T("recovery_saved") + "\n\n    " + r.recovery);
    }
    // brand-new account → ask their skill level to seed the starting rating
    if (mode === "register") { showSkillModal(); if (typeof metric === "function") metric("signup"); }   // ADD10 funnel
  } catch (e) {
    setStatus("authStatus", isOffline(e) ? t("offline_msg") : e.message, true);
  }
}

// forgot password → email a code to the account's email; fall back to recovery code
async function authReset() {
  const T = (typeof t === "function") ? t : ((k) => k);
  const id = (($("authId").value || "").trim() || prompt(T("reset_id")) || "").trim().normalize("NFC");
  if (!id) return;
  let emailed = false;
  try {
    const rr = await api("/api/auth/request_reset", { id });
    emailed = !!rr.emailed;
  } catch (e) {}
  const code = prompt(emailed ? T("reset_email_prompt") : T("reset_code"));
  if (!code) return;
  const pw = prompt(T("reset_newpw")); if (!pw) return;
  try {
    const r = await api("/api/auth/reset", { id, code: code.trim(), pw: (pw || "").normalize("NFC") });
    authSetSession(r.id, r.token, r.progress);
    $("authModal").classList.add("hidden");
    alert(T("reset_done"));
  } catch (e) {
    alert(isOffline(e) ? t("offline_msg") : (e.message || t("reset_fail")));
  }
}

$("authLoginBtn").onclick = () => authSubmit("login");
$("authRegisterBtn").onclick = () => authSubmit("register");
$("authForgot").onclick = (e) => { e.preventDefault(); authReset(); };
$("authCloseBtn").onclick = () => $("authModal").classList.add("hidden");
$("authPw").addEventListener("keydown", (e) => { if (e.key === "Enter") authSubmit("login"); });

// ---- first-open login gate: sign in, or continue as guest ----
function hideLoginGate() { const g = $("loginGate"); if (g) g.classList.add("hidden"); }
if ($("gateGuestBtn")) $("gateGuestBtn").onclick = () => { sessionStorage.setItem("cc_guest", "1"); hideLoginGate(); };
if ($("gateLoginBtn")) $("gateLoginBtn").onclick = () => { hideLoginGate(); openAuth(); };

// First-ever entry: no login WALL. Land the visitor on the app; only ask their
// skill once (so difficulty matches) — guest included. Account sign-up is
// suggested later, after their first success (see suggestSaveProgress).
function maybeFirstEntry() {
  if (AUTH.token) return;
  if (localStorage.getItem("cc_skill") || localStorage.getItem("cc_skill_seen")) return;
  localStorage.setItem("cc_skill_seen", "1");
  if (typeof showSkillModal === "function") showSkillModal();
}
// After a first win / first solve, gently offer to save progress (guests only,
// once per session) — the "저장할 게 생긴 뒤" moment, not a boot wall. Uses a
// dismissible top banner so it never blocks or stacks over the result screen.
function suggestSaveProgress() {
  if (AUTH.token) return;
  if (sessionStorage.getItem("cc_savenudge") === "1") return;
  sessionStorage.setItem("cc_savenudge", "1");
  const b = document.getElementById("saveBanner"); if (b) b.classList.remove("hidden");
}
if ($("saveBannerBtn")) $("saveBannerBtn").onclick = () => { const b = $("saveBanner"); if (b) b.classList.add("hidden"); openAuth(); };
if ($("saveBannerClose")) $("saveBannerClose").onclick = () => { const b = $("saveBanner"); if (b) b.classList.add("hidden"); };

// ---- first-signup onboarding: pick skill → seed starting rating ----
function showSkillModal() { const m = $("skillModal"); if (m) m.classList.remove("hidden"); }
function hideSkillModal() { const m = $("skillModal"); if (m) m.classList.add("hidden"); }
// map the seeded rating → a coarse skill bucket, stored so the home CTA can route
// true beginners to lessons instead of a checkmate puzzle (see pickToday).
function skillFromRating(r) { return r <= 250 ? "new" : r <= 700 ? "beg" : r <= 1000 ? "mid" : "adv"; }
document.querySelectorAll("#skillModal .skill-opt").forEach((btn) => {
  btn.onclick = () => {
    const r = +btn.getAttribute("data-rating") || RATING_START;
    setMyRating(r);
    localStorage.setItem("cc_skill", skillFromRating(r));
    hideSkillModal();
    if (typeof renderHome === "function") renderHome();   // refresh the "today" CTA for the new skill
  };
});
if ($("skillSkip")) $("skillSkip").onclick = () => { localStorage.setItem("cc_skill", "beg"); hideSkillModal(); if (typeof renderHome === "function") renderHome(); };

// =========================================================================== //
// LEADERBOARD — top registered accounts by rating (server-computed)
// =========================================================================== //
const LB = { data: null, mode: "rating" };
async function loadLeaderboard() {
  const el = $("lbList"); if (!el) return;
  try {
    LB.data = await (await fetch("/api/leaderboard")).json();
    if ($("lbTotal")) $("lbTotal").textContent = LB.data.total ? t("lb_total").replace("{n}", LB.data.total) : "";
    renderLeaderboard();
  } catch (e) {
    el.innerHTML = `<div class="hist-empty">${t("lb_fail")}</div>`;
  }
}
function renderLeaderboard() {
  const el = $("lbList"); if (!el || !LB.data) return;
  const list = LB.mode === "puzzles" ? (LB.data.topPuzzles || [])
    : LB.mode === "streak" ? (LB.data.topStreak || [])
    : (LB.data.top || []);
  const empty = LB.mode === "rating" ? "lb_empty" : "lb_empty_pz";
  if (!list.length) { el.innerHTML = `<div class="hist-empty">${t(empty)}</div>`; return; }
  const medal = (i) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
  const valHTML = (e) => LB.mode === "puzzles"
      ? `<b class="lb-rating">${t("lb_val_puzzles").replace("{n}", e.puzzles)}</b>`
    : LB.mode === "streak"
      ? `<b class="lb-rating">🔥 ${e.pzStreakBest}</b>`
      : `<b class="lb-rating">${ratingHTML(e.rating)}</b>`;
  el.innerHTML = list.map((e, i) => {
    const me = AUTH.id && e.id === AUTH.id;
    return `<div class="lb-row ${me ? "me" : ""}">` +
      `<span class="lb-rank">${medal(i)}</span>` +
      `<span class="lb-name">${escapeHtml(e.id)}${me ? " " + t("lb_me") : ""}</span>` +
      valHTML(e) + `</div>`;
  }).join("");
}
document.querySelectorAll("#lbTabs .lbtab").forEach((b) => {
  b.onclick = () => {
    LB.mode = b.dataset.lb;
    document.querySelectorAll("#lbTabs .lbtab").forEach((x) => x.classList.toggle("active", x === b));
    renderLeaderboard();
  };
});

async function authBoot() {
  renderAuthArea();
  updateOgAuthGate();
  if (!AUTH.token) { maybeFirstEntry(); return; }
  try {
    const r = await api("/api/auth/load", { token: AUTH.token });
    AUTH.id = r.id; localStorage.setItem("cc_uid", r.id);
    applyProgress(r.progress);
    const nick = $("ogName"); if (nick) nick.value = r.id;
    renderAuthArea();
    updateOgAuthGate();
  } catch (e) {
    if (!isOffline(e)) authClearSession();   // expired session; keep it if just offline
  }
}

// drag-to-move on each game board (click-to-move still works)
enableBoardDrag($("aiBoard"), {
  movable: () => AIG.started && !AIG.over && !AIG.thinking && AIG.state && AIG.state.turn === AIG.human,
  legal: () => (AIG.state && AIG.state.legal) || {},
  commit: (from, to) => {
    const p = parseFen(AIG.state.fen)[from], r = +to[1]; AIG.sel = null;
    if (p && p.toLowerCase() === "p" && (r === 8 || r === 1)) promoChooser($("aiBoard"), p === "P", (pp) => aiHumanMove(from + to + pp));
    else aiHumanMove(from + to);
  },
});
enableBoardDrag($("ogBoard"), {
  movable: () => OG.started && !OG.over && OG.state && OG.state.turn === OG.color,
  legal: () => (OG.state && OG.state.legal) || {},
  commit: (from, to) => {
    const p = parseFen(OG.state.fen)[from], r = +to[1]; OG.sel = null;
    if (p && p.toLowerCase() === "p" && (r === 8 || r === 1)) promoChooser($("ogBoard"), p === "P", (pp) => ogSend({ type: "move", uci: from + to + pp }));
    else ogSend({ type: "move", uci: from + to });
    renderOgBoard();
  },
});
enableBoardDrag($("pzBoard"), {
  movable: () => !PZ.busy && !PZ.locked && PZ.legal && PZ.legal.legal,
  legal: () => (PZ.legal && PZ.legal.legal) || {},
  commit: (from, to) => { PZ.hintSq = null; pzUserMove(from + to); },
});

// =========================================================================== //
// ANALYSIS BOARD — a free board where the user can play ANY legal move for
// EITHER side. After every move the quick engine evaluates the position and
// shows who's better + the best move. Reuses the shared board helpers
// (parseFen / GLYPH / addCoords / applyBoardTheme / enableBoardDrag).
//
// Position tracking: we keep a base FEN (the standard start, or a loaded FEN)
// plus a UCI move list from it. /api/eval_fen applies those moves server-side
// (python-chess is the source of legality) and returns the resulting
// fen/legal/turn/check/san PLUS the engine evaluation — one authoritative call.
// =========================================================================== //
const AN_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AN = {
  baseFen: AN_START,   // position the move list starts from
  moves: [],           // UCI moves played from baseFen
  fen: AN_START,       // current (resulting) position
  orient: "w",
  legal: {},
  turn: "w",
  check: false,
  san: [],
  over: false,
  ev: null,            // last eval: { bestUci, bestSan, cp, mate, pv, gameOver }
  sel: null,
  busy: false,
  inited: false,
};

function renderAnBoard() {
  const board = $("anBoard"); if (!board) return;
  board.innerHTML = "";
  const map = parseFen(AN.fen);
  const files = AN.orient === "w" ? [..."abcdefgh"] : [..."hgfedcba"];
  const ranks = AN.orient === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const lastUci = AN.moves.length ? AN.moves[AN.moves.length - 1] : null;
  const lf = lastUci ? lastUci.slice(0, 2) : null, lt = lastUci ? lastUci.slice(2, 4) : null;
  const kingChar = AN.turn === "w" ? "K" : "k";
  let kingSq = null;
  for (const s in map) if (map[s] === kingChar) kingSq = s;
  const legal = AN.over ? {} : (AN.legal || {});   // any side to move can move
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      if (sq === lf || sq === lt) div.classList.add("last");
      if (AN.sel === sq) div.classList.add("sel");
      if (AN.check && sq === kingSq) div.classList.add("check");
      const p = map[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      if (SETTINGS.showDots && AN.sel && legal[AN.sel] && legal[AN.sel].includes(sq)) {
        const d = document.createElement("div"); d.className = "dot" + (map[sq] ? " cap" : "");
        div.appendChild(d);
      }
      addCoords(div, f, rank, files, ranks);
      div.dataset.sq = sq;
      div.onclick = () => onAnClick(sq);
      board.appendChild(div);
    }
  }
}

function onAnClick(sq) {
  if (_dragJustMoved) return;
  if (AN.busy || AN.over) return;
  const map = parseFen(AN.fen), legal = AN.legal || {};
  if (AN.sel) {
    if (legal[AN.sel] && legal[AN.sel].includes(sq)) {
      const from = AN.sel, piece = map[from], r = +sq[1];
      AN.sel = null;
      if (piece && piece.toLowerCase() === "p" && (r === 8 || r === 1)) {
        promoChooser($("anBoard"), piece === "P", (pp) => anPlay(from + sq + pp));
      } else {
        anPlay(from + sq);
      }
      return;
    }
    if (legal[sq]) { AN.sel = sq; renderAnBoard(); return; }
    AN.sel = null; renderAnBoard(); return;
  }
  if (legal[sq]) { AN.sel = sq; renderAnBoard(); }
}

// Play one move (from either side) and re-sync from the server.
async function anPlay(uci) {
  AN.sel = null;
  optimisticMove($("anBoard"), uci.slice(0, 2), uci.slice(2, 4), AN.orient);
  AN.moves.push(uci);
  await anSync(true);
}

// Ask the server for the resulting position + evaluation, then render.
async function anSync(animate) {
  AN.busy = true;
  anShowThinking();
  let st;
  try {
    st = await api("/api/eval_fen", { fen: AN.baseFen, moves: AN.moves, movetime: 350 });
  } catch (e) {
    // roll back an illegal/failed move so state stays consistent
    if (animate && AN.moves.length) AN.moves.pop();
    AN.busy = false;
    setStatus("anFenStatus", isOffline(e) ? t("offline_msg") : e.message, true);
    renderAnBoard();
    return;
  }
  AN.busy = false;
  AN.fen = st.fen;
  AN.legal = st.legal || {};
  AN.turn = st.turn;
  AN.check = st.check;
  AN.san = st.san || [];
  AN.over = !!st.gameOver;
  AN.ev = st;
  renderAnBoard();
  if (animate && AN.moves.length) {
    const u = AN.moves[AN.moves.length - 1];
    animateMove($("anBoard"), u.slice(0, 2), u.slice(2, 4), AN.orient);
  }
  playMoveSfx(st);
  anUpdatePanel();
  anRenderMoves();
}

function anShowThinking() {
  const b = $("anBest"); if (b) b.textContent = t("an_thinking");
}

// Decide who is better from a side-to-move-POV score. Returns white-POV cp and
// a {text, side} verdict. side: "w" | "b" | "" (equal).
function anWhoBetter(cp, mate, turn) {
  // convert to White POV
  let wMate = mate, wCp = cp;
  if (turn === "b") { if (mate != null) wMate = -mate; if (cp != null) wCp = -cp; }
  if (wMate != null) {
    if (wMate === 0) return { side: turn === "w" ? "b" : "w", text: "" };
    return { side: wMate > 0 ? "w" : "b", text: "", wCp: wMate > 0 ? 100000 : -100000 };
  }
  if (wCp == null) return { side: "", text: t("an_equal"), wCp: 0 };
  const side = Math.abs(wCp) < 30 ? "" : (wCp > 0 ? "w" : "b");
  return { side, wCp };
}

// White win probability (0–100) from a White-POV centipawn score.
function anWinPct(wCp) {
  if (wCp >= 100000) return 100;
  if (wCp <= -100000) return 0;
  return Math.round(100 / (1 + Math.pow(10, -(wCp / 400))));
}

function anUpdatePanel() {
  const evEl = $("anEval"), bestEl = $("anBest");
  const bar = $("anBar"), barLbl = $("anBarLbl");
  if (!AN.ev) return;
  const { cp, mate, bestSan, gameOver } = AN.ev;

  // game over → show result-ish text, empty bar handling
  if (gameOver) {
    evEl.textContent = t("an_game_over");
    evEl.className = "an-eval";
    if (bestEl) bestEl.textContent = "";
    // if it's mate, one side has a full bar
    if (bar) { bar.style.height = AN.check ? (AN.turn === "w" ? "0%" : "100%") : "50%"; }
    if (barLbl) barLbl.textContent = "";
    return;
  }

  const who = anWhoBetter(cp, mate, AN.turn);
  let label, verdict;
  if (mate != null) {
    label = t("an_mate_in") + " " + Math.abs(mate);
    verdict = who.side === "w" ? t("an_white_better") : (who.side === "b" ? t("an_black_better") : "");
  } else {
    const wCp = who.wCp != null ? who.wCp : 0;
    const pawns = (Math.abs(wCp) / 100).toFixed(1);
    const sign = wCp > 0 ? "+" : (wCp < 0 ? "-" : "");
    label = sign + pawns;
    verdict = who.side === "w" ? t("an_white_better") : (who.side === "b" ? t("an_black_better") : t("an_equal"));
  }
  evEl.textContent = verdict ? `${label} (${verdict})` : label;
  evEl.className = "an-eval";

  if (bestEl) bestEl.textContent = bestSan ? `${t("an_best_prefix")}: ${bestSan}` : "";

  // eval bar (white fill from the bottom, like the review rvBar)
  if (bar) {
    const wCp = mate != null ? (who.side === "w" ? 100000 : (who.side === "b" ? -100000 : 0)) : (who.wCp || 0);
    bar.style.height = anWinPct(wCp) + "%";
  }
  if (barLbl) barLbl.textContent = label;
}

function anRenderMoves() {
  const el = $("anMoves"); if (!el) return;
  const san = AN.san || [];
  if (!san.length) { el.innerHTML = `<span class="num">${t("an_moves_empty")}</span>`; return; }
  let html = "";
  san.forEach((s, i) => {
    if (i % 2 === 0) html += `<span class="num">${i / 2 + 1}.</span>`;
    html += `<span class="mv" style="cursor:default">${s}</span> `;
  });
  el.innerHTML = html; el.scrollTop = el.scrollHeight;
  updateOpeningLine("anOpening", AN.moves);
}

function anReset() {
  AN.baseFen = AN_START; AN.moves = []; AN.sel = null; AN.over = false;
  setStatus("anFenStatus", "");
  anSync(false);
}
function anUndo() {
  if (!AN.moves.length || AN.busy) return;
  AN.moves.pop(); AN.sel = null; AN.over = false;
  anSync(false);
}
function anFlip() {
  AN.orient = AN.orient === "w" ? "b" : "w";
  renderAnBoard();
}
async function anLoadFen() {
  const raw = ($("anFen").value || "").trim();
  if (!raw) return;
  let st;
  try {
    st = await api("/api/eval_fen", { fen: raw, moves: [], movetime: 350 });
  } catch (e) {
    setStatus("anFenStatus", isOffline(e) ? t("offline_msg") : t("an_fen_bad"), true);
    return;
  }
  // switch the base to the loaded FEN; the move list restarts from here
  AN.baseFen = st.fen; AN.moves = []; AN.sel = null;
  AN.fen = st.fen; AN.legal = st.legal || {}; AN.turn = st.turn;
  AN.check = st.check; AN.san = st.san || []; AN.over = !!st.gameOver; AN.ev = st;
  setStatus("anFenStatus", "");
  $("anFen").value = "";
  renderAnBoard(); anUpdatePanel(); anRenderMoves();
}

function initAnalysis() {
  if (AN.inited) return;
  AN.inited = true;
  const wire = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  wire("anReset", anReset);
  wire("anUndo", anUndo);
  wire("anFlip", anFlip);
  wire("anLoadFen", anLoadFen);
  const fenInput = $("anFen");
  if (fenInput) fenInput.addEventListener("keydown", (e) => { if (e.key === "Enter") anLoadFen(); });
  enableBoardDrag($("anBoard"), {
    movable: () => !AN.busy && !AN.over,      // analysis: either colour can move
    legal: () => AN.legal || {},
    commit: (from, to) => {
      const p = parseFen(AN.fen)[from], r = +to[1]; AN.sel = null;
      if (p && p.toLowerCase() === "p" && (r === 8 || r === 1)) promoChooser($("anBoard"), p === "P", (pp) => anPlay(from + to + pp));
      else anPlay(from + to);
    },
  });
  renderAnBoard();
  anSync(false);   // start position + its eval
}

// =========================================================================== //
// GROWTH REPORT — rating graph (⑨), future projection (⑪), adaptive rec (③)
// All from local history; no AI key needed. (Meta/coaching, so allowed anywhere.)
// =========================================================================== //
function ratingSeries() {
  // history is newest-first with per-online-game ratingDelta; reconstruct the
  // rating after each game working from the current rating backwards.
  const games = gameHistory().slice().reverse();   // oldest first
  const total = games.reduce((s, g) => s + (g.ratingDelta || 0), 0);
  let cur = Math.max(0, myRating() - total);
  const pts = [{ r: cur, date: null, label: t("gr_start") }];
  for (const g of games) {
    cur = Math.max(0, cur + (g.ratingDelta || 0));
    pts.push({ r: cur, date: g.date || null, mode: g.mode, result: g.result });
  }
  return pts;
}

function currentStreak() {
  const h = gameHistory();
  if (!h.length) return { kind: null, n: 0 };
  const first = h[0].result;
  if (first === "draw") return { kind: "draw", n: 1 };
  let n = 0;
  for (const g of h) { if (g.result === first) n++; else break; }
  return { kind: first, n };
}

// ADD2 + ADD5: profile identity + one progression ladder (rating / puzzle rating /
// XP level / league tier / best AI level as views of one advancement story).
function renderProfilePanel() {
  const el = document.getElementById("profilePanel"); if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const id = (AUTH && AUTH.id) ? AUTH.id : T("profile_guest");
  const lv = (typeof xpLevel === "function") ? xpLevel(xpGet()) : 1;
  const rating = (typeof myRating === "function") ? myRating() : 0;
  const pzR = (typeof pzRatingGet === "function") ? pzRatingGet() : 0;
  const lg = (typeof leagueGet === "function" && typeof leagueTierOf === "function") ? leagueTierOf(leagueGet().points) : null;
  const best = (typeof bestLevel === "function") ? bestLevel() : 0;
  const meters = [
    { ic: "♟️", label: T("prog_rating"), val: rating },
    { ic: "🧩", label: T("prog_pzrating"), val: pzR },
    { ic: "⭐", label: T("prog_xp"), val: "Lv " + lv },
    { ic: lg ? lg.ic : "🏆", label: T("prog_league"), val: lg ? T("league_" + lg.key) : "-" },
    { ic: "🤖", label: T("prog_ailevel"), val: best > 0 ? ("Lv " + best) : "-" },
  ];
  el.innerHTML =
    '<div class="pp-head"><span class="pp-ava">' + escapeHtml(String(id).charAt(0).toUpperCase()) + "</span>" +
      '<div class="pp-id"><b>' + escapeHtml(id) + "</b><span>" + T("profile_level").replace("{n}", lv) + "</span></div></div>" +
    '<div class="pp-ladder">' + meters.map((m) =>
      '<div class="pp-meter"><span class="pp-m-ic">' + m.ic + '</span><span class="pp-m-val">' + m.val +
      '</span><span class="pp-m-lbl">' + m.label + "</span></div>").join("") + "</div>";
}
// ADD8: the improvement journey — chain weakness → puzzles → learn → drills into
// one visible weekly path so the isolated tools read as a followable loop.
function renderJourney() {
  const el = document.getElementById("journeyCard"); if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const weak = (typeof weaknessByTheme === "function") ? weaknessByTheme() : [];
  const top = weak[0] || null;
  const themeName = top ? T("pztheme_" + top.theme) : T("journey_any");
  const steps = [
    { ic: "🎯", label: T("journey_s1").replace("{theme}", themeName), go: () => { const w = document.getElementById("weakCard"); if (w) w.scrollIntoView({ behavior: "smooth", block: "center" }); } },
    { ic: "🧩", label: T("journey_s2"), go: () => { if (top && typeof practiceThemeBand === "function") practiceThemeBand(top.cat); else { switchTab("puzzle"); if (typeof loadAdaptivePuzzle === "function") loadAdaptivePuzzle(); } } },
    { ic: "📖", label: T("journey_s3"), go: () => { switchTab("learn"); if (top && typeof showLearn === "function") { try { showLearn(top.theme); } catch (e) {} } } },
    { ic: "🩺", label: T("journey_s4"), go: () => { switchTab("review"); } },
  ];
  el.innerHTML =
    '<div class="jr-head"><b>🚀 ' + T("journey_title") + '</b><span class="jr-sub">' + T("journey_sub") + "</span></div>" +
    '<div class="jr-steps">' + steps.map((s, i) =>
      '<button class="jr-step" data-jstep="' + i + '"><span class="jr-n">' + (i + 1) + '</span><span class="jr-ic">' + s.ic +
      '</span><span class="jr-lbl">' + s.label + "</span></button>" +
      (i < steps.length - 1 ? '<span class="jr-arrow">→</span>' : "")).join("") + "</div>";
  el.querySelectorAll(".jr-step").forEach((b, i) => { b.onclick = steps[i].go; });
}

function renderGrowth() {
  if (typeof renderProfilePanel === "function") renderProfilePanel();   // ADD2/ADD5
  if (typeof renderJourney === "function") renderJourney();             // ADD8
  if (typeof renderLeague === "function") renderLeague();
  renderWeakness();
  renderGoal();
  renderAchievements();
  renderGrowthAdapt();
  renderGrowthChart();
  renderGrowthProjection();
  // FIX10: show the friendly empty-state (and hide the data cards) for a user
  // who has no games and no solved puzzles yet.
  const hist = (typeof gameHistory === "function") ? gameHistory() : [];
  const solved = (typeof PZ !== "undefined" && PZ.solved) ? PZ.solved.size : 0;
  const fresh = (!hist || !hist.length) && !solved;
  const empty = document.getElementById("growthEmpty");
  const wrap = document.querySelector("#tab-growth .growth-wrap");
  if (empty) empty.hidden = !fresh;
  if (wrap) wrap.style.display = fresh ? "none" : "";
}

// ---- weakness report + one-click prescription (⑨) ----
// The tactics you most often FAIL — aggregated from failed (review-queued)
// puzzles, which are theme-tagged — with a button straight to more of that theme.
const THEME_CAT = { mate: 0, fork: 1, pin: 2, skewer: 3, discovered: 4, hanging: 5 };
function weaknessByTheme() {
  const q = (typeof reviewQueue === "function") ? reviewQueue() : {};
  const counts = {};
  for (const lv in q) {
    const p = PZ.list && PZ.list[(+lv) - 1];
    if (p && p.theme && THEME_CAT[p.theme] != null) counts[p.theme] = (counts[p.theme] || 0) + 1;
  }
  return Object.keys(counts).map((theme) => ({ theme, n: counts[theme], cat: THEME_CAT[theme] })).sort((a, b) => b.n - a.n);
}
function practiceTheme(cat) {
  if (typeof practiceThemeBand === "function") return practiceThemeBand(cat);
  PZ.cat = cat; switchTab("puzzle"); loadPuzzle(pzCatRange(cat).start);
}
function renderWeakness() {
  const el = document.getElementById("weakReport"); if (!el) return;
  const w = weaknessByTheme();
  if (!w.length) { el.innerHTML = '<div class="weak-empty">' + t("weak_empty") + "</div>"; return; }
  el.innerHTML =
    '<div class="weak-head"><b>🎯 ' + t("weak_title") + "</b></div>" +
    '<div class="weak-list">' + w.slice(0, 3).map((x) =>
      '<div class="weak-row"><span class="weak-name">' + t("pztheme_" + x.theme) + "</span>" +
      '<span class="weak-count">' + t("weak_count").replace("{n}", x.n) + "</span>" +
      '<button class="weak-cta" data-cat="' + x.cat + '">' + t("weak_practice") + "</button></div>").join("") + "</div>";
  el.querySelectorAll(".weak-cta").forEach((b) => { b.onclick = () => practiceTheme(+b.dataset.cat); });
}

// ---- weekly goals (⑳) ----
function weekKey(d) {
  d = d || new Date();
  const t = new Date(d); t.setHours(0, 0, 0, 0);
  const day = (t.getDay() + 6) % 7;   // Mon=0
  t.setDate(t.getDate() - day);
  return t.toISOString().slice(0, 10);   // Monday's date = week id
}
const GOAL_TYPES = {
  onlinewin: { labelKey: "goal_onlinewin", unitKey: "unit_win", presets: [3, 5, 10] },
  games: { labelKey: "goal_games", unitKey: "unit_game", presets: [5, 10, 20] },
  rating: { labelKey: "goal_rating", unitKey: "unit_point", presets: [30, 60, 100] },
};
function goalGet() { try { return JSON.parse(localStorage.getItem("cc_goal") || "null"); } catch (e) { return null; } }
function goalSet(g) { localStorage.setItem("cc_goal", JSON.stringify(g)); renderGoal(); }
function goalProgress(g) {
  const wk = weekKey();
  const hist = gameHistory().filter((x) => x.date && weekKey(new Date(x.date)) === wk);
  if (g.type === "onlinewin") return hist.filter((x) => x.mode === "online" && x.result === "win").length;
  if (g.type === "games") return hist.length;
  if (g.type === "rating") return Math.max(0, hist.filter((x) => x.mode === "online").reduce((s, x) => s + (x.ratingDelta || 0), 0));
  return 0;
}
function renderGoal() {
  const el = $("grGoal"); if (!el) return;
  const g = goalGet();
  if (!g || g.week !== weekKey()) {
    // no active goal for this week — offer presets
    let html = `<p class="setdesc" style="margin:0 0 10px">${t("gr_goal_lead")}</p><div class="goal-presets">`;
    for (const [type, cfg] of Object.entries(GOAL_TYPES)) {
      const lab = t(cfg.labelKey), un = t(cfg.unitKey);
      cfg.presets.forEach((n) => {
        html += `<button class="ghost goal-set" data-type="${type}" data-target="${n}">${lab} ${n}${un}</button>`;
      });
    }
    html += `</div>`;
    el.innerHTML = html;
    el.querySelectorAll(".goal-set").forEach((b) => (b.onclick = () =>
      goalSet({ type: b.dataset.type, target: +b.dataset.target, week: weekKey() })));
    return;
  }
  const cfg = GOAL_TYPES[g.type], p = goalProgress(g), pct = Math.min(100, Math.round((p / g.target) * 100));
  const lab = t(cfg.labelKey), un = t(cfg.unitKey);
  const done = p >= g.target;
  el.innerHTML =
    `<div class="goal-head"><b>${lab} ${g.target}${un}</b>` +
    `<span>${done ? t("gr_goal_done") : `${p} / ${g.target}${un}`}</span></div>` +
    `<div class="goal-bar"><div class="goal-fill ${done ? "done" : ""}" style="width:${pct}%"></div></div>` +
    `<div style="margin-top:10px"><button class="ghost" id="goalReset">${t("gr_goal_change")}</button></div>`;
  $("goalReset").onclick = () => { localStorage.removeItem("cc_goal"); renderGoal(); };
}

function renderGrowthAdapt() {
  const el = $("grAdapt"); if (!el) return;
  const s = currentStreak();
  let html;
  if (s.kind === "loss" && s.n >= 3) {
    html = `<p class="grtip">${t("gr_streak_loss").replace("{n}", s.n)}</p>` +
      `<button class="primary" data-goto="puzzle">${t("gr_go_easy")}</button>`;
  } else if (s.kind === "win" && s.n >= 3) {
    html = `<p class="grtip">${t("gr_streak_win").replace("{n}", s.n)}</p>` +
      `<button class="primary" id="grHarder">${t("gr_harder")}</button>`;
  } else {
    const r = myRating();
    html = `<p class="grtip">${t("gr_keep")}</p>` +
      `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="ghost" data-goto="ai">${t("gr_ai")}</button>` +
      `<button class="ghost" data-goto="puzzle">${t("gr_pz")}</button>${AUTH.token ? `<button class="ghost" data-goto="online">${t("gr_online")}</button>` : ""}</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => switchTab(b.dataset.goto)));
  const harder = $("grHarder");
  if (harder) harder.onclick = () => {
    const lv = Math.min(10, (bestLevel() || 3) + 1);
    $("aiLevel").value = lv; $("aiLevel").dispatchEvent(new Event("input"));
    switchTab("ai");
  };
}

function renderGrowthChart() {
  const box = $("grChartBox"), stats = $("grStats");
  const pts = ratingSeries();
  const rated = gameHistory().filter((g) => g.mode === "online").length;
  if (pts.length < 2 || rated === 0) {
    box.innerHTML = `<div class="hist-empty">${t("gr_chart_empty")}</div>`;
    stats.innerHTML = ""; return;
  }
  const vals = pts.map((p) => p.r);
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = Math.max(30, (max - min) * 0.15);
  const lo = Math.max(0, min - pad), hi = max + pad;
  const W = 320, H = 150, m = { l: 34, r: 8, t: 10, b: 16 };
  const x = (i) => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
  const area = line + ` L${x(pts.length - 1).toFixed(1)},${H - m.b} L${x(0).toFixed(1)},${H - m.b} Z`;
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.r).toFixed(1)}" r="2.4" fill="#57b97c"/>`).join("");
  const yl = [hi, (hi + lo) / 2, lo].map((v) =>
    `<text x="2" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="#8b93a1">${Math.round(v)}</text>`).join("");
  box.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">` +
    `<defs><linearGradient id="grg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#57b97c" stop-opacity=".35"/><stop offset="1" stop-color="#57b97c" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="${area}" fill="url(#grg)"/><path d="${line}" fill="none" stroke="#57b97c" stroke-width="2"/>${dots}${yl}</svg>`;
  const startR = pts[0].r, nowR = myRating(), delta = nowR - startR;
  const peak = Math.max(...vals);
  stats.innerHTML =
    `<span>${t("gr_now")} <b>${ratingHTML(nowR)}</b></span><span>${t("gr_peak")} <b>${peak}</b></span>` +
    `<span>${t("gr_total")} <b class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" + delta : delta}</b></span>` +
    `<span>${t("gr_online_label")} <b>${rated}</b>${t("gr_games_suffix")}</span>`;
}

function renderGrowthProjection() {
  const el = $("grProjection");
  const online = gameHistory().filter((g) => g.mode === "online" && g.date);
  if (online.length < 4) {
    el.innerHTML = `<div class="hist-empty">${t("gr_proj_need")}</div>`; return;
  }
  // rating change per day over the rated span
  const dates = online.map((g) => g.date).sort();
  const first = new Date(dates[0]), last = new Date(dates[dates.length - 1]);
  const days = Math.max(1, (last - first) / 86400000);
  const totalDelta = online.reduce((s, g) => s + (g.ratingDelta || 0), 0);
  const perDay = totalDelta / days;
  // clamp the 90-day change to a realistic band so short/steep samples don't
  // extrapolate to absurd numbers.
  const change = Math.max(-400, Math.min(400, perDay * 90));
  const proj90 = Math.max(0, Math.round(myRating() + change));
  const trend = perDay > 0.3 ? t("gr_trend_up") : perDay < -0.3 ? t("gr_trend_down") : t("gr_trend_flat");
  const arrow = perDay > 0.3 ? "📈" : perDay < -0.3 ? "📉" : "➖";
  el.innerHTML =
    `<div class="grproj">${t("gr_proj_text").replace("{arrow}", arrow).replace("{trend}", trend).replace("{proj}", ratingHTML(proj90))}</div>`;
}

// =========================================================================== //
// SETTINGS modal
// =========================================================================== //
function rerenderBoards() {
  if (AIG.state) renderAiBoard();
  if (OG.state) renderOgBoard();
  if (PZ.fen) renderPzBoard();
  if (typeof AN !== "undefined" && AN.fen && typeof renderAnBoard === "function") renderAnBoard();
}
$("settingsBtn").onclick = () => {
  $("setShowDots").checked = SETTINGS.showDots;
  $("setSound").checked = SETTINGS.sound;
  $("setCoords").checked = SETTINGS.coords;
  if ($("setRemind")) { $("setRemind").checked = (typeof reminderEnabled === "function") && reminderEnabled(); setStatus("setRemindStatus", ""); }
  $("setBoard").value = SETTINGS.boardTheme;
  const row = $("setAccountRow"); if (row) row.style.display = (AUTH && AUTH.token) ? "flex" : "none";
  $("settingsModal").classList.remove("hidden");
};
// ADD1: re-openable install / notify entry (the first-success soft-ask is one-shot)
if ($("setInstallBtn")) $("setInstallBtn").onclick = async () => {
  const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  if (window.__pwaPrompt && window.__pwaDeferred) { try { await window.__pwaPrompt(); } catch (e) {} }
  else if (!standalone) { alert(typeof t === "function" ? t("install_hint") : "브라우저 메뉴에서 ‘홈 화면에 추가’로 설치할 수 있어요."); }
  // also offer notifications if not yet enabled
  if (("Notification" in window) && Notification.permission === "default" && typeof setReminder === "function") {
    const tog = $("setRemind"); if (tog) tog.checked = true;
    try { await setReminder(true); } catch (e) {}
  }
};
$("setDeleteBtn").onclick = async () => {
  if (!AUTH || !AUTH.token) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  if (!confirm(T("del_confirm"))) return;
  if (!confirm(T("del_confirm2"))) return;   // second, final confirmation
  try {
    await api("/api/auth/delete", { token: AUTH.token });
    authClearSession();
    $("settingsModal").classList.add("hidden");
    alert(T("del_done"));
  } catch (e) {
    alert(isOffline(e) ? t("offline_msg") : (e.message || t("del_fail")));
  }
};
$("setSyncBtn").onclick = async () => {
  const btn = $("setSyncBtn"), T = (typeof t === "function") ? t : ((k) => k);
  btn.disabled = true; const orig = btn.textContent; btn.textContent = T("sync_running");
  try {
    // 1) save the latest progress to the account (so a refresh never loses it)
    if (AUTH && AUTH.token) await api("/api/auth/save", { token: AUTH.token, progress: collectProgress() });
    // 2) ask the service worker to fetch the newest app version, then reload
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { try { await reg.update(); } catch (e) {} }
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = orig;
    alert(isOffline(e) ? t("offline_msg") : (e.message || t("sync_fail")));
    return;
  }
  location.reload();   // pick up the latest assets
};
$("settingsClose").onclick = () => $("settingsModal").classList.add("hidden");
$("settingsModal").onclick = (e) => { if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden"); };
$("setShowDots").onchange = (e) => {
  SETTINGS.showDots = e.target.checked;
  localStorage.setItem("cc_showdots", SETTINGS.showDots ? "1" : "0");
  rerenderBoards();
};
$("setSound").onchange = (e) => {
  SETTINGS.sound = e.target.checked;
  localStorage.setItem("cc_sound", SETTINGS.sound ? "1" : "0");
  if (SETTINGS.sound) SFX.move();   // little confirmation blip
};
$("setCoords").onchange = (e) => {
  SETTINGS.coords = e.target.checked;
  localStorage.setItem("cc_coords", SETTINGS.coords ? "1" : "0");
  rerenderBoards();
};

// ---- daily reminder (local notification via the SW's periodic background sync;
// works best on an installed PWA in Chrome/Android, no-ops gracefully elsewhere) ----
function reminderEnabled() { return localStorage.getItem("cc_reminder") === "1"; }
async function setReminder(on) {
  if (!on) {
    localStorage.setItem("cc_reminder", "0");
    try { const reg = await navigator.serviceWorker.ready; if (reg.periodicSync) await reg.periodicSync.unregister("daily-reminder"); } catch (e) {}
    return true;
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) { setStatus("setRemindStatus", t("notif_unsupported"), true); return false; }
  let perm = Notification.permission;
  if (perm === "default") { try { perm = await Notification.requestPermission(); } catch (e) { perm = "denied"; } }
  if (perm !== "granted") { localStorage.setItem("cc_reminder", "0"); if ($("setRemind")) $("setRemind").checked = false; setStatus("setRemindStatus", t("notif_denied"), true); return false; }
  localStorage.setItem("cc_reminder", "1");
  // stash the localized message where the SW can read it on wake-up
  try {
    const c = await caches.open("matevio-msg");
    await c.put("/__reminder", new Response(JSON.stringify({ title: t("notif_title"), body: t("notif_body") }),
      { headers: { "Content-Type": "application/json" } }));
  } catch (e) {}
  // register periodic background sync when the browser + install state allow it
  let scheduled = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.periodicSync && navigator.permissions) {
      const st = await navigator.permissions.query({ name: "periodic-background-sync" }).catch(() => ({ state: "denied" }));
      if (st.state === "granted") { await reg.periodicSync.register("daily-reminder", { minInterval: 20 * 60 * 60 * 1000 }); scheduled = true; }
    }
  } catch (e) {}
  setStatus("setRemindStatus", scheduled ? t("notif_on") : t("notif_on_limited"), false);
  return true;
}
if ($("setRemind")) $("setRemind").onchange = (e) => { setReminder(e.target.checked); };
$("setBoard").onchange = (e) => {
  SETTINGS.boardTheme = e.target.value;
  localStorage.setItem("cc_board", SETTINGS.boardTheme);
  applyBoardTheme(SETTINGS.boardTheme);
};

// =========================================================================== //
// OPENING PRACTICE (Learn tab) — pick a common opening and step through its main
// line move-by-move on a small board. Each opening is a list of UCI moves; we
// ask /api/legal (which replays from the start and returns fen + san) for the
// resulting position, so no client-side move generation is needed. Reuses the
// shared parseFen/GLYPH/addCoords board helpers.
// =========================================================================== //
const OP_PRACTICE = [
  { key: "op_ruy_lopez",  moves: ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7"] },
  { key: "op_italian",    moves: ["e2e4","e7e5","g1f3","b8c6","f1c4","f8c5","c2c3","g8f6","d2d4","e5d4"] },
  { key: "op_sicilian_najdorf", moves: ["e2e4","c7c5","g1f3","d7d6","d2d4","c5d4","f3d4","g8f6","b1c3","a7a6"] },
  { key: "op_french",     moves: ["e2e4","e7e6","d2d4","d7d5","b1c3","g8f6","c1g5","f8e7"] },
  { key: "op_caro_kann",  moves: ["e2e4","c7c6","d2d4","d7d5","b1c3","d5e4","c3e4","c8f5"] },
  { key: "op_qgd",        moves: ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6","c1g5","f8e7"] },
  { key: "op_kings_indian", moves: ["d2d4","g8f6","c2c4","g7g6","b1c3","f8g7","e2e4","d7d6","g1f3","e8g8"] },
  { key: "op_london",     moves: ["d2d4","d7d5","g1f3","g8f6","c1f4","e7e6","e2e3","f8d6"] },
];
const OPRAC = { i: 0, idx: 0, fen: AN_START, san: [], lastUci: null, busy: false };

function opRenderBoard() {
  const board = $("opBoard"); if (!board) return;
  board.innerHTML = "";
  const map = parseFen(OPRAC.fen);
  const files = [..."abcdefgh"], ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  const lf = OPRAC.lastUci ? OPRAC.lastUci.slice(0, 2) : null, lt = OPRAC.lastUci ? OPRAC.lastUci.slice(2, 4) : null;
  for (const rank of ranks) {
    for (const f of files) {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const div = document.createElement("div");
      div.className = "sq " + ((fi + rank) % 2 === 0 ? "light" : "dark");
      if (sq === lf || sq === lt) div.classList.add("last");
      const p = map[sq];
      if (p) {
        const s = document.createElement("span");
        s.className = "pc " + (p === p.toUpperCase() ? "w" : "b");
        s.textContent = GLYPH[p.toLowerCase()];
        div.appendChild(s);
      }
      addCoords(div, f, rank, files, ranks);
      div.dataset.sq = sq;
      board.appendChild(div);
    }
  }
}

// SAN of the move that just reached the current position (index-aware).
function opMoveLineText() {
  const el = $("opMoveLine"); if (!el) return;
  const cur = OP_PRACTICE[OPRAC.i];
  const total = cur ? cur.moves.length : 0;
  if (OPRAC.idx === 0) { el.textContent = t("op_start_pos"); return; }
  const san = OPRAC.san[OPRAC.idx - 1] || "";
  const moveNo = Math.floor((OPRAC.idx - 1) / 2) + 1;
  const dots = (OPRAC.idx % 2 === 1) ? "." : "...";
  const done = OPRAC.idx >= total ? "  ·  " + t("op_done") : "";
  el.textContent = `${moveNo}${dots} ${san}${done}`;
}

async function opRender() {
  const cur = OP_PRACTICE[OPRAC.i]; if (!cur) return;
  OPRAC.busy = true;
  let st;
  try { st = await api("/api/legal", { moves: cur.moves.slice(0, OPRAC.idx) }); }
  catch (e) { OPRAC.busy = false; setStatus("opStatus", isOffline(e) ? t("offline_msg") : e.message, true); return; }
  OPRAC.busy = false;
  OPRAC.fen = st.fen; OPRAC.san = st.san || [];
  OPRAC.lastUci = OPRAC.idx > 0 ? cur.moves[OPRAC.idx - 1] : null;
  setStatus("opStatus", "");
  opRenderBoard();
  if (OPRAC.lastUci) animateMove($("opBoard"), OPRAC.lastUci.slice(0, 2), OPRAC.lastUci.slice(2, 4), "w");
  opMoveLineText();
  opUpdateButtons();
}

function opUpdateButtons() {
  const cur = OP_PRACTICE[OPRAC.i];
  const nx = $("opNext");
  if (nx && cur) nx.disabled = OPRAC.idx >= cur.moves.length;
}

function opNext() {
  const cur = OP_PRACTICE[OPRAC.i]; if (!cur || OPRAC.busy) return;
  if (OPRAC.idx >= cur.moves.length) return;
  OPRAC.idx++;
  opRender();
}
function opReset() { if (OPRAC.busy) return; OPRAC.idx = 0; opRender(); }
function opSelectOpening(i) {
  OPRAC.i = Math.max(0, Math.min(OP_PRACTICE.length - 1, i));
  OPRAC.idx = 0;
  opRender();
}

// (re)build the dropdown option labels in the current language, preserving the
// selection. Called on init and on every language change (via refreshDashboard).
function opRefreshLang() {
  const sel = $("opSelect"); if (!sel) return;
  const prev = OPRAC.i;
  if (sel.options.length !== OP_PRACTICE.length) {
    sel.innerHTML = "";
    OP_PRACTICE.forEach((o, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      sel.appendChild(opt);
    });
  }
  OP_PRACTICE.forEach((o, i) => { sel.options[i].textContent = t(o.key); });
  sel.value = String(prev);
  opMoveLineText();   // re-translate the "start position / done" line
}

function opInit() {
  const sel = $("opSelect"); if (!sel) return;
  opRefreshLang();
  sel.onchange = (e) => opSelectOpening(+e.target.value);
  const nx = $("opNext"); if (nx) nx.onclick = opNext;
  const rs = $("opReset"); if (rs) rs.onclick = opReset;
  opRender();
}

// boot
aiBoot();
authBoot();
// NB: leaderboard is loaded lazily when the 온라인 tab opens (switchTab), not at
// boot — it's the slowest call (~850ms on 0.1 CPU) and needless on the home tab.
opInit();

// =========================================================================== //
// HOME DASHBOARD — packed stats strip + sidebar profile widget (v23).
// All values come from existing local state (rating, history, best level,
// solved puzzles); rendered on load, on tab switch, and on rating changes.
// =========================================================================== //
function renderHomeStats() {
  const el = document.getElementById("homeStats");
  if (!el) return;
  const hist = (typeof gameHistory === "function") ? gameHistory() : [];
  const wins = hist.filter((g) => g.result === "win").length;
  const losses = hist.filter((g) => g.result === "loss").length;
  const wr = (wins + losses) ? Math.round(wins / (wins + losses) * 100) : 0;
  const solved = (typeof PZ !== "undefined" && PZ.solved) ? PZ.solved.size : 0;
  const logged = !!(typeof AUTH !== "undefined" && AUTH.token);
  const T = (typeof t === "function") ? t : ((k) => k);
  const tiles = [
    { ic: "⭐", k: T("stat_rating"), v: logged ? ratingHTML(myRating()) : "—" },
    { ic: "🤖", k: T("stat_best"), v: (bestLevel() || "-") },
    { ic: "🧩", k: T("stat_puzzles"), v: solved + "<span style='font-size:13px;color:var(--muted)'>/100</span>" },
    { ic: "📈", k: T("stat_winrate"), v: wr + "<span style='font-size:13px;color:var(--muted)'>%</span>" },
    { ic: "🔥", k: T("stat_streak"), v: winStreak() + (bestStreak() > 0 ? `<span style='font-size:12px;color:var(--muted)'> · ${T("streak_best_short")} ${bestStreak()}</span>` : "") },
    { ic: "♟", k: T("stat_games"), v: hist.length },
  ];
  el.innerHTML = tiles.map((t) =>
    `<div class="stat"><div class="ic">${t.ic}</div><div class="k">${t.k}</div><div class="v">${t.v}</div></div>`
  ).join("");
}

function renderSidebarProfile() {
  const el = document.getElementById("sideProfile");
  if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const logged = !!(typeof AUTH !== "undefined" && AUTH.token);
  const name = (logged && AUTH.id) ? AUTH.id : T("sp_guest");
  const solved = (typeof PZ !== "undefined" && PZ.solved) ? PZ.solved.size : 0;
  el.innerHTML =
    `<div class="sp-top">` +
      `<div class="sp-ava">${escapeHtml(name.charAt(0).toUpperCase())}</div>` +
      `<div style="min-width:0"><div class="sp-name">${escapeHtml(name)}</div>` +
      `<div class="sp-sub">${logged ? ratingHTML(myRating()) : T("sp_notlogged")}</div></div>` +
    `</div>` +
    `<div class="sp-stats">` +
      `<div class="sp-stat"><b>${bestLevel() || "-"}</b><span>${T("sp_best")}</span></div>` +
      `<div class="sp-stat"><b>${solved}</b><span>${T("sp_puzzles")}</span></div>` +
    `</div>`;
}

function refreshDashboard() {
  try {
    // header re-renders on language change (login button + rating chip).
    // NB: set the chip text inline — calling updateRatingChip() would recurse.
    if (typeof renderAuthArea === "function") renderAuthArea();
    const rc = document.getElementById("ratingChip");
    if (rc && !rc.classList.contains("hidden") && typeof myRating === "function") {
      rc.innerHTML = `${t("word_rating")} <b>${ratingHTML(myRating())}</b>`;
    }
    renderHomeStats(); renderSidebarProfile();
    if (typeof renderPzStreak === "function") renderPzStreak();
    if (typeof updateRankBadge === "function") updateRankBadge();
    const ll = document.getElementById("aiLevelLabel"), lv = document.getElementById("aiLevel");
    if (ll && lv && typeof aiLevelText === "function") ll.textContent = aiLevelText(lv.value);
    if (typeof syncSegmentedControls === "function") syncSegmentedControls();  // re-sync chip labels/active on language change
    if (typeof updateAiTurn === "function") updateAiTurn();   // re-translate live turn text on language change
    if (typeof updateOgTurn === "function") updateOgTurn();
    // re-translate the live opening-name labels + the opening-practice card
    if (typeof updateOpeningLine === "function") {
      if (typeof AIG !== "undefined") updateOpeningLine("aiOpening", AIG.moves);
      if (typeof OG !== "undefined") updateOpeningLine("ogOpening", OG.moves);
      if (typeof AN !== "undefined") updateOpeningLine("anOpening", AN.moves);
    }
    if (typeof opRefreshLang === "function") opRefreshLang();
    // re-render the learn card in the chosen language (keeps the selected piece)
    var _lb = document.querySelector("#learnSel button.active");
    if (_lb && typeof showLearn === "function") showLearn(_lb.dataset.topic);
    // re-render the growth report if that tab is currently open
    var _gt = document.getElementById("tab-growth");
    if (_gt && _gt.classList.contains("active") && typeof renderGrowth === "function") renderGrowth();
  } catch (e) {}
}
refreshDashboard();

// =========================================================================== //
// GAME RECORDS — a window listing every played game; each row re-opens the AI
// review of that game (moves are stored in the history entry).
// =========================================================================== //
function renderHistoryModal() {
  const el = document.getElementById("historyList");
  if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const h = gameHistory();
  if (!h.length) { el.innerHTML = `<div class="hist-empty">${T("hist_empty")}</div>`; return; }
  el.innerHTML = "";
  h.forEach((g) => {
    const res = g.result === "win" ? `<b class="w">${T("res_short_win")}</b>` : g.result === "loss" ? `<b class="l">${T("res_short_loss")}</b>` : `<b class="d">${T("res_short_draw")}</b>`;
    const mode = g.mode === "online" ? "🌐" : "🤖";
    const delta = (g.ratingDelta === null || g.ratingDelta === undefined) ? '<span class="hm-delta"></span>'
      : (g.ratingDelta >= 0 ? `<span class="hm-delta up">+${g.ratingDelta}</span>` : `<span class="hm-delta down">${g.ratingDelta}</span>`);
    const row = document.createElement("div");
    row.className = "histm-row";
    row.innerHTML = `<span class="dim">${(g.date || "").slice(5)}</span>` +
      `<span class="hm-opp">${mode} ${escapeHtml(g.opponent || "")}</span>${res}${delta}`;
    const btn = document.createElement("button");
    btn.className = "ghost hm-review";
    if (g.moves && g.moves.length) {
      btn.textContent = T("hist_review");
      btn.onclick = () => {
        document.getElementById("historyModal").classList.add("hidden");
        runAnalyze({ moves: g.moves, white: g.white || "White", black: g.black || "Black", movetime: REVIEW_MT });
      };
    } else {
      btn.textContent = T("hist_norec"); btn.disabled = true;
    }
    row.appendChild(btn);
    el.appendChild(row);
  });
}
(function () {
  const open = document.getElementById("historyBtn");
  const closeB = document.getElementById("historyCloseBtn");
  const modal = document.getElementById("historyModal");
  if (open) open.onclick = () => { renderHistoryModal(); modal.classList.remove("hidden"); };
  if (closeB) closeB.onclick = () => modal.classList.add("hidden");
  if (modal) modal.onclick = (e) => { if (e.target === modal) modal.classList.add("hidden"); };
  const ge = document.getElementById("gameExit");
  if (ge) ge.onclick = () => { hideResult(); exitImmersive(); };
})();

// Apply the saved language now that all renderers exist (translates static
// [data-i18n] text and re-renders the dynamic dashboard in the chosen tongue).
if (typeof applyLang === "function") applyLang(typeof CC_LANG !== "undefined" ? CC_LANG : "ko");

// =========================================================================== //
// ④ Achievements / badges
// =========================================================================== //
const ACHIEVEMENTS = [
  { id: "first_win",   icon: "🥇", need: (s) => s.wins >= 1 },
  { id: "win_10",      icon: "🏅", need: (s) => s.wins >= 10 },
  { id: "win_50",      icon: "🎖️", need: (s) => s.wins >= 50 },
  { id: "streak_3",    icon: "🔥", need: (s) => s.bestStreak >= 3 },
  { id: "streak_5",    icon: "⚡", need: (s) => s.bestStreak >= 5 },
  { id: "games_10",    icon: "♟️", need: (s) => s.games >= 10 },
  { id: "games_50",    icon: "🎯", need: (s) => s.games >= 50 },
  { id: "pz_1",        icon: "🧩", need: (s) => s.puzzles >= 1 },
  { id: "pz_25",       icon: "🧠", need: (s) => s.puzzles >= 25 },
  { id: "pz_100",      icon: "👑", need: (s) => s.puzzles >= 100 },
  { id: "pzstreak_5",  icon: "🌟", need: (s) => s.pzStreakBest >= 5 },
  { id: "pzstreak_10", icon: "💫", need: (s) => s.pzStreakBest >= 10 },
  { id: "rating_800",  icon: "📈", need: (s) => s.rating >= 800 },
  { id: "rating_1200", icon: "🚀", need: (s) => s.rating >= 1200 },
  { id: "rating_1600", icon: "💎", need: (s) => s.rating >= 1600 },
];

function achStats() {
  let solved = 0;
  try { solved = (JSON.parse(localStorage.getItem("cc_puzzles_solved") || "[]") || []).length; } catch (e) {}
  const hist = (typeof gameHistory === "function") ? gameHistory() : [];
  return {
    games: hist.length,
    wins: hist.filter((g) => g.result === "win").length,
    bestStreak: (typeof bestStreak === "function") ? bestStreak() : 0,
    puzzles: solved,
    pzStreakBest: (typeof pzStreakBest === "function") ? pzStreakBest() : 0,
    rating: (typeof myRating === "function") ? myRating() : 0,
  };
}
function achUnlocked() {
  try { return new Set(JSON.parse(localStorage.getItem("cc_achievements") || "[]")); }
  catch (e) { return new Set(); }
}
function achSave(set) {
  localStorage.setItem("cc_achievements", JSON.stringify([...set]));
  if (typeof authSchedulePush === "function") authSchedulePush();
}
// Detect newly earned achievements, persist, and toast them (unless silent).
function checkAchievements(silent) {
  const s = achStats();
  const have = achUnlocked();
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (!have.has(a.id) && a.need(s)) { have.add(a.id); fresh.push(a); }
  }
  if (fresh.length) {
    achSave(have);
    if (!silent) fresh.forEach((a, i) => setTimeout(() => achToast(a), i * 1600));
    if (document.getElementById("achGrid")) renderAchievements();
  }
  return fresh.length;
}
function achToast(a) {
  const T = (typeof t === "function") ? t : ((k) => k);
  const el = document.createElement("div");
  el.className = "ach-toast";
  el.innerHTML = '<span class="ach-ic">' + a.icon + '</span><div>' +
    '<div class="ach-tt">' + T("ach_unlocked") + '</div>' +
    '<div class="ach-nm">' + T("ach_" + a.id) + '</div></div>';
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 400); }, 4200);
}
function renderAchievements() {
  const el = document.getElementById("achGrid");
  if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const s = achStats();
  const have = achUnlocked();
  let changed = false;
  for (const a of ACHIEVEMENTS) if (!have.has(a.id) && a.need(s)) { have.add(a.id); changed = true; }
  if (changed) achSave(have);
  const got = ACHIEVEMENTS.filter((a) => have.has(a.id)).length;
  const cnt = document.getElementById("achCount");
  if (cnt) cnt.textContent = got + "/" + ACHIEVEMENTS.length;
  el.innerHTML = ACHIEVEMENTS.map((a) => {
    const on = have.has(a.id);
    return '<div class="ach ' + (on ? "on" : "off") + '" title="' + T("ach_" + a.id + "_d") + '">' +
      '<span class="ach-ic">' + (on ? a.icon : "🔒") + '</span>' +
      '<span class="ach-nm">' + T("ach_" + a.id) + '</span></div>';
  }).join("");
}
// silent backfill on load (unlock anything already earned, no toast spam)
try { checkAchievements(true); } catch (e) {}

// =========================================================================== //
// ⑦ Game share — encode a finished game into a link; opening it replays the
// game in the Review tab (reusing the whole analysis viewer). No server needed.
// =========================================================================== //
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(s)));
}
function buildShareUrl(g) {
  const payload = JSON.stringify({
    w: g.white || "White", b: g.black || "Black",
    r: g.result || "", m: (g.moves || []).join(" "),
  });
  return location.origin + "/?g=" + b64urlEncode(payload);
}
function shareFlash(msg) {
  const el = document.createElement("div");
  el.className = "ach-toast show";
  el.innerHTML = '<span class="ach-ic">🔗</span><div><div class="ach-nm">' + msg + "</div></div>";
  document.body.appendChild(el);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 400); }, 2600);
}
async function shareGame(g) {
  if (!g || !g.moves || !g.moves.length) { shareFlash(t("share_none")); return; }
  const url = buildShareUrl(g);
  try {
    if (navigator.share) { await navigator.share({ title: "Matevio", text: t("share_text"), url }); return; }
  } catch (e) { return; }   // user dismissed the native sheet
  try { await navigator.clipboard.writeText(url); shareFlash(t("share_copied")); }
  catch (e) { window.prompt(t("share_copy_manual"), url); }
}
// ---- shareable IMAGE result card (canvas → navigator.share files) ----
function _cardMiniBoard(x, fen, ox, oy, size) {
  let map = {}; try { map = parseFen(fen); } catch (e) {}
  const cell = size / 8, files = "abcdefgh", ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const light = (f + ranks[r]) % 2 === 0;
    x.fillStyle = light ? "#ebecd0" : "#6f9350";
    x.fillRect(ox + f * cell, oy + r * cell, cell, cell);
    const p = map[files[f] + ranks[r]];
    if (p) {
      x.fillStyle = (p === p.toUpperCase()) ? "#fafafa" : "#20242a";
      x.font = Math.round(cell * 0.82) + "px 'Segoe UI Symbol','Noto Sans Symbols2',system-ui,sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(GLYPH[p.toLowerCase()] || "", ox + f * cell + cell / 2, oy + r * cell + cell / 2 + 1);
    }
  }
}
async function shareResultCard(o) {
  try {
    const S = 800, c = document.createElement("canvas"); c.width = S; c.height = S;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, S, S); g.addColorStop(0, "#15452e"); g.addColorStop(1, "#0d1016");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    x.textBaseline = "alphabetic";
    // wordmark
    x.textAlign = "center"; x.font = "800 34px system-ui,sans-serif";
    const mw = x.measureText("Mate").width, vw = x.measureText("vio").width, wx = S / 2 - (mw + vw) / 2;
    x.textAlign = "left"; x.fillStyle = "#4fb877"; x.fillText("Mate", wx, 74);
    x.fillStyle = "#eef3f7"; x.fillText("vio", wx + mw, 74);
    // headline
    x.textAlign = "center";
    x.font = "44px system-ui,sans-serif"; x.fillText(o.icon || "🏆", S / 2, 168);
    x.font = "800 52px system-ui,sans-serif"; x.fillStyle = "#fff"; x.fillText(o.title || "", S / 2, 232);
    if (o.sub) { x.font = "26px system-ui,sans-serif"; x.fillStyle = "#b9c6d2"; x.fillText(o.sub, S / 2, 274); }
    // mini board
    const bs = 380, bx = (S - bs) / 2, by = 312;
    x.fillStyle = "rgba(0,0,0,.25)"; x.fillRect(bx - 8, by - 8, bs + 16, bs + 16);
    _cardMiniBoard(x, o.fen || HUB_START_FEN, bx, by, bs);
    // footer
    x.textAlign = "center"; x.font = "700 24px system-ui,sans-serif"; x.fillStyle = "#4fb877";
    x.fillText("matevio.com", S / 2, by + bs + 54);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    if (!blob) throw new Error("no blob");
    const file = new File([blob], "matevio.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Matevio", text: t("share_text") });
      return;
    }
    // fallback: download the image
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "matevio.png"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    shareFlash(t("card_saved"));
  } catch (e) { /* user dismissed or unsupported */ }
}

// On load: if the URL carries a shared game, replay it in Review.
function checkSharedGame() {
  let g;
  try { g = new URLSearchParams(location.search).get("g"); } catch (e) { return; }
  if (!g) return;
  let d;
  try { d = JSON.parse(b64urlDecode(g)); } catch (e) { return; }
  const moves = (d && d.m || "").trim() ? d.m.trim().split(/\s+/) : [];
  if (!moves.length) return;
  try { history.replaceState(null, "", location.origin + "/"); } catch (e) {}   // don't re-trigger on refresh
  setTimeout(() => {
    try {
      switchTab("review");
      runAnalyze({ moves, white: d.w || "White", black: d.b || "Black", movetime: REVIEW_MT });
    } catch (e) {}
  }, 500);
}
if ($("rvShare")) $("rvShare").onclick = () => shareGame(LAST_REQ);

// =========================================================================== //
// GROWTH LOOPS (Batch 5): funnel metrics (ADD10), referral + puzzle-challenge
// links (ADD4) with a landing overlay (FIX6), weekly league (ADD8).
// =========================================================================== //

// ---- ADD10: ultra-light funnel analytics (anonymous; whitelisted events) ----
function anonId() {
  let id = localStorage.getItem("cc_anon");
  if (!id) { id = "a" + Math.random().toString(36).slice(2, 10); localStorage.setItem("cc_anon", id); }
  return id;
}
function metric(event, opts) {
  try {
    if (opts && opts.once) {
      let done; try { done = JSON.parse(localStorage.getItem("cc_metrics") || "[]"); } catch (e) { done = []; }
      if (done.includes(event)) return;
      done.push(event); localStorage.setItem("cc_metrics", JSON.stringify(done));
    }
    fetch("/api/metric", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ref: anonId(), token: (typeof AUTH !== "undefined" && AUTH.token) || null }),
      keepalive: true }).catch(() => {});
  } catch (e) {}
}

// ---- ADD4 + FIX6: launch links + landing overlay ----
function openPuzzleByLevel(lvl) {
  const go = () => {
    const idx = PZ.list.findIndex((p) => p.level === lvl);
    switchTab("puzzle");
    if (idx >= 0) loadPuzzle(idx, { force: true }); else loadAdaptivePuzzle();
  };
  if (PZ.list && PZ.list.length) return go();
  let n = 0;
  const iv = setInterval(() => { if ((PZ.list && PZ.list.length) || n++ > 40) { clearInterval(iv); if (PZ.list && PZ.list.length) go(); } }, 150);
}
function sharePuzzleLink(lvl) {
  const url = location.origin + "/?p=" + lvl;
  metric("share_puzzle");
  if (navigator.share) { navigator.share({ title: "Matevio", text: t("pz_challenge_text"), url }).catch(() => {}); return; }
  try { navigator.clipboard.writeText(url); if (typeof shareFlash === "function") shareFlash(t("pz_link_copied")); }
  catch (e) { try { prompt(t("pz_link_copied"), url); } catch (e2) {} }
}
function showLanding(ic, title, sub, goLabel, goFn) {
  const m = document.getElementById("landingModal");
  if (!m) { goFn(); return; }
  document.getElementById("landingIc").textContent = ic;
  document.getElementById("landingTitle").textContent = title;
  document.getElementById("landingSub").textContent = sub;
  const g = document.getElementById("landingGo"); g.textContent = goLabel;
  g.onclick = () => { m.classList.add("hidden"); goFn(); };
  const s = document.getElementById("landingSkip");
  if (s) s.onclick = () => m.classList.add("hidden");
  m.classList.remove("hidden");
}
function checkLaunchParams() {
  let params; try { params = new URLSearchParams(location.search); } catch (e) { return false; }
  const ref = params.get("ref");
  const idOk = ref && /^[A-Za-z0-9_\-가-힣]{2,20}$/.test(ref);
  if (idOk && !localStorage.getItem("cc_ref") && ref !== (typeof AUTH !== "undefined" && AUTH.id)) {
    localStorage.setItem("cc_ref", ref); metric("ref_land");
  }
  const p = params.get("p");
  if (p != null) {
    const lvl = parseInt(p, 10);
    try { history.replaceState(null, "", location.origin + "/"); } catch (e) {}
    if (!isNaN(lvl)) {
      showLanding("🎯", t("landing_pz_title"),
        idOk ? t("landing_pz_sub_ref").replace("{id}", ref) : t("landing_pz_sub"),
        t("landing_pz_go"), () => openPuzzleByLevel(lvl));
      return true;
    }
  }
  if (idOk) {
    try { history.replaceState(null, "", location.origin + "/"); } catch (e) {}
    showLanding("♟️", t("landing_ref_title"), t("landing_ref_sub").replace("{id}", ref),
      t("landing_ref_go"), () => { switchTab("puzzle"); loadAdaptivePuzzle(); });
    return true;
  }
  return false;
}

// ---- ADD8: weekly league (client-side; XP-earning actions score points) ----
const LEAGUE_TIERS = [
  { key: "bronze", ic: "🥉", min: 0 }, { key: "silver", ic: "🥈", min: 50 },
  { key: "gold", ic: "🥇", min: 150 }, { key: "platinum", ic: "💠", min: 300 },
  { key: "diamond", ic: "💎", min: 600 },
];
function leagueGet() {
  let l; try { l = JSON.parse(localStorage.getItem("cc_league") || "null"); } catch (e) { l = null; }
  const wk = (typeof weekKey === "function") ? weekKey() : new Date().toISOString().slice(0, 10);
  if (!l || l.week !== wk) { l = { week: wk, points: 0, prevTier: (l && l.tier) || "bronze" }; localStorage.setItem("cc_league", JSON.stringify(l)); }
  return l;
}
function leagueTierOf(points) {
  let t0 = LEAGUE_TIERS[0];
  for (const x of LEAGUE_TIERS) if (points >= x.min) t0 = x;
  return t0;
}
function leagueAdd(points) {
  const l = leagueGet(); l.points += points; l.tier = leagueTierOf(l.points).key;
  localStorage.setItem("cc_league", JSON.stringify(l));
  const g = document.getElementById("tab-growth");
  if (g && g.classList.contains("active")) renderLeague();
}
function renderLeague() {
  const el = document.getElementById("leagueCard"); if (!el) return;
  const l = leagueGet(); const cur = leagueTierOf(l.points);
  const idx = LEAGUE_TIERS.findIndex((x) => x.key === cur.key);
  const next = LEAGUE_TIERS[idx + 1] || null;
  const toNext = next ? Math.max(0, next.min - l.points) : 0;
  const lo = cur.min, hi = next ? next.min : Math.max(cur.min + 100, l.points);
  const pct = Math.max(0, Math.min(100, (l.points - lo) / Math.max(1, hi - lo) * 100));
  el.innerHTML =
    '<div class="lg-head"><span class="lg-ic">' + cur.ic + '</span>' +
      '<div class="lg-meta"><b>' + t("league_" + cur.key) + '</b>' +
      '<span class="lg-week">' + t("league_week").replace("{n}", l.points) + '</span></div></div>' +
    '<div class="lg-track"><div class="lg-fill" style="width:' + pct + '%"></div></div>' +
    (next ? '<div class="lg-next">' + t("league_next").replace("{n}", toNext).replace("{tier}", t("league_" + next.key)) + '</div>'
          : '<div class="lg-next">' + t("league_top") + '</div>');
}

// ---- ADD7: opening principles rule-checker (client-side, from SAN) ----
function openingReport(sanMoves, humanColor) {
  // humanColor: 'white' | 'black'. Evaluate the human's first ~10 moves.
  const isW = humanColor !== "black";
  const my = sanMoves.filter((_, i) => (i % 2 === 0) === isW).slice(0, 10);
  const findings = [];
  let good = 0, total = 0;
  const has = (re) => my.some((s) => re.test(s));
  // 1) central pawn in the first two moves
  total++;
  if (my.slice(0, 2).some((s) => /^[ed][45]$/.test(s))) { good++; findings.push({ ok: true, k: "op_center_ok" }); }
  else findings.push({ ok: false, k: "op_center_no" });
  // 2) developed at least two minor pieces (N/B moves)
  total++;
  const minors = my.filter((s) => /^[NB]/.test(s)).length;
  if (minors >= 2) { good++; findings.push({ ok: true, k: "op_dev_ok" }); }
  else findings.push({ ok: false, k: "op_dev_no" });
  // 3) castled
  total++;
  if (has(/^O-O/)) { good++; findings.push({ ok: true, k: "op_castle_ok" }); }
  else findings.push({ ok: false, k: "op_castle_no" });
  // 4) didn't bring the queen out too early (before move 5)
  total++;
  const earlyQ = my.slice(0, 4).some((s) => /^Q/.test(s));
  if (!earlyQ) { good++; findings.push({ ok: true, k: "op_queen_ok" }); }
  else findings.push({ ok: false, k: "op_queen_no" });
  // 5) didn't shuffle the same minor piece repeatedly
  total++;
  const dests = my.filter((s) => /^[NB]/.test(s)).map((s) => s.replace(/[+#!?]/g, "").slice(-2));
  const moved = my.filter((s) => /^[NB]/.test(s)).length;
  const wasteful = moved > 0 && (moved - new Set(dests).size) >= 1;
  if (!wasteful) { good++; findings.push({ ok: true, k: "op_tempo_ok" }); }
  else findings.push({ ok: false, k: "op_tempo_no" });
  return { score: good, total, findings };
}
function renderOpeningReport() {
  const el = document.getElementById("rvOpening"); if (!el || !RV.view) return;
  const san = (RV.view.moves || []).map((m) => m.san + (m.symbol || ""));
  const hc = (typeof rvHumanColor === "function") ? rvHumanColor() : "white";
  const r = openingReport(san, hc);
  el.innerHTML =
    '<div class="op-head"><b>♟️ ' + t("op_title") + '</b><span class="op-score">' + r.score + "/" + r.total + "</span></div>" +
    '<div class="op-list">' + r.findings.map((f) =>
      '<div class="op-row ' + (f.ok ? "ok" : "bad") + '"><span>' + (f.ok ? "✅" : "⚠️") + "</span>" + t(f.k) + "</div>").join("") + "</div>";
  el.hidden = false;
}

// launch: record the visit, then handle share/referral/puzzle links (falling
// back to the legacy ?g= shared-game replay).
metric("first_visit", { once: true });
if (!checkLaunchParams()) checkSharedGame();


// =========================================================================== //
// ⑧ Friends list + challenge/rematch (reuses the online invite-code flow)
// =========================================================================== //
async function loadFriends() {
  const list = $("frList"); if (!list) return;
  if (!AUTH.token) {
    list.innerHTML = `<div class="hist-empty">${t("fr_login")}</div>`;
    return;
  }
  let r;
  try { r = await api("/api/friends/list", { token: AUTH.token }); }
  catch (e) { list.innerHTML = `<div class="hist-empty">${t("fr_fail")}</div>`; return; }
  renderFriends(r.friends || []);
}
function renderFriends(friends) {
  const list = $("frList"); if (!list) return;
  if (!friends.length) { list.innerHTML = `<div class="hist-empty">${t("fr_empty")}</div>`; return; }
  list.innerHTML = friends.map((f) =>
    `<div class="fr-row">` +
      `<span class="fr-name">${escapeHtml(f.id)}</span>` +
      `<span class="fr-rating">${ratingHTML(f.rating)}</span>` +
      `<button class="ghost fr-play" data-fid="${escapeHtml(f.id)}">${t("fr_challenge")}</button>` +
      `<button class="ghost fr-del" data-fid="${escapeHtml(f.id)}" title="${t("fr_remove")}">✕</button>` +
    `</div>`).join("");
  list.querySelectorAll(".fr-play").forEach((b) => b.onclick = () => frChallenge(b.dataset.fid));
  list.querySelectorAll(".fr-del").forEach((b) => b.onclick = () => frRemove(b.dataset.fid));
}
async function frAdd() {
  if (!AUTH.token) { setStatus("frStatus", t("fr_login"), true); return; }
  const id = ($("frAddInput").value || "").trim();
  if (!id) return;
  try {
    const r = await api("/api/friends/add", { token: AUTH.token, id });
    $("frAddInput").value = "";
    setStatus("frStatus", t("fr_added").replace("{id}", r.id), false);
    loadFriends();
  } catch (e) { setStatus("frStatus", (e && e.message) || t("fr_fail"), true); }
}
async function frRemove(id) {
  if (!AUTH.token) return;
  try { await api("/api/friends/remove", { token: AUTH.token, id }); loadFriends(); }
  catch (e) { setStatus("frStatus", (e && e.message) || t("fr_fail"), true); }
}
// Challenge / rematch: create an invite room, then tell the user to send the
// code (shown in #ogCodeBox) to that friend.
function frChallenge(id) {
  if (!requireLogin()) return;
  const btn = $("ogCreate");
  if (btn) btn.click();                     // create a room → code appears in #ogCodeBox
  setStatus("ogSetupStatus", t("fr_challenge_sent").replace("{id}", id), false);
  const board = document.getElementById("tab-online");
  if (board) board.scrollIntoView({ behavior: "smooth", block: "start" });
}
if ($("frAddBtn")) $("frAddBtn").onclick = frAdd;
if ($("frAddInput")) $("frAddInput").addEventListener("keydown", (e) => { if (e.key === "Enter") frAdd(); });

// =========================================================================== //
// HOME HUB — a landing screen of entry points (stats, quick actions, and
// preview cards) instead of dropping straight into a settings panel.
// =========================================================================== //
const HUB_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// tiny non-interactive board used as a card thumbnail
function miniBoard(fen) {
  let map = {};
  try { map = parseFen(fen || HUB_START_FEN); } catch (e) { map = {}; }
  let html = '<div class="miniboard" aria-hidden="true">';
  for (const rank of [8, 7, 6, 5, 4, 3, 2, 1]) {
    for (const f of "abcdefgh") {
      const sq = f + rank, fi = "abcdefgh".indexOf(f);
      const shade = (fi + rank) % 2 === 0 ? "light" : "dark";
      const p = map[sq];
      html += '<div class="msq ' + shade + '">' +
        (p ? '<span class="pc ' + (p === p.toUpperCase() ? "w" : "b") + '">' + GLYPH[p.toLowerCase()] + "</span>" : "") +
        "</div>";
    }
  }
  return html + "</div>";
}

// ONE recommended action for right now — a single, unmissable "what should I do"
// button. Removes choice paralysis; picks by the player's current state.
function pickToday() {
  const T = (typeof t === "function") ? t : ((k) => k);
  // 0) BRAND-NEW user (no games, no puzzles solved): guarantee a first SUCCESS
  // instead of dropping them on a checkmate puzzle. True beginners → lessons.
  const hist0 = (typeof gameHistory === "function") ? gameHistory() : [];
  const solvedN = (PZ && PZ.solved) ? PZ.solved.size : 0;
  const brandNew = (!hist0 || hist0.length === 0) && solvedN === 0;
  if (brandNew && PZ && PZ.list && PZ.list.length) {
    const skill = localStorage.getItem("cc_skill") || "";
    // easiest theme = "hanging piece" (cat 5); force past the sequential lock
    let easy = 0;
    try { easy = pzCatRange(5).start; } catch (e) { easy = 0; }
    if (skill === "new") {
      // Even a rules-beginner needs a first SUCCESS, not just reading. Give the
      // single easiest puzzle (one free capture) with the built-in auto-hint as a
      // safety net, and flag it so loadPuzzle offers the hint early. Lessons stay
      // one tap away in the nav for anyone who wants the rules first.
      return { ic: "🧩", label: T("today_first"), sub: T("today_first_new_s"),
        go: () => { switchTab("puzzle"); loadPuzzle(easy, { force: true, beginner: true }); } };
    }
    return { ic: "🧩", label: T("today_first"), sub: T("today_first_s"),
      go: () => { switchTab("puzzle"); loadPuzzle(easy, { force: true }); } };
  }
  // 1) today's daily puzzle, if not done yet → strongest daily hook
  if (PZ && PZ.list && PZ.list.length && typeof isDailySolved === "function" && !isDailySolved()) {
    const s = (typeof dailyStreakCount === "function") ? dailyStreakCount() : 0;
    const sub = s >= 2 ? T("today_daily_warn").replace("{n}", s) : T("today_daily_s");   // loss-aversion
    return { ic: "🗓️", label: T("today_daily"), sub, go: () => loadDaily() };
  }
  // 1.5) spaced-repetition reviews due → retrieval practice
  if (typeof reviewDue === "function") {
    const rd = reviewDue();
    if (rd.length) return { ic: "🔁", label: T("today_review_q").replace("{n}", rd.length), sub: T("today_review_q_s"), go: () => loadReviewPuzzle() };
  }
  // 2) a recent game to review
  const lastG = (typeof lastPlayedGame === "function") ? lastPlayedGame() : null;
  if (lastG && lastG.moves && lastG.moves.length) {
    return { ic: "📊", label: T("today_review"), sub: T("today_review_s").replace("{opp}", lastG.opponent || ""), go: () => switchTab("review") };
  }
  // 3) unsolved puzzles remain → keep training
  let unsolved = -1;
  try { if (PZ && PZ.list) unsolved = PZ.list.findIndex((p) => !PZ.solved.has(p.level)); } catch (e) {}
  if (unsolved >= 0) {
    return { ic: "🧩", label: T("today_puzzle"), sub: T("today_puzzle_s"), go: () => { switchTab("puzzle"); loadAdaptivePuzzle(); } };
  }
  // 4) fall back to a fresh game vs AI
  return { ic: "🤖", label: T("today_ai"), sub: T("today_ai_s"), go: () => switchTab("ai") };
}
// ---- ADD3: "이어서 하기" — remember the last place the user was actively working
// so a returning session is one tap away, instead of re-navigating the whole tree.
function setResume(obj) {
  try { localStorage.setItem("cc_resume", JSON.stringify({ ...obj, ts: Date.now() })); } catch (e) {}
}
function getResume() {
  try {
    const r = JSON.parse(localStorage.getItem("cc_resume") || "null");
    if (!r || !r.ts || (Date.now() - r.ts) > 3 * 24 * 3600 * 1000) return null;   // stale after 3 days
    return r;
  } catch (e) { return null; }
}
function renderResume() {
  const el = document.getElementById("hubResume"); if (!el) return;
  const r = getResume();
  if (!r) { el.hidden = true; return; }
  let ic = "▶", label = "", sub = "", go = null;
  if (r.kind === "puzzle" && typeof loadPuzzle === "function") {
    ic = "🧩"; label = t("resume_puzzle"); sub = t("resume_puzzle_s");
    go = () => { switchTab("puzzle"); const idx = (typeof r.idx === "number") ? r.idx : 0; loadPuzzle(idx, { force: true }); };
  } else if (r.kind === "ai") {
    ic = "🤖"; label = t("resume_ai"); sub = t("resume_ai_s");
    go = () => { switchTab("ai"); };
  } else if (r.kind === "learn") {
    ic = "📖"; label = t("resume_learn"); sub = t("resume_learn_s");
    go = () => { switchTab("learn"); if (r.topic && typeof showLearn === "function") try { showLearn(r.topic); } catch (e) {} };
  } else { el.hidden = true; return; }
  el.innerHTML =
    '<span class="ht-ic">' + ic + "</span>" +
    '<span class="ht-txt"><span class="ht-k">' + t("resume_kicker") + '</span>' +
      '<b>' + label + "</b><span class='ht-sub'>" + sub + "</span></span>" +
    '<span class="ht-go">↩</span>';
  el.hidden = false;
  el.onclick = go;
}

// ADD9: a "다음 할 일" action for result screens — reuses pickToday's prioritization
// so a finished game/puzzle never dead-ends. Returns null when the natural next step
// is already offered on that screen (passed in `skipIcons`).
function nextTodoAction(skipIcons) {
  try {
    const a = pickToday();
    if (skipIcons && skipIcons.indexOf(a.ic) >= 0) return null;
    return { label: "➡ " + a.label, onClick: () => { if (typeof hideResult === "function") hideResult(); a.go(); } };
  } catch (e) { return null; }
}

// ADD4: first-run 3-step checklist (규칙 → 첫 퍼즐 → 첫 대국) — shown only to a
// brand-new user, with ticks that fill as each step is completed.
function renderStarter() {
  const el = document.getElementById("hubStarter"); if (!el) return;
  const T = (typeof t === "function") ? t : ((k) => k);
  const hist = (typeof gameHistory === "function") ? gameHistory() : [];
  const solved = (typeof PZ !== "undefined" && PZ.solved) ? PZ.solved.size : 0;
  const brandNew = (!hist || !hist.length) && solved === 0 && localStorage.getItem("cc_starter_done") !== "1";
  if (!brandNew) { el.hidden = true; return; }
  const learned = localStorage.getItem("cc_starter_learn") === "1";
  const steps = [
    { done: learned, ic: "📖", label: T("start_s1"), go: () => { localStorage.setItem("cc_starter_learn", "1"); switchTab("learn"); } },
    { done: solved > 0, ic: "🧩", label: T("start_s2"), go: () => { switchTab("puzzle"); if (typeof loadAdaptivePuzzle === "function") loadAdaptivePuzzle(); } },
    { done: hist.length > 0, ic: "🤖", label: T("start_s3"), go: () => { switchTab("ai"); } },
  ];
  if (steps.every((s) => s.done)) { localStorage.setItem("cc_starter_done", "1"); el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    '<div class="st-head"><b>🌱 ' + T("start_title") + '</b><span class="st-sub">' + T("start_sub") + "</span></div>" +
    '<div class="st-list">' + steps.map((s, i) =>
      '<button class="st-step' + (s.done ? " done" : "") + '" data-ststep="' + i + '">' +
      '<span class="st-ck">' + (s.done ? "✅" : (i + 1)) + '</span><span class="st-ic">' + s.ic +
      '</span><span class="st-lbl">' + s.label + "</span></button>").join("") + "</div>";
  el.querySelectorAll(".st-step").forEach((b, i) => { b.onclick = steps[i].go; });
}

function renderHubToday() {
  const el = document.getElementById("hubToday"); if (!el) return;
  const a = pickToday();
  el.innerHTML =
    '<span class="ht-ic">' + a.ic + "</span>" +
    '<span class="ht-txt"><span class="ht-k">' + t("today_kicker") + '</span>' +
      '<b>' + a.label + "</b><span class='ht-sub'>" + a.sub + "</span></span>" +
    '<span class="ht-go">▶</span>';
  el.hidden = false;
  el.onclick = a.go;
}

// ---- daily quests: 3 light goals that reset each day (drives session depth) ----
const QUEST_DEFS = [
  { k: "puzzles", goal: 3, ic: "🧩", key: "quest_puzzles" },
  { k: "aiGames", goal: 1, ic: "🤖", key: "quest_ai" },
  { k: "reviews", goal: 1, ic: "📊", key: "quest_review" },
];
function questsToday() {
  let q; try { q = JSON.parse(localStorage.getItem("cc_quests") || "{}") || {}; } catch (e) { q = {}; }
  if (q.date !== dateStr()) q = { date: dateStr(), puzzles: 0, aiGames: 0, reviews: 0 };
  return q;
}
function questBump(kind) {
  const q = questsToday(); q[kind] = (q[kind] || 0) + 1;
  localStorage.setItem("cc_quests", JSON.stringify(q));
  const home = document.getElementById("tab-home");
  if (home && home.classList.contains("active")) renderQuests();
}
function renderQuests() {
  const el = document.getElementById("hubQuests"); if (!el) return;
  const q = questsToday();
  const doneN = QUEST_DEFS.filter((d) => (q[d.k] || 0) >= d.goal).length;
  const allDone = doneN >= QUEST_DEFS.length;
  const pct = Math.round(doneN / QUEST_DEFS.length * 100);
  el.innerHTML =
    '<div class="hq-head"><b>' + t("quest_title") + "</b>" +
      '<span class="hq-count">' + doneN + "/" + QUEST_DEFS.length +
      (allDone ? " ✓" : "") + "</span></div>" +
    '<div class="hq-track"><div class="hq-track-fill" style="width:' + pct + '%"></div></div>' +
    (allDone ? '<div class="hq-alldone">🎉 ' + t("quest_all") + "</div>" : "") +
    '<div class="hq-list">' + QUEST_DEFS.map((d) => {
      const n = Math.min(q[d.k] || 0, d.goal), ok = n >= d.goal;
      return '<div class="hq-item' + (ok ? " ok" : "") + '"><span class="hq-ic">' + (ok ? "✅" : d.ic) + "</span>" +
        '<span class="hq-txt">' + t(d.key) + "</span>" +
        '<span class="hq-prog">' + n + "/" + d.goal + "</span></div>";
    }).join("") + "</div>";
}

// ---- XP: earned only from LEARNING signals (first-time puzzle solves, reviews,
// daily/streak) — never from grinding, since solved puzzles never re-award. ----
function xpGet() { return +(localStorage.getItem("cc_xp") || 0); }
function xpLevel(xp) { return Math.floor(Math.sqrt((xp || 0) / 60)) + 1; }
function xpForLevel(lv) { return (lv - 1) * (lv - 1) * 60; }
function xpAdd(n) {
  if (!n) return;
  if (typeof leagueAdd === "function") leagueAdd(n);   // ADD8: XP also scores weekly-league points
  const before = xpLevel(xpGet());
  const v = xpGet() + n; localStorage.setItem("cc_xp", String(v));
  if (typeof authSchedulePush === "function") authSchedulePush();
  const home = document.getElementById("tab-home");
  if (home && home.classList.contains("active")) renderXp();
  if (xpLevel(v) > before && typeof shareFlash === "function") shareFlash(t("xp_levelup").replace("{n}", xpLevel(v)));
}
function renderXp() {
  const el = document.getElementById("hubXp"); if (!el) return;
  const xp = xpGet(), lv = xpLevel(xp), cur = xpForLevel(lv), next = xpForLevel(lv + 1);
  const pct = Math.max(0, Math.min(100, (xp - cur) / Math.max(1, next - cur) * 100));
  el.innerHTML = '<div class="xp-row"><span class="xp-lv">Lv ' + lv + "</span>" +
    '<div class="xp-bar"><div class="xp-fill" style="width:' + pct + '%"></div></div>' +
    '<span class="xp-num">' + (xp - cur) + " / " + (next - cur) + " XP</span></div>";
}

function renderHome() {
  const T = (typeof t === "function") ? t : ((k) => k);
  renderResume();
  renderStarter();
  renderHubToday();
  renderQuests();
  renderXp();
  const hello = $("hubHello");
  if (hello) hello.textContent = (AUTH && AUTH.id) ? T("hub_hi").replace("{id}", AUTH.id) : "Matevio";

  // ---- stat tiles ----
  const hist = (typeof gameHistory === "function") ? gameHistory() : [];
  const wins = hist.filter((g) => g.result === "win").length;
  const losses = hist.filter((g) => g.result === "loss").length;
  const wr = (wins + losses) ? Math.round(wins / (wins + losses) * 100) : 0;
  let solved = 0;
  try { solved = (JSON.parse(localStorage.getItem("cc_puzzles_solved") || "[]") || []).length; } catch (e) {}
  const total = (PZ && PZ.list && PZ.list.length) ? PZ.list.length : 100;
  const st = $("hubStats");
  // 🔥 tile now shows the DAILY-visit streak (the number to defend each day),
  // not the all-time AI win streak — the retention metric belongs on the home.
  const dstreak = (typeof dailyStreakCount === "function") ? dailyStreakCount() : 0;
  if (st) st.innerHTML = [
    { ic: "🔥", k: T("hub_streak"),  v: String(dstreak) },
    { ic: "🧩", k: T("hub_puzzles"), v: solved + "<span class='hs-sm'>/" + total + "</span>" },
    { ic: "♟️", k: T("hub_rating"),  v: (typeof ratingHTML === "function" ? ratingHTML(myRating()) : myRating()) },
    { ic: "📊", k: T("hub_winrate"), v: wr + "<span class='hs-sm'>%</span>" },
  ].map((s) => '<div class="hub-stat"><span class="hs-ic">' + s.ic + '</span>' +
      '<div class="hs-txt"><div class="hs-k">' + s.k + '</div><div class="hs-v">' + s.v + "</div></div></div>").join("");

  // ---- primary action list ----
  const acts = [
    { ic: "⚡", label: T("hub_a_quick"),  sub: T("hub_a_quick_s"),  go: () => { switchTab("online"); } },
    { ic: "🤖", label: T("hub_a_ai"),     sub: T("hub_a_ai_s"),     go: () => { switchTab("ai"); } },
    { ic: "🤝", label: T("hub_a_friend"), sub: T("hub_a_friend_s"), go: () => { switchTab("online"); } },
    { ic: "🎲", label: T("hub_a_960"),    sub: T("hub_a_960_s"),    go: () => { switchTab("ai"); const c = $("ai960"); if (c) c.checked = true; } },
  ];
  const ael = $("hubActions");
  if (ael) {
    ael.innerHTML = acts.map((a, i) =>
      '<button class="hub-act" data-i="' + i + '"><span class="ha-ic">' + a.ic + '</span>' +
      '<span class="ha-txt"><b>' + a.label + "</b><span>" + a.sub + "</span></span>" +
      '<span class="ha-go">›</span></button>').join("");
    ael.querySelectorAll(".hub-act").forEach((b) => { b.onclick = () => acts[+b.dataset.i].go(); });
  }

  // ---- preview cards (board thumbnail + CTA) ----
  let pzFen = HUB_START_FEN;
  try {
    if (PZ && PZ.list && PZ.list.length) {
      const nxt = PZ.list.find((p) => !PZ.solved.has(p.level)) || PZ.list[0];
      if (nxt && nxt.fen) pzFen = nxt.fen;
    }
  } catch (e) {}
  // distinct, recognizable positions per card (not three identical starts)
  const LEARN_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const REVIEW_FEN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5";
  const cards = [
    { emo: "🧩", title: T("hub_c_puzzle"), sub: T("hub_c_puzzle_s"), cta: T("hub_c_puzzle_cta"), fen: pzFen,      go: () => switchTab("puzzle") },
    { emo: "📖", title: T("hub_c_learn"),  sub: T("hub_c_learn_s"),  cta: T("hub_c_learn_cta"),  fen: LEARN_FEN,  go: () => switchTab("learn") },
    { emo: "📊", title: T("hub_c_review"), sub: T("hub_c_review_s"), cta: T("hub_c_review_cta"), fen: REVIEW_FEN, go: () => switchTab("review") },
  ];
  // the Review card shows YOUR last game's final position (fetched async)
  const lastG = (typeof lastPlayedGame === "function") ? lastPlayedGame() : null;
  if (lastG) {
    cards[2].sub = T("hub_c_last").replace("{opp}", lastG.opponent || "");
    cards[2].go = () => switchTab("review");   // review tab auto-loads it
  }
  const cel = $("hubCards");
  if (cel) {
    cel.innerHTML = cards.map((c, i) =>
      '<div class="hub-card" data-i="' + i + '">' +
        '<div class="hc-head"><b><span class="hc-emo">' + c.emo + "</span>" + c.title + "</b><span>" + c.sub + "</span></div>" +
        '<div class="hc-mini" data-mini="' + i + '">' + miniBoard(c.fen) + "</div>" +
        '<button class="ghost hc-cta">' + c.cta + "</button></div>").join("");
    cel.querySelectorAll(".hub-card").forEach((d) => { d.onclick = () => cards[+d.dataset.i].go(); });
    // replace the review thumbnail with the last game's final position
    if (lastG) {
      api("/api/legal", { moves: lastG.moves }).then((st) => {
        const slot = cel.querySelector('[data-mini="2"]');
        if (slot && st && st.fen) slot.innerHTML = miniBoard(st.fen);
      }).catch(() => {});
    }
  }
}
try { renderHome(); } catch (e) {}
try { renderAiLevels(); } catch (e) {}

// ---- FIX4: conditional daily reminder. Stamp today's visit + current streak so
// the service worker can SKIP the notification on days the user already opened
// the app, and word it around the streak they'd lose. Written on every load. ----
async function stampVisitState() {
  try {
    const c = await caches.open("matevio-msg");
    const streak = (typeof dailyStreakCount === "function") ? dailyStreakCount() : 0;
    const dailyDone = (typeof isDailySolved === "function") ? !!isDailySolved() : false;
    await c.put("/__reminder_state", new Response(JSON.stringify({
      date: (typeof dateStr === "function") ? dateStr() : "",
      streak, dailyDone,
      title: (typeof t === "function") ? t("notif_title") : "",
      body: (typeof t === "function") ? t("notif_body") : "",
      body_streak: (typeof t === "function") ? t("notif_body_streak") : "",
    }), { headers: { "Content-Type": "application/json" } }));
  } catch (e) {}
}
try { stampVisitState(); } catch (e) {}

// ---- ADD5: install + notification soft-ask, surfaced ONCE right after the
// user's first success (a puzzle solve or an AI win) — the moment they've felt
// the product work, not on cold load. Non-blocking bottom card. ----
function maybeFirstSuccessSoftAsk() {
  try {
    if (localStorage.getItem("cc_softask") === "1") return;
    // don't stack on top of the guest save-progress banner
    const sb = document.getElementById("saveBanner");
    if (sb && !sb.classList.contains("hidden")) return;
    const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    const canInstall = !standalone && !!window.__pwaDeferred;
    const canNotify = ("Notification" in window) && Notification.permission === "default";
    if (!canInstall && !canNotify) return;   // nothing useful to ask → skip (and don't burn the one-shot)
    localStorage.setItem("cc_softask", "1");
    const card = document.getElementById("softAsk"); if (!card) return;
    const iBtn = document.getElementById("softAskInstall");
    const nBtn = document.getElementById("softAskNotify");
    if (iBtn) iBtn.style.display = canInstall ? "" : "none";
    if (nBtn) nBtn.style.display = canNotify ? "" : "none";
    card.classList.remove("hidden");
  } catch (e) {}
}
(function wireSoftAsk() {
  const card = document.getElementById("softAsk"); if (!card) return;
  const close = () => card.classList.add("hidden");
  const x = document.getElementById("softAskClose");
  const later = document.getElementById("softAskLater");
  const iBtn = document.getElementById("softAskInstall");
  const nBtn = document.getElementById("softAskNotify");
  if (x) x.onclick = close;
  if (later) later.onclick = close;
  if (iBtn) iBtn.onclick = async () => {
    close();
    if (window.__pwaPrompt) { try { await window.__pwaPrompt(); } catch (e) {} }
  };
  if (nBtn) nBtn.onclick = async () => {
    close();
    const tog = document.getElementById("setRemind");
    if (tog) tog.checked = true;
    if (typeof setReminder === "function") { try { await setReminder(true); } catch (e) {} }
  };
})();
