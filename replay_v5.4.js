/*
 * NEON TETRIS v5.4-mobile — replay_v5.4.js
 * ---------------------------------------------------------------
 * Port of tetris.py (v5.3) section 8 (ReplayRecorder / decode_events / ReplayStore /
 * ReplayPlayer) + ReplayView + the replay list page (build_replays / replay_title).
 *
 *  - Recording: every game (classic / sprint / multi) - the GameRunner "record" events
 *    (game time ms excluding pauses, event code). Packed like tetris.py: one integer
 *    per event = delta_ms * 16 + code. Codes 0-8 = tetris.py, plus (v5.4)
 *    9 GARB / 10 GARB_AWAIT (one garbage line received before / during a line clear)
 *    and 11 LVL_ON / 12 LVL_OFF / 13-14 the same during a line clear (level mode toggled
 *    mid-game - tetris.py replays desynced there), so a multiplayer game
 *    (seed + rules + limits + garbage) replays exactly.
 *  - Storage: localStorage "nt54_rpl_<YYYYMMDD_HHMMSS_mode>.rpl" (one key per replay,
 *    like the replays/ folder). tetris.py gzips the JSON; here the packed ints are
 *    written as a 5-bit varint symbol stream, LZW-compressed and packed 15 bits per
 *    UTF-16 char (synchronous - saving happens inside finalize_game). Limits:
 *    MAX_REPLAYS 30 (oldest first, sprint TOP-10 replays protected), MAX_REPLAY_EVENTS
 *    150000 (truncated flag), plus a total-size budget; QuotaExceeded -> evict the
 *    oldest unprotected replay and retry, finally give up (null, the game goes on).
 *  - Playback: a separate, deterministic seeded NT.GameCore re-simulated from the
 *    events (never a video). Speeds 0.5x / 1x / 2x / 4x, seekable progress bar,
 *    pause / restart / ±5 s / step to the next piece, line-clear flash, effects + sound.
 * Exposed as window.NT.Replay. UI glue only runs when a document + NT.UI exist.
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});
  var EV = NT.EV;
  var W = NT.WIDTH, H = NT.HEIGHT;
  var CLEAR_FRAMES = NT.CLEAR_FRAMES, CLEAR_FRAME_MS = NT.CLEAR_FRAME_MS, CLEAR_TOTAL_MS = NT.CLEAR_TOTAL_MS;

  var MAX_REPLAYS = 30;               // 리플레이 보관 개수 (넘으면 오래된 것부터 삭제)
  var MAX_REPLAY_EVENTS = 150000;     // 리플레이 1개당 이벤트 상한 (용량 보호)
  var MAX_TOTAL_CHARS = 1500000;      // all replays together (UTF-16 chars, ~3 MB) - leaves room for the other stores
  var KEY_PREFIX = "rpl_";
  var SPEEDS = [0.5, 1.0, 2.0, 4.0];

  function isDict(d) { return d !== null && typeof d === "object" && !Array.isArray(d); }
  function int(v) { var n = Number(v); return isFinite(n) ? Math.trunc(n) : 0; }

  // ==========================================================
  // Event codec: packed ints -> varint symbols (0..63) -> LZW -> 15-bit chars
  // ==========================================================
  var MAX_DICT = 1 << 16;
  function width(n) { var b = 1; while ((1 << b) < n) b++; return b; }     // bits for values 0..n-1

  function toSymbols(ints) {
    var out = [];
    for (var i = 0; i < ints.length; i++) {
      var v = Math.max(0, Math.trunc(ints[i]) || 0);
      do {
        var d = v % 32;
        v = Math.floor(v / 32);
        out.push(v > 0 ? d | 32 : d);
      } while (v > 0);
    }
    return out;
  }

  function fromSymbols(syms) {
    var out = [], v = 0, mul = 1;
    for (var i = 0; i < syms.length; i++) {
      var s = syms[i];
      v += (s & 31) * mul;
      if (s & 32) mul *= 32;
      else { out.push(v); v = 0; mul = 1; }
    }
    if (mul !== 1) throw new Error("truncated varint");
    return out;
  }

  function BitWriter() { this.parts = []; this.buf = 0; this.bits = 0; }
  BitWriter.prototype.put = function (code, w) {
    this.buf = this.buf * Math.pow(2, w) + code;
    this.bits += w;
    while (this.bits >= 15) {
      var p = Math.pow(2, this.bits - 15);
      var chunk = Math.floor(this.buf / p);
      this.buf -= chunk * p;
      this.bits -= 15;
      this.parts.push(String.fromCharCode(32 + chunk));
    }
  };
  BitWriter.prototype.done = function () {
    if (this.bits > 0) this.put(0, 15 - this.bits);
    return this.parts.join("");
  };

  function BitReader(s) { this.s = s; this.pos = 0; this.buf = 0; this.bits = 0; }
  BitReader.prototype.get = function (w) {
    while (this.bits < w) {
      if (this.pos >= this.s.length) throw new Error("unexpected end of data");
      var ch = this.s.charCodeAt(this.pos++) - 32;
      if (ch < 0 || ch > 32767) throw new Error("bad char");
      this.buf = this.buf * 32768 + ch;
      this.bits += 15;
    }
    var p = Math.pow(2, this.bits - w);
    var v = Math.floor(this.buf / p);
    this.buf -= v * p;
    this.bits -= w;
    return v;
  };

  /** ints -> {z: string, n: LZW code count} */
  function compressEvents(ints) {
    var syms = toSymbols(ints);
    var bw = new BitWriter(), n = 0;
    if (!syms.length) return { z: "", n: 0 };
    var dict = new Map(), next = 64, w = syms[0];
    for (var i = 1; i < syms.length; i++) {
      var c = syms[i], key = w * 64 + c, k = dict.get(key);
      if (k !== undefined) { w = k; continue; }
      bw.put(w, width(next)); n++;
      if (next < MAX_DICT) dict.set(key, next++);
      w = c;
    }
    bw.put(w, width(next)); n++;
    return { z: bw.done(), n: n };
  }

  function decompressEvents(z, n) {
    if (!n) return [];
    var br = new BitReader(z);
    var prefix = new Int32Array(MAX_DICT), last = new Uint8Array(MAX_DICT), first = new Uint8Array(MAX_DICT);
    var i;
    for (i = 0; i < 64; i++) { prefix[i] = -1; last[i] = i; first[i] = i; }
    var out = [], stack = [];
    function emit(code) {
      stack.length = 0;
      for (var c = code; c !== -1; c = prefix[c]) stack.push(last[c]);
      for (var j = stack.length - 1; j >= 0; j--) out.push(stack[j]);
    }
    var next = 64, prev = br.get(width(64));
    if (prev >= 64) throw new Error("bad first code");
    emit(prev);
    for (i = 1; i < n; i++) {
      var code = br.get(width(Math.min(next + 1, MAX_DICT)));
      var fch;
      if (code < next) fch = first[code];
      else if (code === next && next < MAX_DICT) fch = first[prev];
      else throw new Error("bad code");
      if (next < MAX_DICT) {
        prefix[next] = prev; last[next] = fch; first[next] = first[prev];
        next++;
      }
      emit(code);
      prev = code;
    }
    return fromSymbols(out);
  }

  // ==========================================================
  // ReplayRecorder / decode_events
  // ==========================================================
  function ReplayRecorder(seed, mode, levelMode, sprintTarget, rules, limits) {
    this.seed = seed >>> 0;
    this.mode = mode;
    this.level_mode = !!levelMode;
    this.sprint_target = sprintTarget || 0;
    this.rules = rules || null;          // multiplayer only (match rules / limits)
    this.limits = limits || null;
    this.events = [];
    this.last_t = 0;
    this.truncated = false;
  }
  ReplayRecorder.prototype.add = function (tMs, code) {
    if (this.events.length >= MAX_REPLAY_EVENTS) { this.truncated = true; return; }
    var dt = Math.max(0, Math.trunc(tMs) - this.last_t);
    this.last_t += dt;
    this.events.push(dt * 16 + code);
  };
  /** recorder for a GameRunner's current game */
  ReplayRecorder.forRunner = function (r) {
    var c = r.core, multi = r.mode === "multi";
    var rec = new ReplayRecorder(c.seed, r.mode, c.level_mode, c.sprint_target,
                                 multi ? c.rules : null, multi ? c.limits : null);
    rec.core = c;
    return rec;
  };

  function decodeEvents(packed) {
    var out = [], t = 0;
    for (var i = 0; i < packed.length; i++) {
      var v = packed[i];
      t += Math.floor(v / 16);
      out.push([t, v % 16]);
    }
    return out;
  }

  // ==========================================================
  // ReplayStore (localStorage; one key per replay)
  // ==========================================================
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function stampOf(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  function isQuota(e) {
    return !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
                   e.code === 22 || e.code === 1014);
  }

  function ReplayStore(backend, prefix) {
    this.backend = backend || null;
    this.prefix = (prefix === undefined ? "nt54_" : prefix) + KEY_PREFIX;
    this.lastError = null;
  }
  var SP = ReplayStore.prototype;
  SP._ls = function () {
    if (this.backend) return this.backend;
    try { return global.localStorage || null; } catch (e) { return null; }
  };
  SP._get = function (name) {
    var ls = this._ls();
    if (!ls) return null;
    try { return ls.getItem(this.prefix + name); } catch (e) { return null; }
  };
  SP._remove = function (name) {
    var ls = this._ls();
    try { if (ls) { ls.removeItem(this.prefix + name); return true; } } catch (e) { /* ignore */ }
    return false;
  };

  /** sorted names (= time order, oldest first) */
  SP.files = function () {
    var ls = this._ls(), out = [];
    if (!ls) return out;
    try {
      var n = ls.length;
      for (var i = 0; i < n; i++) {
        var k = ls.key(i);
        if (typeof k === "string" && k.indexOf(this.prefix) === 0 && /\.rpl$/.test(k)) out.push(k.slice(this.prefix.length));
      }
    } catch (e) { /* ignore */ }
    return out.sort();
  };

  SP.sizes = function () {
    var self = this, out = {};
    this.files().forEach(function (n) { var v = self._get(n); out[n] = v ? v.length : 0; });
    return out;
  };

  SP._unique = function (stamp, mode) {
    var have = {};
    this.files().forEach(function (n) { have[n] = true; });
    var name = stamp + "_" + mode + ".rpl", n = 1;
    while (have[name]) { n += 1; name = stamp + "_" + mode + "_" + n + ".rpl"; }
    return name;
  };

  /** save -> name, or null (failure never stops the game) */
  SP.save = function (rec, meta, protectedNames, date) {
    this.lastError = null;
    var ls = this._ls();
    try {
      if (!ls) throw new Error("storage unavailable");
      var name = this._unique(stampOf(date || new Date()), rec.mode);
      var packed = compressEvents(rec.events);
      var data = {
        v: 1, mode: rec.mode, seed: rec.seed,
        level_mode: rec.level_mode, sprint_target: rec.sprint_target,
        truncated: rec.truncated, enc: "lzw15", evn: rec.events.length, evc: packed.n, evz: packed.z
      };
      if (rec.rules) data.rules = rec.rules;
      if (rec.limits && Object.keys(rec.limits).length) data.limits = rec.limits;
      Object.keys(meta || {}).forEach(function (k) { if (k !== "ev" && k !== "evz") data[k] = meta[k]; });
      var text = JSON.stringify(data);
      var keep = {};
      (protectedNames || []).forEach(function (n) { if (n) keep[n] = true; });
      keep[name] = true;
      // make room for the size budget first, then write; QuotaExceeded -> evict oldest and retry
      this.prune(keep, text.length);
      for (;;) {
        try {
          ls.setItem(this.prefix + name, text);
          break;
        } catch (e) {
          if (!isQuota(e) || !this._evictOldest(keep)) throw e;
        }
      }
      this.prune(keep, 0);
      return name;
    } catch (e) {
      this.lastError = isQuota(e) ? "quota" : String(e && e.message || e);
      try { console.warn("[경고] 리플레이 저장 실패: " + e); } catch (e2) { /* ignore */ }
      return null;
    }
  };

  SP._evictOldest = function (keep) {
    var names = this.files();
    for (var i = 0; i < names.length; i++) {
      if (!keep[names[i]]) return this._remove(names[i]);
    }
    return false;
  };

  /** MAX_REPLAYS (+ size budget): delete the oldest unprotected replays */
  SP.prune = function (keep, extraChars) {
    keep = keep || {};
    if (Array.isArray(keep)) { var k2 = {}; keep.forEach(function (n) { k2[n] = true; }); keep = k2; }
    var names = this.files();
    var sizes = this.sizes();
    var total = (extraChars || 0);
    names.forEach(function (n) { total += sizes[n] || 0; });
    var extra = names.length + (extraChars ? 1 : 0) - MAX_REPLAYS;
    for (var i = 0; i < names.length; i++) {             // names are in time order -> oldest first
      if (extra <= 0 && total <= MAX_TOTAL_CHARS) break;
      var n = names[i];
      if (keep[n]) continue;
      if (this._remove(n)) { extra -= 1; total -= sizes[n] || 0; }
    }
  };

  /** full data incl. decoded ev (list of packed ints), or null */
  SP.load = function (name) {
    try {
      var raw = this._get(name);
      if (raw === null || raw === undefined) return null;
      var data = JSON.parse(raw);
      if (!isDict(data)) return null;
      if (!Array.isArray(data.ev)) {
        if (typeof data.evz !== "string") return null;
        var ev = decompressEvents(data.evz, int(data.evc));
        if (data.evn !== undefined && ev.length !== int(data.evn)) return null;
        data.ev = ev;
      }
      if (!data.ev.every(function (v) { return typeof v === "number" && v >= 0 && isFinite(v); })) return null;
      delete data.evz;
      return data;
    } catch (e) {
      return null;
    }
  };

  /** meta only (no decompression) */
  SP.loadMeta = function (name) {
    try {
      var raw = this._get(name);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!isDict(data) || (typeof data.evz !== "string" && !Array.isArray(data.ev))) return null;
      delete data.evz; delete data.ev;
      return data;
    } catch (e) { return null; }
  };

  SP.delete = function (name) { return this._get(name) !== null && this._remove(name); };

  /** [[name, meta]] newest first; corrupt entries skipped */
  SP.listing = function () {
    var out = [], names = this.files().reverse();
    for (var i = 0; i < names.length; i++) {
      var m = this.loadMeta(names[i]);
      if (m !== null) out.push([names[i], m]);
    }
    return out;
  };

  // ==========================================================
  // ReplayPlayer
  // ==========================================================
  var AWAIT_CODES = {};
  AWAIT_CODES[EV.GARB_AWAIT] = AWAIT_CODES[EV.LVL_ON_AWAIT] = AWAIT_CODES[EV.LVL_OFF_AWAIT] = true;
  function ReplayPlayer(data) {
    this.data = data;
    this.events = decodeEvents(data.ev || []);
    this.duration = int(data.duration_ms || (this.events.length ? this.events[this.events.length - 1][0] : 0));
    this.reset();
  }
  var PP = ReplayPlayer.prototype;

  PP.reset = function () {
    var d = this.data;
    this.core = new NT.GameCore(int(d.seed || 0) >>> 0, d.level_mode === undefined ? true : !!d.level_mode,
                                int(d.sprint_target || 0), d.rules || null, d.limits || null);
    this.idx = 0;
    this.pending = null;          // [lock info, clear-animation end time]
    this.t = 0;
  };

  Object.defineProperty(PP, "ended", {
    // (v5.4: a finished / topped-out core also counts - multiplayer garbage can follow the end)
    get: function () {
      return this.pending === null && (this.idx >= this.events.length || this.core.game_over || this.core.finished);
    }
  });

  /** line-clear flash: [rows, step] or null */
  PP.anim = function () {
    if (this.pending === null) return null;
    var end = this.pending[1];
    var step = Math.min(CLEAR_FRAMES, Math.floor((this.t - (end - CLEAR_TOTAL_MS)) / CLEAR_FRAME_MS) + 1);
    return [this.pending[0].rows, Math.max(1, step)];
  };

  PP._apply = function (code) {
    var c = this.core;
    switch (code) {
      case EV.LEFT: c.move(-1, 0); break;
      case EV.RIGHT: c.move(1, 0); break;
      case EV.SOFT: c.soft_drop(); break;
      case EV.CW: c.rotate(1); break;
      case EV.CCW: c.rotate(-1); break;
      case EV.HOLD: c.hold(); break;
      case EV.GRAV: c.gravity_step(); break;
      case EV.HARD: return c.hard_drop();
      case EV.LOCK: return c.lock();
      case EV.GARB: case EV.GARB_AWAIT: c.receive_garbage(1); break;
      case EV.LVL_ON: case EV.LVL_ON_AWAIT: c.level_mode = true; break;
      case EV.LVL_OFF: case EV.LVL_OFF_AWAIT: c.level_mode = false; break;
    }
    return null;
  };

  /** apply every event up to t_ms; returns the outcomes (for effects / sound) */
  PP.advance_to = function (tMs) {
    this.t = tMs;
    var outcomes = [];
    for (;;) {
      var nxt = this.idx < this.events.length ? this.events[this.idx] : null;
      if (this.pending !== null) {
        // garbage / level toggles that happened during the clear animation belong before the resolve
        if (nxt !== null && AWAIT_CODES[nxt[1]] && nxt[0] <= tMs) {
          this.idx += 1;
          this._apply(nxt[1]);
          continue;
        }
        if ((nxt !== null && nxt[0] <= tMs) || tMs >= this.pending[1]) {
          this.pending = null;
          outcomes.push(this.core.resolve());
          continue;
        }
        break;
      }
      if (nxt === null || nxt[0] > tMs || this.core.game_over || this.core.finished) break;
      this.idx += 1;
      var info = this._apply(nxt[1]);
      if (info) {
        if (info.rows.length && !info.lockout) this.pending = [info, nxt[0] + CLEAR_TOTAL_MS];
        else if (info.outcome) outcomes.push(info.outcome);
      }
    }
    return outcomes;
  };

  /** jump anywhere (re-simulated from the start) */
  PP.seek = function (tMs) {
    this.reset();
    return this.advance_to(tMs);
  };

  /** time of the next piece placement (hard drop / lock) at or after the cursor, or null */
  PP.next_lock_time = function () {
    for (var i = this.idx; i < this.events.length; i++) {
      var code = this.events[i][1];
      if (code === EV.HARD || code === EV.LOCK) return this.events[i][0];
    }
    return null;
  };

  // ==========================================================
  // replay_title (list / view label)
  // ==========================================================
  function fmtTime(ms) { return NT.fmtTime(ms); }
  function fmtDur(ms) { return NT.Stores ? NT.Stores.fmtDur(ms) : Math.floor(int(ms) / 1000) + "초"; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function modeName(m) { return m === "sprint" ? "스프린트" : m === "multi" ? "멀티" : "일반"; }
  function resultText(meta) {
    var outcome = meta.outcome;
    if (meta.mode === "sprint") {
      return outcome === "cleared" ? "완주 " + fmtTime(meta.time_ms)
        : (outcome === "gameover" ? "실패" : "중단") + " " + int(meta.lines) + "/" + NT.SPRINT_LINES + "줄";
    }
    if (meta.mode === "multi") {
      return (outcome === "win" ? "승리" : outcome === "aborted" ? "중단" : "탈락") + " · " + int(meta.lines) + "줄";
    }
    return num(meta.score) + "점 · " + int(meta.lines) + "줄" + (outcome === "aborted" ? " (중단)" : "");
  }
  function replayTitle(meta) {
    return String(meta.date === undefined ? "" : meta.date).slice(0, 16) + "   " + modeName(meta.mode) + "   " +
      resultText(meta) + "   [" + fmtDur(meta.duration_ms || 0) + "]";
  }

  var Replay = {
    VERSION: "5.4-mobile",
    MAX_REPLAYS: MAX_REPLAYS, MAX_REPLAY_EVENTS: MAX_REPLAY_EVENTS, MAX_TOTAL_CHARS: MAX_TOTAL_CHARS,
    SPEEDS: SPEEDS,
    ReplayRecorder: ReplayRecorder, ReplayStore: ReplayStore, ReplayPlayer: ReplayPlayer,
    decodeEvents: decodeEvents, compressEvents: compressEvents, decompressEvents: decompressEvents,
    replayTitle: replayTitle, resultText: resultText, modeName: modeName
  };
  NT.Replay = Replay;

  // ==========================================================
  // UI glue (browser only)
  // ==========================================================
  var doc = global.document;
  if (!doc || !NT.UI) return;
  var UI = NT.UI;
  var store = new ReplayStore(null, "nt54_");
  Replay.store = store;

  function mk(tag, cls, txt, parent) {
    var d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined && txt !== null) d.textContent = txt;
    if (parent) parent.appendChild(d);
    return d;
  }
  function btn(parent, label, fn, cls) {
    var b = mk("button", "btn" + (cls ? " " + cls : ""), label, parent);
    b.addEventListener("click", fn);
    return b;
  }

  // ---------------- recording (Tetris.restart / rec / finalize_game) ----------------
  function attach(r) {
    r.replayRecorder = ReplayRecorder.forRunner(r);
    r.on("record", function (ms, code) {
      var rec = r.replayRecorder;
      if (!rec || rec.core !== r.core) rec = r.replayRecorder = ReplayRecorder.forRunner(r);   // runner.restart()
      if (!r.game_over && !r.finished) rec.add(ms, code);
    });
  }
  UI.on("newgame", attach);

  UI.on("finalize", function (summary, r) {
    var rec = r && r.replayRecorder;
    if (!rec || rec.core !== r.core || !rec.events.length) return;
    var meta = { date: summary.date, outcome: summary.outcome, score: summary.score,
                 lines: summary.lines, time_ms: summary.time_ms,
                 duration_ms: summary.time_ms + CLEAR_TOTAL_MS, apm: Math.round(summary.apm * 10) / 10 };
    var keep = UI.stores.sprint.best.map(function (e) { return e.replay; }).filter(Boolean);
    summary.replay = store.save(rec, meta, keep);
  });

  // ---------------- list page (build_replays) ----------------
  function openList() {
    if (view) view.close();
    var body = UI.openView("replays", "리플레이");
    var items = store.listing();
    mk("div", "note rpNote", "저장된 리플레이 " + items.length + "개 (최대 " + MAX_REPLAYS +
       "개, 오래된 것부터 자동 삭제)", body);
    var list = mk("div", "rpList", null, body);
    var sel = -1, rows = [];
    function select(i) {
      sel = i;
      rows.forEach(function (row, j) { row.classList.toggle("on", j === i); });
      bPlay.disabled = bDel.disabled = sel < 0;
    }
    items.forEach(function (it, i) {
      var meta = it[1];
      var row = mk("button", "rpItem", null, list);
      var top = mk("div", "rpTop", null, row);
      mk("span", "rpDate", String(meta.date === undefined ? "" : meta.date).slice(0, 16), top);
      mk("span", "rpMode " + (meta.mode || "classic"), modeName(meta.mode), top);
      var bot = mk("div", "rpBot", null, row);
      mk("span", "rpRes", resultText(meta), bot);
      mk("span", "rpDur", "[" + fmtDur(meta.duration_ms || 0) + "]", bot);
      row.title = replayTitle(meta);
      row.addEventListener("click", function () {
        if (sel === i) play();                 // tap the selected one again = double click
        else select(i);
      });
      row.addEventListener("dblclick", play);
      rows.push(row);
    });
    if (!items.length) mk("div", "plain rpEmpty", "  아직 리플레이가 없어요. 게임을 한 판 해 보세요!", list);

    function play() { if (sel >= 0 && items[sel]) openReplay(items[sel][0]); }
    function del() {
      if (sel < 0 || !items[sel]) return;
      var ok = true;
      try { ok = global.confirm("선택한 리플레이를 삭제할까요?"); } catch (e) { ok = true; }
      if (ok) { store.delete(items[sel][0]); openList(); }
    }
    var bar = mk("div", "bbar", null, body);
    var bPlay = btn(bar, "▶ 재생", play);
    var bDel = btn(bar, "🗑 삭제", del, "pink");
    select(items.length ? 0 : -1);
  }

  // ---------------- player page (build_replay_view / ReplayView) ----------------
  var view = null;

  function openReplay(name) {
    if (view) view.close();
    var data = store.load(name);
    if (data === null) {
      var body = UI.openView("replay_view", "리플레이", "← 목록", openList);
      mk("div", "plain rpEmpty", "리플레이 파일을 읽을 수 없어요.", body);
      return null;
    }
    view = new ReplayView(name, data);
    return view;
  }

  function ReplayView(name, data) {
    var self = this;
    this.name = name;
    this.data = data;
    this.player = new ReplayPlayer(data);
    this.speed = 1.0;
    this.playing = true;
    this.finished = false;
    this.pos = 0;
    this.alive = true;
    this.last = global.performance.now();
    this.seekTo = null;
    this.texts = {};
    this.fx = new NT.EffectsManager();
    var st = UI.settings;
    this.fx.particles_on = st.fx_particles;
    this.fx.combo_on = st.fx_combo;
    this.fx.perfect_on = st.fx_perfect;

    var body = UI.openView("replay_view", "리플레이", "← 목록", function () { self.close(); openList(); });
    this.body = body;
    body.classList.add("rpBody");
    this.titleEl = mk("div", "rpTitle", replayTitle(data), body);
    if (data.truncated) mk("div", "note pinkt", "⚠ 이벤트가 너무 많아 일부만 기록된 리플레이예요.", body);

    var main = mk("div", "rpMain", null, body);
    this.wrap = mk("div", "rpBoard", null, main);
    this.cv = mk("canvas", null, null, this.wrap);
    this.fxCv = mk("canvas", "rpFx", null, this.wrap);
    var side = mk("div", "rpSide", null, main);
    this.scoreEl = mk("div", "rpScore", "SCORE 0", side);
    this.linesEl = mk("div", "rpLines", "LINES 0", side);
    this.timeEl = mk("div", "rpTime", "", side);
    var nb = mk("div", "panel cyan rpMini", null, side);
    mk("div", "plabel cyan", "NEXT", nb);
    this.nextCv = mk("canvas", null, null, nb);
    var hb = mk("div", "panel rpMini", null, side);
    mk("div", "plabel pink", "HOLD", hb);
    this.holdCv = mk("canvas", null, null, hb);
    this.statEl = mk("div", "rpStat", "", side);

    // progress bar (click / drag to seek)
    this.prog = mk("div", "rpProg", null, body);
    this.fill = mk("div", "rpFill", null, this.prog);
    this.knob = mk("div", "rpKnob", null, this.prog);
    this.bindProg();

    var r1 = mk("div", "rpBtns", null, body);
    this.btnPlay = btn(r1, "⏸ 일시정지", function () { self.toggle_play(); }, "rpPlay");
    btn(r1, "⟲ 처음부터", function () { self.restart(); });
    btn(r1, "☰ 메뉴", function () { self.close(); UI.goMenu(); }, "pink");
    var r2 = mk("div", "rpBtns", null, body);
    this.speedBtns = {};
    SPEEDS.forEach(function (sp) {
      self.speedBtns[sp] = btn(r2, sp + "x", function () { self.set_speed(sp); }, "rpSpd");
    });
    var r3 = mk("div", "rpBtns", null, body);
    btn(r3, "« 5초", function () { self.seek_ms(self.pos - 5000); });
    btn(r3, "▶| 한 수", function () { self.step_piece(); });
    btn(r3, "5초 »", function () { self.seek_ms(self.pos + 5000); });
    mk("div", "note rpHelp", "스페이스: 재생/일시정지 · R: 처음부터 · ←/→: 5초 이동 · 1~4: 속도 · " +
       "진행 바를 누르거나 끌어서 이동", body);

    this.onKey = function (e) { self.keyDown(e); };
    this.onResize = function () { self.layout(); };
    global.addEventListener("keydown", this.onKey);
    global.addEventListener("resize", this.onResize);

    this.layout();
    this.paint_speed();
    this.draw();
    this.loop = function () { self.step(); };
    global.requestAnimationFrame(this.loop);
  }
  var VP = ReplayView.prototype;

  VP.close = function () {
    if (!this.alive) return;
    this.alive = false;
    global.removeEventListener("keydown", this.onKey);
    global.removeEventListener("resize", this.onResize);
    if (view === this) view = null;
  };

  VP.layout = function () {
    var dpr = UI.dpr || Math.min(3, global.devicePixelRatio || 1);
    this.dpr = dpr;
    var bw = Math.min(this.body.clientWidth || 360, 480);
    var vh = global.innerHeight || 800;
    var cellW = Math.floor((bw - 4 - 10 - Math.max(96, bw * 0.27)) / W);
    var cellH = Math.floor((vh - 330) / H);
    var c = Math.max(12, Math.min(34, cellW, cellH));
    this.cell = c;
    function size(cv, w, h) {
      cv.style.width = w + "px"; cv.style.height = h + "px";
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    size(this.cv, W * c, H * c);
    size(this.fxCv, W * c, H * c);
    this.mbs = Math.max(8, Math.floor(c * 0.6));
    size(this.nextCv, 5 * this.mbs, 9 * this.mbs);
    size(this.holdCv, 5 * this.mbs, 4 * this.mbs);
    this.g = this.cv.getContext("2d");
    this.fg = this.fxCv.getContext("2d");
    this.ng = this.nextCv.getContext("2d");
    this.hg = this.holdCv.getContext("2d");
    if (this.alive) this.draw();
  };

  // ---------------- controls ----------------
  VP.keyDown = function (e) {
    if (!this.alive) return;
    if (UI.screen !== "replay_view") { this.close(); return; }
    var code = e.code || "", k = e.key || "";
    var key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
      : /^Digit[0-9]$/.test(code) ? code.slice(5)
      : (code === "Space" || k === " ") ? "space"
      : k === "ArrowLeft" ? "left" : k === "ArrowRight" ? "right" : k.toLowerCase();
    if (key === "space") { e.preventDefault(); if (!e.repeat) this.toggle_play(); }
    else if (key === "r") { e.preventDefault(); this.restart(); }
    else if (key === "left" || key === "right") { e.preventDefault(); this.seek_ms(this.pos + (key === "right" ? 5000 : -5000)); }
    else if (key === "1" || key === "2" || key === "3" || key === "4") { e.preventDefault(); this.set_speed(SPEEDS[+key - 1]); }
  };

  VP.setPlayText = function () {
    this.btnPlay.textContent = this.finished ? "▶ 다시 재생" : this.playing ? "⏸ 일시정지" : "▶ 재생";
  };

  VP.toggle_play = function () {
    if (this.finished) { this.restart(); return; }
    this.playing = !this.playing;
    this.last = global.performance.now();
    this.setPlayText();
  };

  VP.restart = function () {
    this.player.reset();
    this.pos = 0;
    this.fx.clear();
    this.finished = false;
    this.playing = true;
    this.last = global.performance.now();
    this.setPlayText();
  };

  VP.set_speed = function (v) { this.speed = v; this.paint_speed(); };

  VP.paint_speed = function () {
    var self = this;
    SPEEDS.forEach(function (sp) { self.speedBtns[sp].classList.toggle("on", sp === self.speed); });
  };

  VP.seek_ms = function (ms) {
    var p = this.player;
    this.pos = Math.max(0, Math.min(p.duration, ms));
    p.seek(Math.trunc(this.pos));
    this.fx.clear();
    this.finished = false;
    if (this.playing === false && p.ended && this.pos >= p.duration) this.finished = true;
    this.setPlayText();
  };

  /** step: pause and advance to the next piece placement (line clears resolve on the next step) */
  VP.step_piece = function () {
    var p = this.player;
    if (this.finished) return;
    this.playing = false;
    var t;
    if (p.pending !== null) t = p.pending[1];
    else {
      t = p.next_lock_time();
      if (t === null) t = p.duration;
    }
    this.pos = Math.max(this.pos, Math.min(p.duration, t));
    var self = this;
    p.advance_to(Math.trunc(this.pos)).forEach(function (o) { self.on_outcome(o); });
    if (p.ended && this.pos >= p.duration) this.finished = true;
    this.setPlayText();
  };

  VP.bindProg = function () {
    var self = this, pid = null;
    function at(e) {
      var r = self.prog.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      self.seekTo = f * self.player.duration;           // applied once per frame (seek re-simulates)
    }
    this.prog.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      pid = e.pointerId;
      try { self.prog.setPointerCapture(pid); } catch (err) { /* ignore */ }
      at(e);
    });
    this.prog.addEventListener("pointermove", function (e) { if (pid !== null && e.pointerId === pid) at(e); });
    function up(e) { if (pid !== null && e.pointerId === pid) { at(e); pid = null; } }
    this.prog.addEventListener("pointerup", up);
    this.prog.addEventListener("pointercancel", function () { pid = null; });
  };

  // ---------------- loop ----------------
  VP.step = function () {
    if (!this.alive) return;
    if (UI.screen !== "replay_view" || !doc.body.contains(this.cv)) { this.close(); return; }
    var now = global.performance.now();
    var dt = (now - this.last) / 1000;
    this.last = now;
    var p = this.player, self = this;
    if (this.seekTo !== null) { var s = this.seekTo; this.seekTo = null; this.seek_ms(s); }
    if (this.playing) {
      this.pos = Math.min(this.pos + dt * 1000 * this.speed, p.duration);
      p.advance_to(Math.trunc(this.pos)).forEach(function (o) { self.on_outcome(o); });
      if (this.pos >= p.duration && p.ended) {
        this.playing = false;
        this.finished = true;
        this.setPlayText();
      }
    }
    this.fx.tick(dt);
    this.draw();
    global.requestAnimationFrame(this.loop);
  };

  VP.on_outcome = function (o) {
    if (!o) return;
    this.fx.on_outcome(o, this.cell, UI.theme);
    UI.play(NT.outcomeSound(o), o.combo >= 1 ? o.combo : 0);
  };

  VP.setText = function (el, key, t) {
    if (this.texts[key] !== t) { this.texts[key] = t; el.textContent = t; }
  };

  VP.draw = function () {
    var th = UI.theme, hp = UI.helpers, p = this.player, core = p.core, c = this.cell, dpr = this.dpr;
    var g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    hp.drawBoardCore(g, core, c, p.anim(), null);
    hp.drawGauge(g, core, c);
    if (this.finished) {
      var msg = core.finished ? "SPRINT CLEAR!" : core.game_over ? "GAME OVER" : "REPLAY END";
      g.font = "bold " + Math.floor(c * 0.7) + "px Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 4;
      g.strokeStyle = th.C_BG;
      g.strokeText(msg, W * c / 2, H * c / 2);
      g.fillStyle = th.C_CYAN;
      g.fillText(msg, W * c / 2, H * c / 2);
    }
    var fg = this.fg;
    fg.setTransform(1, 0, 0, 1, 0, 0);
    fg.clearRect(0, 0, this.fxCv.width, this.fxCv.height);
    if (this.fx.active()) {
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.fx.draw(fg, c, th, hp.FONT);
    }

    var mbs = this.mbs, ng = this.ng, hg = this.hg, slot = 3 * mbs;
    ng.setTransform(dpr, 0, 0, dpr, 0, 0);
    ng.clearRect(0, 0, 5 * mbs, 9 * mbs);
    core.queue.slice(0, NT.NEXT_COUNT).forEach(function (idx, i) {
      hp.drawMini(ng, idx, 5 * mbs, slot, i * slot, mbs, false);
    });
    hg.setTransform(dpr, 0, 0, dpr, 0, 0);
    hg.clearRect(0, 0, 5 * mbs, 4 * mbs);
    if (core.hold_index !== null) hp.drawMini(hg, core.hold_index, 5 * mbs, 4 * mbs, 0, mbs, core.hold_used);

    this.setText(this.scoreEl, "s", "SCORE " + num(core.score));
    var target = core.sprint_target;
    this.setText(this.linesEl, "l", "LINES " + core.lines + (target ? " / " + target : ""));
    this.setText(this.timeEl, "t", fmtTime(Math.trunc(this.pos)) + " / " + fmtTime(p.duration));
    var stt = core.stats;
    var sline = (core.level_mode ? "LEVEL " + core.current_level() + "\n" : "") +
      "TETRIS " + stt.tetrises + " · T-SPIN " + (stt.tspin + stt.tspin_mini) + "\n" +
      "MAX COMBO " + stt.max_combo + " · B2B " + stt.max_b2b +
      (this.data.mode === "multi" ? "\nATK " + stt.attack : "");
    this.setText(this.statEl, "x", sline);

    var frac = p.duration ? this.pos / p.duration : 0;
    var pct = (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + "%";
    if (this.texts.pct !== pct) {
      this.texts.pct = pct;
      this.fill.style.width = pct;
      this.knob.style.left = pct;
    }
  };

  // ---------------- wiring ----------------
  UI.openReplay = openReplay;
  Replay.openList = openList;
  Replay.openReplay = openReplay;
  Object.defineProperty(Replay, "view", { get: function () { return view; } });

  var mBtn = doc.getElementById("mReplay");
  if (mBtn) {
    mBtn.disabled = false;
    mBtn.addEventListener("click", openList);
  }
})(typeof window !== "undefined" ? window : globalThis);
