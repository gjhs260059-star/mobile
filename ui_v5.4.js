/*
 * NEON TETRIS v5.4-mobile — ui_v5.4.js
 * ---------------------------------------------------------------
 * Canvas rendering, touch / keyboard input, game loop, menus and pages.
 * All game rules live in core_v5.4.js (window.NT.GameCore / GameRunner).
 * Stage 2: sprint mode, TOP 5, statistics, achievements (stores_v5.4.js),
 *          themes + custom theme (themes_v5.4.js), effects (effects_v5.4.js),
 *          sound (audio_v5.4.js, NT.Audio - optional), background image.
 * Public hooks on window.NT.UI:
 *   NT.UI.on(event, fn)   events: newgame, started, outcome, sound, record, gameover, finished,
 *                         abort, finalize(summary, runner) [before saving - stage 3 may set
 *                         summary.replay], summary(summary)
 *   NT.UI.startGame({mode, seed, rules, limits})   classic / sprint / (stage 4) multi
 *   NT.UI.finalizeGame(outcome)   "gameover" / "cleared" / "win" / "aborted" (stats for any mode)
 *   NT.UI.stores, NT.UI.fx, NT.UI.spec.*, NT.UI.openReplay (stage 3 sets it)
 */
(function (global) {
  "use strict";

  var NT = global.NT;
  var ACT = NT.ACT, W = NT.WIDTH, H = NT.HEIGHT;
  var T = NT.Themes, S = NT.Stores;
  var doc = global.document;
  var SPRINT_LINES = NT.SPRINT_LINES;

  var THEMES = T.THEMES, DEFAULT_THEME = T.DEFAULT_THEME, CUSTOM_NAME = T.CUSTOM_NAME;
  var mix = T.mix, lighten = T.lighten, darken = T.darken;
  var th = T.buildTheme(DEFAULT_THEME);

  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cellColor(v) { return T.cellColor(th, v); }

  // ==========================================================
  // Storage (versioned prefix, every access guarded)
  // ==========================================================
  var PREFIX = "nt54_";
  var storage = new S.Storage(PREFIX);
  var store = {
    get: function (key, def) { return storage.read(key, def); },
    set: function (key, val) { return storage.write(key, val); },
    remove: function (key) { storage.remove(key); }
  };

  // ==========================================================
  // Settings (tetris.py load_settings / save_settings)
  // ==========================================================
  var TOUCH_DEFAULT = { drag: 100, swipe: 250 };          // % of a cell
  var TOUCH_RANGE = { drag: [40, 200], swipe: [120, 500] };
  var settings = {
    keys: Object.assign({}, NT.DEFAULT_KEYS),
    level_mode: true,
    sensitivity: Object.assign({}, NT.DEFAULT_SENS),
    touch: Object.assign({}, TOUCH_DEFAULT),
    theme: DEFAULT_THEME,
    custom_theme: T.defaultCustomTheme(),
    sound: true,
    bgm_on: true,
    bgm_volume: 50,
    sfx_volume: 70,
    fx_particles: true,
    fx_combo: true,
    fx_perfect: true
  };
  var rawSettings = {};

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function loadSettings() {
    var data = store.get("settings", null);
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    rawSettings = data;                         // unknown keys are preserved on save
    var merged = Object.assign({}, NT.DEFAULT_KEYS);
    var saved = data.keys;
    if (saved && typeof saved === "object") {
      Object.keys(merged).forEach(function (a) { if (typeof saved[a] === "string") merged[a] = saved[a]; });
    }
    var vals = Object.keys(merged).map(function (k) { return merged[k]; });
    if (new Set(vals).size === vals.length) settings.keys = merged;
    if ("level_mode" in data) settings.level_mode = !!data.level_mode;
    if ("sound" in data) settings.sound = !!data.sound;
    var sens = data.sensitivity;
    if (sens && typeof sens === "object") {
      Object.keys(NT.SENS_RANGE).forEach(function (k) {
        var r = NT.SENS_RANGE[k];
        if (isNum(sens[k])) settings.sensitivity[k] = clamp(Math.trunc(sens[k]), r[0], r[1]);
      });
    }
    var t = data.touch;
    if (t && typeof t === "object") {
      Object.keys(TOUCH_RANGE).forEach(function (k) {
        var r = TOUCH_RANGE[k];
        if (isNum(t[k])) settings.touch[k] = clamp(Math.trunc(t[k]), r[0], r[1]);
      });
    }
    if (T.isThemeName(data.theme)) settings.theme = data.theme;
    settings.custom_theme = T.sanitizeCustom(data.custom_theme);
    ["fx_particles", "fx_combo", "fx_perfect", "bgm_on"].forEach(function (k) {
      if (k in data) settings[k] = !!data[k];
    });
    [["bgm_volume", "bgm_volume"], ["sfx_volume", "sfx_volume"]].forEach(function (p) {
      var v = data[p[0]];
      if (isNum(v)) settings[p[1]] = clamp(Math.trunc(v), 0, 100);
    });
  }

  function saveSettings() {
    var data = Object.assign({}, rawSettings, {
      keys: settings.keys,
      level_mode: settings.level_mode,
      sound: settings.sound,
      theme: settings.theme,
      custom_theme: settings.custom_theme,
      fx_particles: settings.fx_particles,
      fx_combo: settings.fx_combo,
      fx_perfect: settings.fx_perfect,
      bgm_on: settings.bgm_on,
      bgm_volume: settings.bgm_volume,
      sfx_volume: settings.sfx_volume,
      sensitivity: settings.sensitivity,
      touch: settings.touch
    });
    if (store.set("settings", data)) rawSettings = data;
  }

  // ==========================================================
  // Records / stats / achievements + effects + audio
  // ==========================================================
  var scores = new S.ScoreStore(storage);
  var stats = new S.StatsStore(storage);
  var sprint = new S.SprintStore(storage);
  var ach = new S.AchievementStore(storage);
  var ACHS = S.ACHIEVEMENTS;
  var fx = new NT.EffectsManager();

  function syncFxFlags() {
    fx.particles_on = settings.fx_particles;
    fx.combo_on = settings.fx_combo;
    fx.perfect_on = settings.fx_perfect;
  }

  function A() { return NT.Audio || null; }
  function play(name, combo) {
    var a = A();
    if (a && a.play) a.play(name, combo >= 1 ? combo : 0);
  }
  var curTrack = null;
  /** AudioManager.set_track: "menu" / "game" / null (off) */
  function setTrack(track) {
    curTrack = track;
    var a = A();
    if (!a) return;
    if (track) { if (a.startBgm) a.startBgm(track); }
    else if (a.stopBgm) a.stopBgm();
  }
  function syncAudio() {
    var a = A();
    if (!a) return;
    if (a.setSfxVolume) a.setSfxVolume(settings.sfx_volume);
    if (a.setBgmVolume) a.setBgmVolume(settings.bgm_volume);
    if (a.setSfxOn) a.setSfxOn(settings.sound);
    if (a.setBgmOn) a.setBgmOn(settings.bgm_on);
  }

  // ==========================================================
  // Theme / background image
  // ==========================================================
  var bgImg = null;         // decoded background image (settings > 배경화면)
  var bgCanvas = null;      // image fitted to the board + 40% dark blend (rebuild_background)

  function applyTheme() {
    th = T.buildTheme(settings.theme, settings.custom_theme);
    T.clearCache();
    var s = doc.documentElement.style;
    s.setProperty("--bg", th.C_BG);
    s.setProperty("--panel", th.C_PANEL);
    s.setProperty("--btn", th.C_BTN);
    s.setProperty("--grid", th.C_GRID);
    s.setProperty("--text", th.C_TEXT);
    s.setProperty("--cyan", th.C_CYAN);
    s.setProperty("--pink", th.C_PINK);
    s.setProperty("--dim", mix(th.C_TEXT, th.C_PANEL, 0.45));
    s.setProperty("--dim2", mix(th.C_TEXT, th.C_PANEL, 0.55));
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", th.C_PANEL);
    dirty = true;
    if (el && el.board) { draw(); drawSpec(); }
  }

  function rebuildBackground() {
    bgCanvas = null;
    if (!bgImg) return;
    var w = W * cell, h = H * cell;
    var cv = doc.createElement("canvas");
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var g = cv.getContext("2d");
    var iw = bgImg.naturalWidth || bgImg.width, ih = bgImg.naturalHeight || bgImg.height;
    if (!iw || !ih) return;
    var sc = Math.max(cv.width / iw, cv.height / ih);          // ImageOps.fit (cover, centred)
    var dw = iw * sc, dh = ih * sc;
    g.drawImage(bgImg, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    g.fillStyle = "rgba(15,16,22,0.4)";                        // Image.blend(img, dark, 0.4)
    g.fillRect(0, 0, cv.width, cv.height);
    bgCanvas = cv;
  }

  function loadBackground(dataUrl, done) {
    var img = new Image();
    img.onload = function () { bgImg = img; rebuildBackground(); dirty = true; if (done) done(true); };
    img.onerror = function () { if (done) done(false); };
    img.src = dataUrl;
  }

  /** file -> downscaled JPEG data URL (fits localStorage) */
  function importBackground(file, done) {
    if (!file) return;
    var url;
    try { url = URL.createObjectURL(file); } catch (e) { done(false); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var maxW = 480, maxH = 960;
        var sc = Math.min(1, Math.max(maxW / img.width, maxH / img.height));
        var cv = doc.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * sc));
        cv.height = Math.max(1, Math.round(img.height * sc));
        // never larger than ~2x the target in either direction
        if (cv.width > maxW * 2 || cv.height > maxH * 2) {
          var s2 = Math.min(maxW * 2 / cv.width, maxH * 2 / cv.height);
          cv.width = Math.round(cv.width * s2); cv.height = Math.round(cv.height * s2);
        }
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL("image/jpeg", 0.82);
        URL.revokeObjectURL(url);
        var ok = store.set("bg", data);
        loadBackground(data, function (loaded) { done(loaded, ok); });
      } catch (e) { done(false); }
    };
    img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } done(false); };
    img.src = url;
  }

  // ==========================================================
  // DOM
  // ==========================================================
  function $(id) { return doc.getElementById(id); }
  var el = {};
  ["app", "top", "boardWrap", "board", "fxCv", "side", "spec", "specCv", "specName", "specPrev", "specNext",
   "pv", "nextBox", "holdBox", "nextCv", "holdCv", "statsBox", "vMode", "vScore", "vBest", "vLines", "vLevel",
   "vTime", "vApm", "mini",
   "bHold", "bSoft", "bCcw", "bPause", "status", "controls", "bLeft", "bRot", "bRight",
   "pgMenu", "pgPause", "pgOver", "pgSettings", "pgView", "settingsBody", "viewBody", "vTitle", "vBack",
   "menuSub", "menuBest", "mClassic", "mLevel", "mSprint", "mStats", "mAch", "mTheme",
   "mSettings", "pResume", "pRestart", "pMenu", "pauseInfo", "oResult", "oAgain", "oMenu", "overInfo", "overTitle",
   "sBack", "bgFile"].forEach(function (id) { el[id] = $(id); });

  var ctx = el.board.getContext("2d");
  var fctx = el.fxCv.getContext("2d");
  var nctx = el.nextCv.getContext("2d");
  var hctx = el.holdCv.getContext("2d");
  var sctx = el.specCv.getContext("2d");

  // ==========================================================
  // State
  // ==========================================================
  var runner = null;
  var screen = "menu";             // menu / game / settings / stats / results / achievements / themes
  var settingsFrom = "menu";
  var dirty = true;
  var cell = 24, mcell = 14, scell = 10, dpr = 1;
  var listeners = {};
  var overTimer = null;
  var lastStatus = null, lastScore = null, lastLines = null, lastLevel = null, lastBest = null;
  var lastTime = null, lastApm = null, lastMode = null;
  var fxShown = false;

  // per-game bookkeeping (tetris.py restart / finalize_game)
  var finalized = true, hadPlay = false, scoreRecorded = false, lastRank = null, lastSummary = null;
  var baseMetrics = S.metricsFromStats(stats);
  var achTimer = 0;

  function now() { return global.performance.now(); }
  function emit(name, a, b) {
    (listeners[name] || []).forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } });
  }
  function ended() { return !!(runner && (runner.game_over || runner.finished)); }

  // ==========================================================
  // Drawing (draw_cell / draw_board / draw_mini_piece / draw_gameover)
  // ==========================================================
  function drawCell(g, x1, y1, x2, y2, color) { T.drawCell(g, x1, y1, x2, y2, color, th, dpr); }

  function drawGrid(g, c, color) {
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    for (var i = 1; i < W; i++) { g.moveTo(i * c + 0.5, 0); g.lineTo(i * c + 0.5, H * c); }
    for (var j = 1; j < H; j++) { g.moveTo(0, j * c + 0.5); g.lineTo(W * c, j * c + 0.5); }
    g.stroke();
  }

  function text(g, s, x, y, color, px, bold) {
    g.font = (bold === false ? "" : "bold ") + Math.max(7, Math.trunc(px)) + "px Arial, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(s, x, y, W * cell - 8);
  }

  function drawGameOver(g) {
    var c = cell, w = W * c, h = H * c, core = runner.core;
    g.fillStyle = th.C_BG;
    g.fillRect(c * 0.8, h * 0.22, w - c * 1.6, h * 0.56);
    g.strokeStyle = th.C_PINK;
    g.lineWidth = 2;
    g.strokeRect(c * 0.8, h * 0.22, w - c * 1.6, h * 0.56);
    if (runner.mode === "multi") {
      var mr = runner.match_result || null;
      var won = !!(mr && mr.won);
      text(g, won ? "VICTORY!" : "ELIMINATED", w / 2, h * 0.34, won ? th.C_CYAN : th.C_PINK, c * 0.65);
      text(g, mr && mr.text ? mr.text : "결과 대기 중...", w / 2, h * 0.47, th.C_TEXT, c * 0.6);
      text(g, "LINES " + core.lines + "   ATK " + core.stats.attack, w / 2, h * 0.58, th.C_TEXT, c * 0.42, false);
      return;
    }
    if (runner.mode === "sprint") {
      var done = core.finished;
      text(g, done ? "SPRINT CLEAR!" : "FAILED", w / 2, h * 0.32, done ? th.C_CYAN : th.C_PINK, c * 0.65);
      var t = lastSummary ? lastSummary.time_ms : runner.ms();
      text(g, done ? NT.fmtTime(t) : Math.min(core.lines, SPRINT_LINES) + " / " + SPRINT_LINES,
           w / 2, h * 0.43, th.C_TEXT, c * 0.8);
      text(g, "LINES " + core.lines + "   SCORE " + num(core.score), w / 2, h * 0.55, th.C_TEXT, c * 0.42, false);
      var best = sprint.best_ms();
      text(g, best ? "BEST " + NT.fmtTime(best) : "BEST --", w / 2, h * 0.64, th.C_PINK, c * 0.42);
      return;
    }
    text(g, "GAME OVER", w / 2, h * 0.30, th.C_PINK, c * 0.7);
    text(g, "TOP 5", w / 2, h * 0.38, th.C_CYAN, c * 0.45);
    scores.scores.forEach(function (e, i) {
      var hit = i === lastRank;
      text(g, (i + 1) + ".  " + num(e.score), w / 2, h * (0.44 + 0.065 * i),
           hit ? th.C_PINK : th.C_TEXT, c * 0.45, hit);
    });
  }

  function drawBoard() {
    var g = ctx, c = cell, core = runner ? runner.core : null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.C_BG;
    g.fillRect(0, 0, W * c, H * c);
    if (bgCanvas) g.drawImage(bgCanvas, 0, 0, W * c, H * c);
    drawGrid(g, c, bgCanvas ? (th.C_GRID_IMG || "#4A4F73") : th.C_GRID);
    if (!core) return;

    for (var y = 0; y < H; y++) {
      var row = core.board[y];
      for (var x = 0; x < W; x++) {
        if (row[x]) drawCell(g, x * c + 1, y * c + 1, (x + 1) * c - 1, (y + 1) * c - 1, cellColor(row[x]));
      }
    }

    if (runner.animating) {
      g.fillStyle = runner.anim_step % 2 ? "#FFFFFF" : th.C_CYAN;
      runner.clearing.forEach(function (ry) {
        for (var x = 0; x < W; x++) g.fillRect(x * c + 1, ry * c + 1, c - 2, c - 2);
      });
    }

    if (core.active && !core.game_over) {
      var color = th.COLORS[core.piece_index];
      var gy = core.ghost_y();
      var shape = core.shape, r, col;
      if (gy !== core.y && core.show_ghost) {
        g.save();
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.setLineDash([3, 3]);
        for (r = 0; r < shape.length; r++) for (col = 0; col < shape[r].length; col++) {
          if (shape[r][col] && gy + r >= 0) {
            g.strokeRect((core.x + col) * c + 3, (gy + r) * c + 3, c - 6, c - 6);
          }
        }
        g.restore();
      }
      for (r = 0; r < shape.length; r++) for (col = 0; col < shape[r].length; col++) {
        if (shape[r][col] && core.y + r >= 0) {
          var px = core.x + col, py = core.y + r;
          drawCell(g, px * c + 1, py * c + 1, (px + 1) * c - 1, (py + 1) * c - 1, color);
        }
      }
    }

    // incoming garbage gauge (multiplayer)
    if (core.incoming > 0) {
      var n = Math.min(core.incoming, H);
      g.fillStyle = "#FF3B3B";
      g.fillRect(W * c - 7, (H - n) * c, 5, n * c);
      g.strokeStyle = "#FFB0B0";
      g.strokeRect(W * c - 7 + 0.5, (H - n) * c + 0.5, 4, n * c - 1);
      g.fillStyle = "#FF8080";
      g.font = "bold " + Math.floor(c * 0.45) + "px Arial";
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillText(String(core.incoming), W * c - 10, (H - n) * c - 8);
    }

    // overlays
    if (ended()) { drawGameOver(g); return; }
    var t = null, tcol = th.C_CYAN, size = 0.77;
    if (runner.counting) { t = runner.count_text; size = 1.5; }
    else if (runner.paused) t = "PAUSED";
    else if (!runner.started) t = "READY";
    if (t) {
      g.font = "bold " + Math.floor(c * size) + "px Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 4;
      g.strokeStyle = th.C_BG;
      g.strokeText(t, W * c / 2, H * c / 2);
      g.fillStyle = tcol;
      g.fillText(t, W * c / 2, H * c / 2);
    }
  }

  function drawMini(g, index, w, h, y0, bs, dim) {
    var shape = NT.TIGHT[index];
    var color = dim ? "#444455" : th.COLORS[index];
    var ox = Math.floor((w - shape[0].length * bs) / 2);
    var oy = y0 + Math.floor((h - shape.length * bs) / 2);
    for (var r = 0; r < shape.length; r++) for (var c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        var x1 = ox + c * bs, y1 = oy + r * bs;
        drawCell(g, x1 + 1, y1 + 1, x1 + bs - 1, y1 + bs - 1, color);
      }
    }
  }

  function drawPreviews() {
    var core = runner ? runner.core : null;
    var nw = el.nextCv.width / dpr, nh = el.nextCv.height / dpr;
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nctx.clearRect(0, 0, nw, nh);
    var hw = el.holdCv.width / dpr, hh = el.holdCv.height / dpr;
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, hw, hh);
    if (!core) return;
    var slot = nh / NT.NEXT_COUNT;
    core.queue.slice(0, NT.NEXT_COUNT).forEach(function (idx, i) {
      drawMini(nctx, idx, nw, slot, Math.round(i * slot), mcell, false);
    });
    if (core.hold_index !== null) drawMini(hctx, core.hold_index, hw, hh, 0, mcell, core.hold_used);
  }

  // ---------------- effects layer ----------------
  var fxLast = 0;
  var FONT = "system-ui, -apple-system, 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
  function fxFrame(t) {
    var active = fx.active();
    var dt = fxLast ? (t - fxLast) / 1000 : 0;
    fxLast = t;
    if (active) fx.tick(dt);
    if (screen !== "game") return;
    if (active || fxShown) {
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.clearRect(0, 0, el.fxCv.width, el.fxCv.height);
      fxShown = false;
      if (fx.active()) {
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fx.draw(fctx, cell, th, FONT);
        fxShown = true;
      }
    }
  }

  // ---------------- spectate panel (stage 4 fills the data) ----------------
  var spec = {
    visible: false,
    data: null,          // parsed snapshot (NT.parseBoard) - score is never displayed
    name: "",
    onPrev: null,
    onNext: null,
    show: function (on) {
      spec.visible = !!on;
      el.app.classList.toggle("spec-on", spec.visible);
      layout();
    },
    set: function (data, name, idx, total) {
      spec.data = data ? NT.parseBoard(data) : null;
      if (name !== undefined) {
        spec.name = name || "";
        var label = "👁 " + (spec.name || "상대 화면");
        if (total) label += " (" + idx + "/" + total + ")";
        el.specName.textContent = label;
      }
      drawSpec();
    },
    draw: function () { drawSpec(); }
  };

  function drawSpec() {
    if (!spec.visible) return;
    var g = sctx, c = scell;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.C_BG;
    g.fillRect(0, 0, W * c, H * c);
    drawGrid(g, c, th.C_GRID);
    var d = spec.data;
    if (!d) {
      g.fillStyle = th.C_CYAN;
      g.font = "bold 11px " + getComputedStyle(doc.body).fontFamily;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("대기 중...", W * c / 2, H * c / 2);
      return;
    }
    for (var i = 0; i < d.b.length; i++) {
      var v = d.b.charCodeAt(i) - 48;
      if (v) {
        var y = Math.floor(i / W), x = i % W;
        drawCell(g, x * c + 1, y * c + 1, (x + 1) * c - 1, (y + 1) * c - 1, cellColor(v));
      }
    }
    if (d.pi >= 0 && d.pi < 7) {
      var shape = NT.SHAPES[d.pi].map(function (r) { return r.slice(); });
      for (var k = 0; k < ((d.r % 4) + 4) % 4; k++) shape = NT.rotateCW(shape);
      for (var r = 0; r < shape.length; r++) for (var col = 0; col < shape[r].length; col++) {
        var yy = d.y + r;
        if (shape[r][col] && yy >= 0) {
          var xx = d.x + col;
          drawCell(g, xx * c + 1, yy * c + 1, (xx + 1) * c - 1, (yy + 1) * c - 1, th.COLORS[d.pi]);
        }
      }
    }
    var n = Math.max(0, Math.min(d.inc, H));
    if (n) { g.fillStyle = "#FF3B3B"; g.fillRect(W * c - 5, (H - n) * c, 4, n * c); }
  }

  function updateTimeLabel() {
    if (!runner) return;
    var ms = runner.ms(), mins = ms / 60000;
    var apm = mins > 0.05 ? runner.core.stats.actions / mins : 0;
    var t = NT.fmtTime(ms);
    if (t !== lastTime) { el.vTime.textContent = t; lastTime = t; }
    var a = String(Math.round(apm));
    if (a !== lastApm) { el.vApm.textContent = a; lastApm = a; }
  }

  function updateLabels() {
    if (!runner) return;
    var core = runner.core, mode = runner.mode;
    var score = num(core.score);
    if (score !== lastScore) { el.vScore.textContent = score; lastScore = score; }
    var title = mode === "sprint" ? "SPRINT" : mode === "multi" ? "VERSUS" : "TETRIS";
    if (title !== lastMode) { el.vMode.textContent = title; lastMode = title; }
    var best, lines;
    if (mode === "sprint") {
      var b = sprint.best_ms();
      best = b ? NT.fmtTime(b) : "--";
      lines = Math.min(core.lines, SPRINT_LINES) + " / " + SPRINT_LINES;
    } else if (mode === "multi") {
      best = runner.alive_text || "-";
      lines = String(core.lines);
    } else {
      best = num(Math.max(scores.best(), core.score));
      lines = String(core.lines);
    }
    if (best !== lastBest) { el.vBest.textContent = best; lastBest = best; }
    if (lines !== lastLines) { el.vLines.textContent = lines; lastLines = lines; }
    var lv = runner.level_mode ? String(core.current_level()) : "-";
    if (lv !== lastLevel) { el.vLevel.textContent = lv; lastLevel = lv; }
    var st = runner.status || (runner.started && !ended() ? "게임 진행 중" : "");
    if (st !== lastStatus) { el.status.textContent = st; lastStatus = st; }
    el.bHold.style.opacity = core.hold_used ? "0.45" : "1";
    updateTimeLabel();
  }

  function draw() {
    drawBoard();
    drawPreviews();
    updateLabels();
  }

  // ==========================================================
  // Layout (cell size from the viewport)
  // ==========================================================
  function sizeCanvas(cv, w, h) {
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
  }

  function layout() {
    var oldCell = cell, oldDpr = dpr;
    dpr = Math.min(3, global.devicePixelRatio || 1);
    var vh = global.innerHeight;
    var ctlH = Math.round(clamp(vh * 0.11, 64, 112));
    doc.documentElement.style.setProperty("--ctl-h", ctlH + "px");

    var tw = el.top.clientWidth, thh = el.top.clientHeight;
    var gap = 8, border = 4;
    var sideMin = clamp(tw * 0.3, 112, 240);
    cell = Math.floor(Math.min((tw - gap - border - sideMin) / W, (thh - border) / H));
    cell = Math.max(8, cell);
    var bw = cell * W, bh = cell * H;
    sizeCanvas(el.board, bw, bh);
    sizeCanvas(el.fxCv, bw, bh);
    fxShown = true;

    var avail = tw - gap - border - bw;
    var wide = tw > thh * 1.15 && avail > 260;
    var sideW, colW, sideH;
    el.side.classList.toggle("wide", wide);
    if (wide) {
      var cols = spec.visible ? 3 : 2;
      colW = Math.floor(clamp((avail - 6 * (cols - 1)) / cols, 100, 220));
      sideW = colW * cols + 6 * (cols - 1);
      sideH = thh;
      doc.documentElement.style.setProperty("--colw", colW + "px");
    } else {
      sideW = Math.floor(clamp(avail, 80, Math.max(sideMin, cell * 6.5)));
      colW = sideW;
      sideH = spec.visible ? thh : bh + border;
    }
    el.side.style.width = sideW + "px";
    el.side.style.maxHeight = thh + "px";
    var inner = colW - 12;                                // panel border + padding

    var m = Math.floor(Math.min(cell * 0.8, inner / 4.6));
    var s = Math.floor(Math.min((colW - 16) / W, (sideH - 50) / H));
    for (var guard = 0; guard < 60; guard++) {
      if (spec.visible) sizeCanvas(el.specCv, s * W, s * H);
      sizeCanvas(el.nextCv, inner, Math.round(m * 2.6) * NT.NEXT_COUNT);
      sizeCanvas(el.holdCv, inner, Math.round(m * 2.6));
      if (el.side.scrollHeight <= sideH + 1 || m <= 6) break;
      if (spec.visible && s > 6 && (s >= m || guard % 2)) s--;
      else m--;
    }
    mcell = m;
    scell = s;
    if (oldCell !== cell || oldDpr !== dpr || !bgCanvas) rebuildBackground();
    dirty = true;
    draw();
    drawSpec();
  }

  var layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    global.requestAnimationFrame(function () { layoutQueued = false; layout(); });
  }

  // ==========================================================
  // Results bookkeeping (record_score / check_achievements / finalize_game)
  // ==========================================================
  /** classic score -> TOP 5 (once per game; sprint scores never mix in) */
  function recordScore() {
    if (!runner || runner.mode !== "classic") return;
    if (scoreRecorded || runner.core.score <= 0) return;
    scoreRecorded = true;
    lastRank = scores.add(runner.core.score, S.today());
  }

  function checkAchievements() {
    if (!runner || finalized) return;
    var m = S.combineMetrics(baseMetrics, S.sessionMetrics(runner.core, runner.mode, runner.ms()));
    var nw = ach.evaluate(m);
    nw.forEach(function (a) { fx.toast(a[1], a[2]); play("achieve"); });
  }

  /** save the game's result to stats / sprint records / achievements (once per game) */
  function finalizeGame(outcome) {
    if (!runner || finalized || !hadPlay) return null;
    var c = runner.core;
    finalized = true;
    var pieces = c.stats.pieces.reduce(function (a, b) { return a + b; }, 0);
    if (outcome === "aborted" && pieces === 0) return null;
    runner.clock.stop();
    var timeMs = runner.ms();
    var mins = Math.max(timeMs / 60000, 1e-6);
    var st = Object.assign({}, c.stats);
    st.pieces = c.stats.pieces.slice();
    var summary = {
      mode: runner.mode, outcome: outcome, date: S.nowStamp(),
      time_ms: timeMs, score: c.score, lines: c.lines, level: c.current_level(),
      apm: st.actions / mins, ppm: c.lines / mins,
      stats: st, pieces_total: pieces, record: null, replay: null, new_ach: []
    };
    try {
      emit("finalize", summary, runner);          // stage 3: replay saving sets summary.replay
      if (outcome === "cleared") {
        summary.record = sprint.add({ time_ms: timeMs, date: summary.date, apm: S.round1(summary.apm),
                                      lines: c.lines, pieces: pieces, replay: summary.replay });
      }
      stats.add_game(summary);
      var nw = ach.evaluate(S.metricsFromStats(stats));
      summary.new_ach = nw.map(function (a) { return a[1]; });
      nw.forEach(function (a) { fx.toast(a[1], a[2]); });
      if (nw.length) play("achieve");
      baseMetrics = S.metricsFromStats(stats);
    } catch (e) {
      console.warn("[경고] 결과 저장 중 오류 (게임은 계속됩니다): " + e);
    }
    lastSummary = summary;
    emit("summary", summary, runner);
    return summary;
  }

  // ==========================================================
  // Game control
  // ==========================================================
  var pendingCombo = 0;
  function hookRunner(r) {
    r.on("change", function () { dirty = true; });
    r.on("paused", function () { if (screen === "game") showPage("pgPause"); fillPause(); });
    r.on("started", function () { hadPlay = true; emit("started", r); });
    r.on("outcome", function (o) {
      // after_lock: sound -> effects -> achievements
      play(NT.outcomeSound(o), o.combo >= 1 ? o.combo : 0);
      fx.on_outcome(o, cell, th);
      checkAchievements();
      emit("outcome", o, r);
    });
    r.on("sound", function (name) {
      if (name === "rotate" || name === "hold" || name === "garbage" || name === "attack") play(name);
      emit("sound", name, r);
    });
    r.on("gameover", function () { if (r === runner) onGameOver(); emit("gameover", r); });
    r.on("finished", function () { if (r === runner) onSprintFinished(); emit("finished", r); });
    r.on("record", function (ms, code) { emit("record", ms, code); });
  }

  function scheduleResults(delay) {
    clearTimeout(overTimer);
    overTimer = setTimeout(showLastResults, delay);
  }

  /** end_game (classic game over / sprint failed) */
  function onGameOver() {
    recordScore();
    finalizeGame("gameover");
    if (runner.mode === "multi") {
      play("gameover");
      setTrack(null);
      dirty = true;
      return;                                   // stage 4 shows its own result
    }
    if (runner.mode === "sprint") {
      runner.status = "실패! " + Math.min(runner.core.lines, SPRINT_LINES) + "/" + SPRINT_LINES + "줄";
    } else {
      runner.status = lastRank === 0 ? "게임 오버! 🎉 신기록!" : "게임 오버!";
    }
    play("gameover");
    setTrack(null);
    dirty = true;
    scheduleResults(1500);
  }

  /** finish_sprint (40 lines) */
  function onSprintFinished() {
    var summary = finalizeGame("cleared");
    var t = summary ? summary.time_ms : runner.ms();
    var kind = summary ? summary.record : null;
    if (kind) {
      runner.status = "🎉 NEW RECORD!  " + NT.fmtTime(t);
      fx.record(cell, th);
      play("record");
    } else {
      runner.status = "완주!  " + NT.fmtTime(t);
      play("levelup");
    }
    setTrack(null);
    dirty = true;
    scheduleResults(kind ? 3200 : 1600);
  }

  function startGame(opts) {
    opts = opts || {};
    clearTimeout(overTimer);
    if (runner) {
      recordScore();                 // the unfinished game's score still counts (classic only)
      finalizeGame("aborted");
      emit("abort", runner);
    }
    runner = new NT.GameRunner({
      mode: opts.mode || "classic",
      seed: opts.seed,
      levelMode: settings.level_mode,
      sens: settings.sensitivity,
      rules: opts.rules,
      limits: opts.limits,
      now: now()
    });
    hookRunner(runner);
    finalized = false; hadPlay = false; scoreRecorded = false; lastRank = null; lastSummary = null;
    baseMetrics = S.metricsFromStats(stats);
    fx.clear();
    lastStatus = lastScore = lastLines = lastLevel = lastBest = lastTime = lastApm = lastMode = null;
    emit("newgame", runner);
    gotoGame();
    runner.start_game(now());
    dirty = true;
    return runner;
  }

  function gameInProgress(mode) {
    return runner && (!mode || runner.mode === mode) && runner.started && !ended();
  }

  /** start_mode: resume the same mode if a game is in progress, else a new game */
  function startMode(mode) {
    if (gameInProgress(mode)) {
      gotoGame();
      if (runner.paused) { showPage("pgPause"); fillPause(); }
      return;
    }
    startGame({ mode: mode });
  }

  function gotoGame() {
    clearTimeout(overTimer);
    screen = "game";
    hidePages();
    setTrack(ended() ? null : "game");
    fxShown = true;
    queueLayout();
  }

  function resumeGame() {
    if (!runner) return;
    hidePages();
    screen = "game";
    if (runner.paused || !runner.started) runner.start_game(now());
    dirty = true;
  }

  function leaveGame() {
    clearTimeout(overTimer);
    if (runner) runner.leave_screen(now());
  }

  function goMenu() {
    if (screen === "game") leaveGame();
    clearTimeout(overTimer);
    screen = "menu";
    refreshMenu();
    showPage("pgMenu");
    setTrack("menu");
  }

  function fillPause() {
    if (!runner) return;
    var core = runner.core;
    el.pauseInfo.innerHTML = resRows([
      ["SCORE", num(core.score)],
      ["LINES", runner.mode === "sprint" ? Math.min(core.lines, SPRINT_LINES) + " / " + SPRINT_LINES : core.lines],
      ["LEVEL", runner.level_mode ? core.current_level() : "-"],
      ["TIME", NT.fmtTime(runner.ms())]
    ]);
  }

  function resRows(rows) {
    return rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span>";
    }).join("");
  }

  /** small post-game card (Ⅱ / board tap after the game ended) */
  function showOverCard() {
    if (!runner || !ended()) return;
    clearTimeout(overTimer);
    var core = runner.core, ms = lastSummary ? lastSummary.time_ms : runner.ms(), mins = ms / 60000;
    var sprintMode = runner.mode === "sprint";
    el.overTitle.textContent = sprintMode ? (core.finished ? "SPRINT CLEAR!" : "SPRINT FAILED") : "GAME OVER";
    el.overTitle.style.color = sprintMode && core.finished ? "var(--cyan)" : "var(--pink)";
    el.overInfo.innerHTML = resRows([
      ["SCORE", num(core.score)],
      ["LINES", core.lines],
      ["LEVEL", runner.level_mode ? core.current_level() : "-"],
      ["TIME", NT.fmtTime(ms)],
      ["APM", mins > 0.05 ? Math.round(core.stats.actions / mins) : 0]
    ]);
    el.oResult.style.display = lastSummary ? "" : "none";
    showPage("pgOver");
  }

  // ==========================================================
  // Pages
  // ==========================================================
  var PAGES = ["pgMenu", "pgPause", "pgOver", "pgSettings", "pgView"];
  function hidePages() { PAGES.forEach(function (p) { el[p].classList.remove("show"); }); }
  function showPage(id) {
    hidePages();
    el[id].classList.add("show");
    if (id === "pgView" || id === "pgSettings" || id === "pgMenu") el[id].scrollTop = 0;
  }

  function refreshMenu() {
    el.mClassic.textContent = "일반 모드" + (gameInProgress("classic") ? " (이어하기)" : "");
    el.mSprint.textContent = "스프린트 모드 (40줄)" + (gameInProgress("sprint") ? " (이어하기)" : "");
    el.mLevel.textContent = "레벨업 모드: " + (settings.level_mode ? "ON" : "OFF");
    el.menuSub.textContent = "v5.4-mobile · " + (settings.level_mode
      ? "레벨업 모드: 줄을 지울수록 빨라져요." : "클래식 모드: 속도 고정.");
    var best = sprint.best_ms();
    el.menuBest.textContent = "BEST " + num(scores.best()) + "   |   SPRINT " + (best ? NT.fmtTime(best) : "--") +
      "   |   🏆 " + ach.count() + "/" + ACHS.length;
  }

  function setLevelMode(on) {
    settings.level_mode = !!on;
    if (runner) runner.setLevelMode(settings.level_mode);
    saveSettings();
    refreshMenu();
  }

  // ---------------- generic page builder helpers ----------------
  function mk(tag, cls, txt, parent) {
    var d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined && txt !== null) d.textContent = txt;
    if (parent) parent.appendChild(d);
    return d;
  }
  function section(parent, t) { return mk("div", "sec", t, parent); }
  function kvRows(parent, rows, small) {
    var g = mk("div", "kv" + (small ? " small" : ""), null, parent);
    rows.forEach(function (r) {
      mk("span", "k", r[0], g);
      mk("span", "v", String(r[1]), g);
    });
    return g;
  }
  function plain(parent, t) { return mk("div", "plain", t, parent); }
  function pieceBars(parent, counts) {
    var top = Math.max.apply(null, counts.concat([0])) || 1;
    counts.forEach(function (n, i) {
      var row = mk("div", "pbar", null, parent);
      var nm = mk("span", "pn", NT.PIECE_NAMES[i], row);
      nm.style.color = th.COLORS[i];
      var bar = mk("span", "pt", null, row);
      var f = mk("span", "pf", null, bar);
      f.style.width = (n / top * 100) + "%";
      f.style.background = th.COLORS[i];
      mk("span", "pc", num(n), row);
    });
  }
  function btn(parent, label, fn, cls) {
    var b = mk("button", "btn" + (cls ? " " + cls : ""), label, parent);
    b.addEventListener("click", fn);
    return b;
  }

  var viewBack = null;
  /** open_page for the generic view page */
  function openView(name, title, backText, backFn) {
    if (screen === "game") leaveGame();
    clearTimeout(overTimer);
    screen = name;
    el.vTitle.textContent = title;
    el.vBack.textContent = backText || "← 메뉴";
    viewBack = backFn || goMenu;
    el.viewBody.innerHTML = "";
    showPage("pgView");
    setTrack("menu");
    return el.viewBody;
  }

  // ---------------- 기록 및 통계 ----------------
  function openStats(tab) {
    tab = tab || "classic";
    var body = openView("stats", "기록 및 통계");
    var tabs = mk("div", "tabs", null, body);
    [["classic", "일반 모드"], ["sprint", "스프린트"], ["multi", "멀티"],
     ["records", "기록"], ["recent", "최근 플레이"]].forEach(function (p) {
      var b = btn(tabs, p[1], function () { openStats(p[0]); }, "tab");
      if (p[0] === tab) b.classList.add("on");
    });
    var inner = mk("div", "vinner", null, body);
    if (tab === "classic" || tab === "sprint" || tab === "multi") fillModeStats(inner, tab);
    else if (tab === "records") fillRecords(inner);
    else fillRecent(inner);
  }

  function statSections(inner, t) {
    section(inner, "줄 삭제");
    kvRows(inner, [["싱글", t.singles], ["더블", t.doubles], ["트리플", t.triples], ["테트리스", t.tetrises],
                   ["퍼펙트 클리어", t.pcs], ["최고 콤보", t.max_combo], ["최고 Back-to-Back 연속", t.max_b2b]]);
    section(inner, "T-스핀");
    kvRows(inner, [["T-스핀 (정식)", t.tspin],
                   ["  └ 싱글 / 더블 / 트리플", t.tspin_single + " / " + t.tspin_double + " / " + t.tspin_triple],
                   ["  └ 0줄", t.tspin_zero], ["T-스핀 미니", t.tspin_mini]]);
    section(inner, "드롭");
    kvRows(inner, [["총 드롭 거리 (칸)", num(t.drop_dist)], ["소프트 드롭 (칸)", num(t.soft_drops)],
                   ["하드 드롭 (회)", num(t.hard_drops)]]);
    section(inner, "블록별 사용 횟수");
    pieceBars(inner, t.pieces);
  }

  function fillModeStats(inner, mode) {
    var t = stats.totals(mode);
    var mins = t.play_time_ms / 60000;
    var apm = mins > 0 ? t.actions / mins : 0, ppm = mins > 0 ? t.lines / mins : 0;
    section(inner, "요약");
    var rows = [["플레이한 판 수", num(t.games)]];
    if (mode === "sprint") {
      rows.push(["완주 / 실패 / 중단", t.finished + " / " + t.fails + " / " + t.aborted],
                ["최고 기록", t.best_time_ms ? NT.fmtTime(t.best_time_ms) : "--"],
                ["기록 갱신 횟수", t.records_broken]);
    } else if (mode === "multi") {
      rows.push(["승리 / 탈락 / 중단", t.wins + " / " + t.fails + " / " + t.aborted],
                ["누적 공격 (줄)", num(t.attack)]);
    } else {
      rows.push(["게임 오버 / 중단", t.fails + " / " + t.aborted], ["최고 점수", num(t.best_score)]);
    }
    rows.push(["총 플레이 시간", S.fmtDur(t.play_time_ms)], ["누적 점수", num(t.score_total)],
              ["삭제한 줄 수", num(t.lines)], ["평균 APM (분당 행동)", apm.toFixed(1)],
              ["평균 PPM (분당 삭제 줄)", ppm.toFixed(1)]);
    kvRows(inner, rows);
    statSections(inner, t);
  }

  function fillRecords(inner) {
    section(inner, "일반 모드 TOP 5");
    if (scores.scores.length) {
      kvRows(inner, scores.scores.map(function (e, i) { return [(i + 1) + "위   " + e.date, num(e.score) + "점"]; }));
    } else plain(inner, "아직 기록이 없어요.");
    section(inner, "스프린트 최고 기록 (빠른 순)");
    if (sprint.best.length) {
      kvRows(inner, sprint.best.map(function (e, i) {
        return [(i + 1) + "위   " + String(e.date || "").slice(0, 16) + "   APM " + (e.apm === undefined ? 0 : e.apm),
                NT.fmtTime(e.time_ms)];
      }));
    } else plain(inner, "아직 완주 기록이 없어요.");
    section(inner, "스프린트 최근 기록 (시간순)");
    if (sprint.recent.length) {
      kvRows(inner, sprint.recent.map(function (e) { return [String(e.date || "").slice(0, 16), NT.fmtTime(e.time_ms)]; }));
    } else plain(inner, "-");
  }

  function fillRecent(inner) {
    section(inner, "최근 플레이 (최대 " + S.MAX_HISTORY + "판 보관)");
    var hist = stats.data.history.slice().reverse().slice(0, 40);
    if (!hist.length) { plain(inner, "아직 플레이 기록이 없어요."); return; }
    var names = { cleared: "완주", gameover: "게임오버", aborted: "중단" };
    kvRows(inner, hist.map(function (h) {
      var mode = h.mode === "sprint" ? "스프린트" : "일반";
      var val = (h.mode === "sprint" && h.outcome === "cleared") ? NT.fmtTime(h.time_ms)
        : num(h.score) + "점 · " + (h.lines || 0) + "줄";
      return [String(h.date === undefined ? "" : h.date).slice(0, 16) + "  " + mode + "  " + (names[h.outcome] || ""), val];
    }), true);
  }

  // ---------------- 결과 (상세 통계) ----------------
  function showLastResults() {
    overTimer = null;
    if (lastSummary) openResults(lastSummary);
    else if (ended() && screen === "game") showOverCard();
  }

  function openResults(s) {
    var sprintMode = s.mode === "sprint", title;
    if (s.mode === "multi") title = s.outcome === "win" ? "VICTORY!" : "ELIMINATED";
    else if (s.outcome === "cleared") title = "SPRINT CLEAR!";
    else if (s.outcome === "gameover") title = sprintMode ? "SPRINT FAILED" : "GAME OVER";
    else title = "PLAY RESULT";
    var body = openView("results", title, "← 게임", function () { if (runner) gotoGame(); else goMenu(); });

    if (s.record) mk("div", "big gold", s.record === "broken" ? "🎉 NEW RECORD!" : "🎉 첫 완주 기록!", body);
    if (sprintMode && s.outcome === "cleared") mk("div", "huge cyan", NT.fmtTime(s.time_ms), body);
    else if (sprintMode) mk("div", "huge pink", Math.min(s.lines, SPRINT_LINES) + " / " + SPRINT_LINES + " 줄", body);
    else if (s.mode === "multi") {
      var total = (s.ranking || []).length;
      mk("div", "huge " + (s.outcome === "win" ? "cyan" : "pink"), s.rank ? s.rank + "위 / " + total + "명" : "결과 집계 중", body);
    } else {
      mk("div", "huge cyan", num(s.score), body);
      if (lastRank === 0 && s.outcome === "gameover") mk("div", "big pink small", "🎉 TOP 5 신기록!", body);
    }

    var inner = mk("div", "vinner", null, body);
    var st = s.stats;
    section(inner, "요약");
    kvRows(inner, [["총 플레이 시간", NT.fmtTime(s.time_ms)], ["총 점수", num(s.score)],
                   ["삭제한 줄 수", String(s.lines)], ["평균 APM (분당 행동)", s.apm.toFixed(1)],
                   ["PPM (분당 삭제 줄)", s.ppm.toFixed(1)]]);
    statSections(inner, st);
    if (s.new_ach && s.new_ach.length) {
      section(inner, "🏆 새로 달성한 업적");
      s.new_ach.forEach(function (n) { mk("div", "plain cyan b", "• " + n, inner); });
    }
    if (s.mode === "multi") {
      section(inner, "대전");
      kvRows(inner, [["누적 공격 (줄)", st.attack]]);
      if (s.ranking && s.ranking.length) {
        section(inner, "순위");
        kvRows(inner, s.ranking.map(function (n, i) { return [(i + 1) + "위", n]; }));
      }
    }
    if (sprintMode && sprint.best.length) {
      section(inner, "스프린트 순위");
      kvRows(inner, sprint.best.slice(0, 5).map(function (e, i) {
        return [(i + 1) + "위   " + String(e.date || "").slice(0, 16), NT.fmtTime(e.time_ms)];
      }));
    } else if (!sprintMode && scores.scores.length) {
      section(inner, "TOP 5");
      kvRows(inner, scores.scores.map(function (e, i) { return [(i + 1) + "위   " + e.date, num(e.score) + "점"]; }));
    }

    var bar = mk("div", "bbar", null, body);
    if (s.replay && NT.UI.openReplay) btn(bar, "🎬 리플레이", function () { NT.UI.openReplay(s.replay); });
    btn(bar, "▶ 다시 시작", playAgain);
    btn(bar, "☰ 메뉴", goMenu, "pink");
  }

  function playAgain() {
    if (runner && runner.mode === "multi" && NT.UI.onMultiAgain) { NT.UI.onMultiAgain(); return; }
    startGame({ mode: runner ? runner.mode : "classic" });
  }

  // ---------------- 업적 ----------------
  function openAchievements() {
    var body = openView("achievements", "업적");
    var metrics = S.metricsFromStats(stats);
    var done = ACHS.filter(function (a) { return ach.unlocked[a[0]]; }).length;
    mk("div", "plain pink b", "달성 " + done + " / " + ACHS.length, body);
    var list = mk("div", "achList", null, body);
    var order = ACHS.filter(function (a) { return ach.unlocked[a[0]]; })
      .concat(ACHS.filter(function (a) { return !ach.unlocked[a[0]]; }));
    order.forEach(function (a) {
      var got = !!ach.unlocked[a[0]];
      var pr = S.AchievementStore.progress(a, metrics), ratio = pr[0];
      var row = mk("div", "ach" + (got ? " got" : ""), null, list);
      mk("span", "ico", got ? "🏆" : "🔒", row);
      var mid = mk("div", "mid", null, row);
      mk("div", "nm", a[1], mid);
      mk("div", "ds", a[2], mid);
      var tr = mk("div", "tr", null, mid);
      var f = mk("div", "fl", null, tr);
      f.style.width = (ratio * 100) + "%";
      var right = mk("div", "rt", null, row);
      if (got) { mk("div", null, ach.unlocked[a[0]], right); mk("div", null, "달성", right); }
      else { mk("div", null, Math.trunc(ratio * 100) + "%", right); mk("div", null, pr[1], right); }
    });
  }

  // ---------------- 스킨 및 테마 ----------------
  function openThemes(sel) {
    sel = sel || settings.theme;
    var names = T.THEME_ORDER.concat([CUSTOM_NAME]);
    var pth = T.buildTheme(sel, settings.custom_theme);
    var body = openView("themes", "스킨 및 테마");
    var list = mk("div", "themeList", null, body);
    names.forEach(function (n) {
      var b = btn(list, (n === settings.theme ? "✔ " : "") + n, function () { openThemes(n); }, "tab");
      if (n === sel) b.classList.add("on");
    });
    mk("div", "plain pink b", "미리보기 - " + sel, body);
    var wrap = mk("div", "pvWrap", null, body);
    var cv = mk("canvas", "pvCv", null, wrap);
    var avail = Math.min(el.viewBody.clientWidth || 300, 480);
    var pc = clamp(Math.floor((avail - 8) / W), 14, 26);
    cv.style.width = pc * W + "px";
    cv.style.height = pc * 10 + "px";
    cv.width = Math.round(pc * W * dpr);
    cv.height = Math.round(pc * 10 * dpr);
    cv.style.borderColor = pth.C_CYAN;
    T.drawPreview(cv.getContext("2d"), pth, pc, dpr);

    var ui = mk("div", "uiStrip", null, body);
    ui.style.background = pth.C_PANEL;
    ui.style.borderColor = pth.C_GRID;
    [["SCORE 12,340", pth.C_TEXT], ["BEST", pth.C_PINK], ["NEXT", pth.C_CYAN]].forEach(function (p) {
      var s = mk("span", "b", p[0], ui); s.style.color = p[1];
    });
    var stl = mk("span", "sty", "스타일: " + pth.style, ui);
    stl.style.color = pth.C_TEXT;

    if (sel === CUSTOM_NAME) buildCustomEditor(body, pth);
    var applied = sel === settings.theme;
    var ab = btn(body, applied ? "✔ 사용 중" : "이 테마 적용", function () { setTheme(sel); }, "apply");
    if (applied) ab.disabled = true;
  }

  function buildCustomEditor(parent, pth) {
    mk("div", "plain pink b", "블록 색 직접 지정 (눌러서 색 선택)", parent);
    var row = mk("div", "colorRow", null, parent);
    for (var i = 0; i < 7; i++) (function (i) {
      var col = pth.COLORS[i];
      var lab = mk("label", "colorBtn", null, row);
      lab.style.background = col;
      var sum = parseInt(col.substr(1, 2), 16) + parseInt(col.substr(3, 2), 16) + parseInt(col.substr(5, 2), 16);
      lab.style.color = sum > 380 ? "#000000" : "#FFFFFF";
      mk("span", null, NT.PIECE_NAMES[i], lab);
      var inp = mk("input", null, null, lab);
      inp.type = "color";
      inp.value = col.toLowerCase();
      inp.setAttribute("aria-label", NT.PIECE_NAMES[i] + " 블록 색");
      inp.addEventListener("change", function () {
        settings.custom_theme.colors[i] = T.normColor(inp.value, col);
        saveSettings();
        if (settings.theme === CUSTOM_NAME) applyTheme();
        openThemes(CUSTOM_NAME);
      });
    })(i);
    var br = mk("div", "row", null, parent);
    mk("span", "lb", "배경/UI/블록 스타일 기준:", br);
    var selEl = mk("select", "sel", null, br);
    T.THEME_ORDER.forEach(function (n) {
      var o = mk("option", null, n, selEl); o.value = n;
      if (n === settings.custom_theme.base) o.selected = true;
    });
    selEl.addEventListener("change", function () {
      settings.custom_theme.base = selEl.value;
      settings.custom_theme = T.sanitizeCustom(settings.custom_theme);
      saveSettings();
      if (settings.theme === CUSTOM_NAME) applyTheme();
      openThemes(CUSTOM_NAME);
    });
    btn(parent, "색 기본값으로", function () {
      settings.custom_theme.colors = THEMES[settings.custom_theme.base].COLORS.slice();
      saveSettings();
      if (settings.theme === CUSTOM_NAME) applyTheme();
      openThemes(CUSTOM_NAME);
    }, "small");
  }

  function setTheme(name) {
    settings.theme = T.isThemeName(name) ? name : DEFAULT_THEME;
    applyTheme();
    saveSettings();
    if (screen === "themes") openThemes(name);
  }

  // ---------------- settings page ----------------
  var waitingKey = null;
  var KEY_ACTIONS = [ACT.LEFT, ACT.RIGHT, ACT.SOFT, ACT.CW, ACT.CCW, ACT.HARD, ACT.HOLD, ACT.PAUSE];

  function keyLabel(k) { return k === "space" ? "Space" : k.length === 1 ? k.toUpperCase() : k; }

  function openSettings() {
    settingsFrom = screen === "game" ? "game" : "menu";
    if (screen === "game") leaveGame();
    screen = "settings";
    buildSettings();
    showPage("pgSettings");
    setTrack("menu");
  }

  function closeSettings() {
    waitingKey = null;
    if (settingsFrom === "game" && runner) {
      gotoGame();
      if (gameInProgress() || (runner.started && runner.paused)) { showPage("pgPause"); fillPause(); }
      else if (ended()) showOverCard();
    } else {
      goMenu();
    }
  }

  var bgNote = "";
  function buildSettings() {
    var body = el.settingsBody;
    var keepScroll = el.pgSettings.scrollTop;
    body.innerHTML = "";
    function sec(t) { section(body, t); }
    function note(t, cls) { return mk("div", "note" + (cls ? " " + cls : ""), t, body); }
    function row(label) {
      var r = mk("div", "row", null, body);
      mk("span", "lb", label, r);
      return r;
    }
    function slider(label, value, lo, hi, unit, onChange, enabled) {
      var r = row(label);
      var inp = doc.createElement("input");
      inp.type = "range"; inp.min = lo; inp.max = hi; inp.step = 1; inp.value = value;
      if (enabled === false) inp.disabled = true;
      var v = mk("span", "val", value + unit);
      inp.addEventListener("input", function () { v.textContent = inp.value + unit; onChange(parseInt(inp.value, 10), false); });
      inp.addEventListener("change", function () { onChange(parseInt(inp.value, 10), true); });
      r.appendChild(inp); r.appendChild(v);
    }
    function toggle(label, get, set, enabled) {
      var r = row(label);
      var b = mk("button", "btn tog", null, r);
      if (enabled === false) b.disabled = true;
      function paint() { var on = get(); b.textContent = on ? "ON" : "OFF"; b.classList.toggle("on", on); }
      b.addEventListener("click", function () { set(!get()); paint(); });
      paint();
    }
    function button(label, t, fn) {
      var r = row(label);
      var b = mk("button", "btn", t, r);
      b.addEventListener("click", fn);
      return b;
    }

    // 🔊 소리
    var a = A(), audioOk = !!a;
    sec("🔊 소리");
    if (!audioOk) note("이 환경에서는 소리를 지원하지 않아요. 게임은 소리 없이 정상 동작합니다.", "pinkt");
    toggle("배경 음악", function () { return settings.bgm_on; }, function (on) {
      settings.bgm_on = !!on;
      if (A() && A().setBgmOn) A().setBgmOn(settings.bgm_on);
      saveSettings();
    }, audioOk);
    slider("배경 음악 볼륨", settings.bgm_volume, 0, 100, "", function (v, commit) {
      if (!commit) return;
      settings.bgm_volume = clamp(v, 0, 100);
      if (A() && A().setBgmVolume) A().setBgmVolume(settings.bgm_volume);
      saveSettings();
    }, audioOk);
    toggle("효과음", function () { return settings.sound; }, function (on) {
      settings.sound = !!on;
      if (A() && A().setSfxOn) A().setSfxOn(settings.sound);
      saveSettings();
    }, audioOk);
    slider("효과음 볼륨", settings.sfx_volume, 0, 100, "", function (v, commit) {
      if (!commit) return;
      settings.sfx_volume = clamp(v, 0, 100);
      if (A() && A().setSfxVolume) A().setSfxVolume(settings.sfx_volume);
      saveSettings();
      play("clear");                       // 바뀐 볼륨 들어보기
    }, audioOk);
    note("볼륨은 슬라이더에서 손을 뗄 때 적용돼요. 소리는 화면을 처음 터치한 뒤부터 나와요.");

    // ✨ 연출 효과
    sec("✨ 연출 효과");
    [["fx_particles", "줄 삭제 파티클"], ["fx_combo", "콤보 / 테트리스 / T-스핀 연출"],
     ["fx_perfect", "퍼펙트 클리어 연출"]].forEach(function (p) {
      toggle(p[1], function () { return settings[p[0]]; }, function (v) {
        settings[p[0]] = !!v; syncFxFlags(); saveSettings();
      });
    });

    sec("🎚 감도 조절 (단위 ms, 작을수록 빠름)");
    [["das", "좌우 반복 시작 (DAS)"], ["arr", "좌우 반복 간격 (ARR)"],
     ["soft_delay", "아래키 반복 시작"], ["soft_arr", "아래키 반복 간격"]].forEach(function (p) {
      var rg = NT.SENS_RANGE[p[0]];
      slider(p[1], settings.sensitivity[p[0]], rg[0], rg[1], "", function (v, commit) {
        settings.sensitivity[p[0]] = clamp(v, rg[0], rg[1]);
        if (runner) runner.setSens(settings.sensitivity);
        if (commit) saveSettings();
      });
    });
    button("감도 기본값으로", "초기화", function () {
      settings.sensitivity = Object.assign({}, NT.DEFAULT_SENS);
      if (runner) runner.setSens(settings.sensitivity);
      saveSettings();
      buildSettings();
    });
    note("◀ ▶ 버튼이나 키를 꾹 누르면 DAS 후 ARR 간격으로 반복 이동합니다. ▼ 버튼은 아래키 값을 사용해요.");

    sec("👆 터치 조작");
    slider("드래그 1칸 거리 (칸 너비 %)", settings.touch.drag, TOUCH_RANGE.drag[0], TOUCH_RANGE.drag[1], "%",
      function (v, commit) { settings.touch.drag = v; if (commit) saveSettings(); });
    slider("즉시 낙하 스와이프 거리 (칸 너비 %)", settings.touch.swipe, TOUCH_RANGE.swipe[0], TOUCH_RANGE.swipe[1], "%",
      function (v, commit) { settings.touch.swipe = v; if (commit) saveSettings(); });
    button("터치 기본값으로", "초기화", function () {
      settings.touch = Object.assign({}, TOUCH_DEFAULT); saveSettings(); buildSettings();
    });
    note("보드: 좌우 드래그 = 이동 · 아래로 스와이프 = 즉시 낙하 · 탭 = 시계 회전");

    sec("🎮 게임");
    toggle("레벨업 모드 (일반 모드)", function () { return settings.level_mode; }, setLevelMode);
    button("스킨 및 테마", "🎨 " + settings.theme, function () { settingsFrom = "menu"; openThemes(null); });

    sec("🖼 배경화면");
    button("배경 이미지 (보드 뒤)", "🖼 배경 변경", function () { el.bgFile.value = ""; el.bgFile.click(); });
    button("기본 배경으로", "배경 초기화", function () {
      bgImg = null; bgCanvas = null; store.remove("bg");
      bgNote = "기본 배경으로 되돌렸어요.";
      dirty = true;
      buildSettings();
    });
    if (bgNote) note(bgNote, "cyant");

    sec("⌨ 조작키 (키보드)");
    KEY_ACTIONS.forEach(function (act) {
      var b = button(act, keyLabel(settings.keys[act]), function () {
        waitingKey = act;
        buildSettings();
      });
      b.classList.add("keyBtn");
      if (waitingKey === act) { b.classList.add("wait"); b.textContent = "키 입력..."; }
    });
    button("기본 키로 복구", "초기화", function () {
      settings.keys = Object.assign({}, NT.DEFAULT_KEYS); waitingKey = null; saveSettings(); buildSettings();
    });
    note("Shift 키는 항상 홀드로 동작합니다. Esc = 일시정지 / 뒤로.");
    var v = note("NEON TETRIS v5.4-mobile (원본 v5.3 Tkinter 이식)");
    v.style.marginTop = "18px";
    el.pgSettings.scrollTop = keepScroll;
  }

  function onBgFile() {
    var f = el.bgFile.files && el.bgFile.files[0];
    if (!f) return;
    importBackground(f, function (ok, saved) {
      if (!ok) bgNote = "이미지를 불러올 수 없어요.";
      else if (saved === false) bgNote = "배경화면을 적용했어요. (저장 공간이 부족해 다음 실행 때는 기본 배경이에요)";
      else bgNote = "배경화면을 적용했어요.";
      if (screen === "settings") buildSettings();
    });
  }

  // ==========================================================
  // Keyboard (same default keys as tetris.py)
  // ==========================================================
  function keysym(e) {
    var code = e.code || "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (code === "Space" || e.key === " ") return "space";
    if (code === "ShiftLeft") return "shift_l";
    if (code === "ShiftRight") return "shift_r";
    var k = e.key || "";
    var map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
                Escape: "escape", Enter: "return", Tab: "tab", Shift: "shift_l" };
    if (map[k]) return map[k];
    return k.toLowerCase();
  }

  function actionOf(key) {
    if (key === "shift_l" || key === "shift_r") return ACT.HOLD;
    for (var a in settings.keys) if (settings.keys[a] === key) return a;
    return null;
  }

  function onKeyDown(e) {
    var key = keysym(e);
    if (waitingKey) {
      e.preventDefault();
      if (key === "escape") { waitingKey = null; buildSettings(); return; }
      var used = Object.keys(settings.keys).some(function (a) { return a !== waitingKey && settings.keys[a] === key; });
      if (!used && key !== "shift_l" && key !== "shift_r") {
        settings.keys[waitingKey] = key;
        saveSettings();
      }
      waitingKey = null;
      buildSettings();
      return;
    }
    if (key === "escape") {
      e.preventDefault();
      if (screen === "settings") closeSettings();
      else if (screen === "game") {
        if (el.pgPause.classList.contains("show")) resumeGame();
        else if (el.pgOver.classList.contains("show")) goMenu();
        else if (ended()) showOverCard();
        else if (runner) runner.pause(now());
      } else if (screen !== "menu") goMenu();
      return;
    }
    if (screen !== "game" || !runner) return;
    var action = actionOf(key);
    if (action === null) return;
    e.preventDefault();
    if (e.repeat) return;
    if (el.pgPause.classList.contains("show") || el.pgOver.classList.contains("show")) {
      if (action === ACT.PAUSE && el.pgPause.classList.contains("show")) resumeGame();
      return;
    }
    runner.press("k:" + key, action, now());
    dirty = true;
  }

  function onKeyUp(e) {
    if (!runner) return;
    runner.release("k:" + keysym(e), now());
  }

  // ==========================================================
  // Touch: buttons + board gestures
  // ==========================================================
  function bindHold(b, keyId, action) {
    var pid = null;
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      try { b.setPointerCapture(pid); } catch (err) { /* ignore */ }
      b.classList.add("on");
      if (runner && screen === "game") { runner.press(keyId, action, now()); dirty = true; }
    });
    function up(e) {
      if (pid === null || (e && e.pointerId !== pid)) return;
      pid = null;
      b.classList.remove("on");
      if (runner) runner.release(keyId, now());
    }
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("lostpointercapture", up);
  }

  function bindTap(b, fn) {
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      b.classList.add("on");
      fn();
    });
    function off() { b.classList.remove("on"); }
    b.addEventListener("pointerup", off);
    b.addEventListener("pointercancel", off);
    b.addEventListener("pointerleave", off);
  }

  function act(action) {
    if (runner && screen === "game") { runner.action(action, now()); dirty = true; }
  }

  // board gestures
  var gest = null;
  function onBoardDown(e) {
    e.preventDefault();
    if (gest || screen !== "game") return;
    if (ended()) { showOverCard(); return; }
    try { el.boardWrap.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    gest = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ax: e.clientX, t0: now(),
             steps: 0, dropped: false, maxd: 0 };
  }
  function onBoardMove(e) {
    if (!gest || e.pointerId !== gest.id) return;
    e.preventDefault();
    var dxT = e.clientX - gest.x0, dyT = e.clientY - gest.y0;
    gest.maxd = Math.max(gest.maxd, Math.hypot(dxT, dyT));
    if (gest.dropped) return;
    var swipe = cell * settings.touch.swipe / 100;
    if (gest.steps === 0 && dyT > swipe && dyT > Math.abs(dxT) * 2) {
      gest.dropped = true;
      act(ACT.HARD);
      return;
    }
    if (Math.abs(dyT) > Math.abs(dxT) * 1.5 && gest.steps === 0) return;  // mostly vertical so far
    var step = Math.max(6, cell * settings.touch.drag / 100);
    var dx = e.clientX - gest.ax;
    while (Math.abs(dx) >= step) {
      var dir = dx > 0 ? 1 : -1;
      act(dir > 0 ? ACT.RIGHT : ACT.LEFT);
      gest.ax += dir * step;
      gest.steps++;
      dx = e.clientX - gest.ax;
    }
  }
  function onBoardUp(e) {
    if (!gest || e.pointerId !== gest.id) return;
    var g = gest;
    gest = null;
    if (e.type !== "pointerup") return;
    var slop = Math.max(10, cell * 0.4);
    if (!g.dropped && g.steps === 0 && g.maxd < slop && now() - g.t0 < 350) act(ACT.CW);
  }

  // ==========================================================
  // Loop (requestAnimationFrame)
  // ==========================================================
  var lastFrame = 0;
  function frame(t) {
    var n = now();
    if (runner && screen === "game") runner.update(n);
    // hud_tick: 1s achievement check (survival time etc.) while playing
    if (runner && screen === "game" && runner.started && !runner.paused && !ended()) {
      achTimer += lastFrame ? n - lastFrame : 0;
      if (achTimer >= 1000) { achTimer = 0; checkAchievements(); }
      updateTimeLabel();
    }
    lastFrame = n;
    if (dirty && screen === "game") { dirty = false; draw(); }
    fxFrame(n);
    global.requestAnimationFrame(frame);
  }

  // ==========================================================
  // Init
  // ==========================================================
  function init() {
    loadSettings();
    applyTheme();
    syncFxFlags();
    syncAudio();
    var bg = store.get("bg", null);
    if (typeof bg === "string" && /^data:image\//.test(bg)) loadBackground(bg);

    // game buttons
    bindHold(el.bLeft, "t:left", ACT.LEFT);
    bindHold(el.bRight, "t:right", ACT.RIGHT);
    bindHold(el.bSoft, "t:soft", ACT.SOFT);
    bindTap(el.bRot, function () { act(ACT.CW); });
    bindTap(el.bCcw, function () { act(ACT.CCW); });
    bindTap(el.bHold, function () { act(ACT.HOLD); });
    bindTap(el.bPause, function () {
      if (!runner || screen !== "game") return;
      if (ended()) showOverCard();
      else runner.pause(now());
    });
    bindTap(el.specPrev, function () { if (spec.onPrev) spec.onPrev(); });
    bindTap(el.specNext, function () { if (spec.onNext) spec.onNext(); });

    el.boardWrap.addEventListener("pointerdown", onBoardDown);
    el.boardWrap.addEventListener("pointermove", onBoardMove);
    el.boardWrap.addEventListener("pointerup", onBoardUp);
    el.boardWrap.addEventListener("pointercancel", onBoardUp);

    // pages
    el.mClassic.addEventListener("click", function () { startMode("classic"); });
    el.mSprint.addEventListener("click", function () { startMode("sprint"); });
    el.mLevel.addEventListener("click", function () { setLevelMode(!settings.level_mode); });
    el.mStats.addEventListener("click", function () { openStats("classic"); });
    el.mAch.addEventListener("click", openAchievements);
    el.mTheme.addEventListener("click", function () { openThemes(null); });
    el.mSettings.addEventListener("click", openSettings);
    el.pResume.addEventListener("click", resumeGame);
    el.pRestart.addEventListener("click", function () { startGame({ mode: runner ? runner.mode : "classic" }); });
    el.pMenu.addEventListener("click", goMenu);
    el.oResult.addEventListener("click", function () { if (lastSummary) openResults(lastSummary); });
    el.oAgain.addEventListener("click", playAgain);
    el.oMenu.addEventListener("click", goMenu);
    el.sBack.addEventListener("click", closeSettings);
    el.vBack.addEventListener("click", function () { (viewBack || goMenu)(); });
    el.bgFile.addEventListener("change", onBgFile);

    // keyboard
    global.addEventListener("keydown", onKeyDown);
    global.addEventListener("keyup", onKeyUp);

    // first user gesture -> unlock audio (audio_v5.4.js also listens itself)
    var unlock = function () {
      var a = A();
      if (a && a.init) { a.init(); syncAudio(); setTrack(curTrack); }
      global.removeEventListener("pointerdown", unlock, true);
      global.removeEventListener("keydown", unlock, true);
    };
    global.addEventListener("pointerdown", unlock, true);
    global.addEventListener("keydown", unlock, true);

    // no context menu / selection / pinch
    ["contextmenu", "selectstart", "dragstart", "gesturestart"].forEach(function (t) {
      doc.addEventListener(t, function (e) { e.preventDefault(); });
    });
    doc.addEventListener("touchmove", function (e) {
      if (!e.target.closest || !e.target.closest(".page")) e.preventDefault();
    }, { passive: false });

    // app hidden / focus lost -> release keys, pause (leave_game_screen)
    doc.addEventListener("visibilitychange", function () {
      if (doc.hidden && runner && screen === "game") {
        runner.leave_screen(now());
        if (runner.paused) { showPage("pgPause"); fillPause(); }
      }
    });
    global.addEventListener("blur", function () { if (runner) runner.releaseAll(); });
    // on_close: the unfinished game still counts (TOP 5 + stats)
    global.addEventListener("pagehide", function () {
      try { recordScore(); finalizeGame("aborted"); saveSettings(); } catch (e) { /* ignore */ }
    });

    global.addEventListener("resize", queueLayout);
    global.addEventListener("orientationchange", queueLayout);
    if (global.visualViewport) global.visualViewport.addEventListener("resize", queueLayout);

    // debug / preview: ?spec=demo shows the spectate panel with a sample board
    if (/[?&]spec=demo\b/.test(global.location.search)) {
      var demo = new NT.GameCore(77, false);
      demo.receive_garbage(0);
      demo.push_garbage(6);
      spec.show(true);
      spec.set(demo.board_snapshot(), "Player_A", 1, 3);
    }

    refreshMenu();
    setTrack("menu");
    layout();
    global.requestAnimationFrame(frame);
  }

  NT.UI = {
    version: "5.4-mobile",
    themes: THEMES,
    applyTheme: function (name) { if (name !== undefined) setTheme(name); else applyTheme(); },
    get theme() { return th; },
    store: store,
    settings: settings,
    saveSettings: saveSettings,
    stores: { scores: scores, stats: stats, sprint: sprint, ach: ach },
    fx: fx,
    spec: spec,
    on: function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
    startGame: startGame,
    startMode: startMode,
    finalizeGame: finalizeGame,
    recordScore: recordScore,
    goMenu: goMenu,
    gotoGame: gotoGame,
    openStats: openStats,
    openAchievements: openAchievements,
    openThemes: openThemes,
    openSettings: openSettings,
    openResults: openResults,
    showOverCard: showOverCard,
    openReplay: null,
    onMultiAgain: null,
    layout: layout,
    play: play,
    setTrack: setTrack,
    get runner() { return runner; },
    get screen() { return screen; },
    get lastSummary() { return lastSummary; },
    get lastRank() { return lastRank; },
    helpers: { mix: mix, lighten: lighten, darken: darken, drawCell: drawCell }
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
