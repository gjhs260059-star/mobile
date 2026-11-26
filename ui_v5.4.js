/*
 * NEON TETRIS v5.4-mobile — ui_v5.4.js
 * ---------------------------------------------------------------
 * Canvas rendering, touch / keyboard input, game loop, menus, settings.
 * All game rules live in core_v5.4.js (window.NT.GameCore / GameRunner).
 * Public hooks for later stages are exposed on window.NT.UI:
 *   NT.UI.themes / applyTheme(name)   (stage 2: themes)
 *   NT.UI.on(event, fn)               (stage 2/3: stats, records, audio, replay recorder)
 *   NT.UI.spec.*                      (stage 4: spectate panel)
 *   NT.UI.startGame({mode, seed, rules, limits})   (stage 2/4: sprint / multiplayer)
 */
(function (global) {
  "use strict";

  var NT = global.NT;
  var ACT = NT.ACT, W = NT.WIDTH, H = NT.HEIGHT;
  var doc = global.document;

  // ==========================================================
  // Themes (tetris.py THEMES; only the default is wired in stage 1)
  // ==========================================================
  var THEMES = {
    "네온 사이버펑크": {
      style: "neon", glow: 1.0, gloss: 0.55,
      C_BG: "#0F1016", C_PANEL: "#14151F", C_BTN: "#1C1E2E",
      C_GRID: "#1E2030", C_GRID_IMG: "#4A4F73", C_TEXT: "#E6E6FF",
      C_CYAN: "#00F5FF", C_PINK: "#FF2E97",
      COLORS: ["#00F5FF", "#4D7CFF", "#FF9100", "#FFEA00", "#39FF14", "#BF5FFF", "#FF2E63"]
    }
  };
  var DEFAULT_THEME = "네온 사이버펑크";
  var GARBAGE_COLOR = "#777777";
  var th = THEMES[DEFAULT_THEME];

  // ---------------- colour helpers ----------------
  var mixCache = {};
  function mix(c1, c2, t) {
    var key = c1 + c2 + t;
    var hit = mixCache[key];
    if (hit) return hit;
    var a = c1.replace("#", ""), b = c2.replace("#", ""), out = "#";
    for (var i = 0; i < 6; i += 2) {
      var v = Math.trunc(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t);
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return (mixCache[key] = out);
  }
  function lighten(c, a) { return mix(c, "#FFFFFF", a === undefined ? 0.45 : a); }
  function darken(c, a) { return mix(c, "#000000", a === undefined ? 0.4 : a); }
  function cellColor(v) { return v === 8 ? GARBAGE_COLOR : th.COLORS[(v - 1) % 7]; }

  function applyTheme(name) {
    th = THEMES[name] || THEMES[DEFAULT_THEME];
    var s = doc.documentElement.style;
    s.setProperty("--bg", th.C_BG);
    s.setProperty("--panel", th.C_PANEL);
    s.setProperty("--btn", th.C_BTN);
    s.setProperty("--grid", th.C_GRID);
    s.setProperty("--text", th.C_TEXT);
    s.setProperty("--cyan", th.C_CYAN);
    s.setProperty("--pink", th.C_PINK);
    s.setProperty("--dim", mix(th.C_TEXT, th.C_PANEL, 0.45));
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", th.C_PANEL);
    dirty = true;
  }

  // ==========================================================
  // Storage (versioned prefix, every access guarded)
  // ==========================================================
  var PREFIX = "nt54_";
  var store = {
    get: function (key, def) {
      try {
        var raw = global.localStorage.getItem(PREFIX + key);
        if (raw === null || raw === undefined) return def;
        return JSON.parse(raw);
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { global.localStorage.setItem(PREFIX + key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    },
    remove: function (key) {
      try { global.localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    }
  };

  // ==========================================================
  // Settings (tetris.py load_settings / save_settings subset)
  // ==========================================================
  var TOUCH_DEFAULT = { drag: 100, swipe: 250 };          // % of a cell
  var TOUCH_RANGE = { drag: [40, 200], swipe: [120, 500] };
  var settings = {
    keys: Object.assign({}, NT.DEFAULT_KEYS),
    level_mode: true,
    sensitivity: Object.assign({}, NT.DEFAULT_SENS),
    touch: Object.assign({}, TOUCH_DEFAULT),
    theme: DEFAULT_THEME
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
    if (typeof data.theme === "string" && THEMES[data.theme]) settings.theme = data.theme;
  }

  function saveSettings() {
    var data = Object.assign({}, rawSettings, {
      keys: settings.keys,
      level_mode: settings.level_mode,
      sensitivity: settings.sensitivity,
      touch: settings.touch,
      theme: settings.theme
    });
    if (store.set("settings", data)) rawSettings = data;
  }

  // ==========================================================
  // DOM
  // ==========================================================
  function $(id) { return doc.getElementById(id); }
  var el = {};
  ["app", "top", "boardWrap", "board", "side", "spec", "specCv", "specName", "specPrev", "specNext",
   "pv", "nextBox", "holdBox", "nextCv", "holdCv", "statsBox", "vScore", "vLines", "vLevel", "mini",
   "bHold", "bSoft", "bCcw", "bPause", "status", "controls", "bLeft", "bRot", "bRight",
   "pgMenu", "pgPause", "pgOver", "pgSettings", "settingsBody", "menuSub", "mClassic", "mLevel",
   "mSettings", "pResume", "pRestart", "pMenu", "pauseInfo", "oAgain", "oMenu", "overInfo",
   "sBack"].forEach(function (id) { el[id] = $(id); });

  var ctx = el.board.getContext("2d");
  var nctx = el.nextCv.getContext("2d");
  var hctx = el.holdCv.getContext("2d");
  var sctx = el.specCv.getContext("2d");

  // ==========================================================
  // State
  // ==========================================================
  var runner = null;
  var screen = "menu";             // menu / game / settings
  var settingsFrom = "menu";
  var dirty = true;
  var cell = 24, mcell = 14, scell = 10, dpr = 1;
  var listeners = {};
  var overTimer = null;
  var lastStatus = null, lastScore = null, lastLines = null, lastLevel = null;

  function now() { return global.performance.now(); }
  function emit(name, a, b) {
    (listeners[name] || []).forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } });
  }

  // ==========================================================
  // Drawing (draw_cell / draw_board / draw_mini_piece, neon style)
  // ==========================================================
  function drawCell(g, x1, y1, x2, y2, color) {
    var c = x2 - x1;
    var glow = th.glow || 0;
    g.lineWidth = 1;
    if (glow > 0) {
      g.strokeStyle = mix(color, th.C_BG, 1 - 0.35 * glow);
      g.lineWidth = 2;
      g.strokeRect(x1 - 1, y1 - 1, c + 2, (y2 - y1) + 2);
      g.lineWidth = 1;
    }
    var inset = Math.max(3, Math.floor(c / 8));
    if (c < 10) inset = Math.max(2, Math.floor(c / 4));
    g.fillStyle = color;
    g.fillRect(x1, y1, c, y2 - y1);
    g.strokeStyle = lighten(color, 0.55);
    g.strokeRect(x1 + 0.5, y1 + 0.5, c - 1, (y2 - y1) - 1);
    if (c >= 7) {
      g.strokeStyle = lighten(color, 0.3);
      g.strokeRect(x1 + inset + 0.5, y1 + inset + 0.5, c - 2 * inset - 1, (y2 - y1) - 2 * inset - 1);
    }
  }

  function drawGrid(g, c, w, h, color) {
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    for (var i = 1; i < W; i++) { g.moveTo(i * c + 0.5, 0); g.lineTo(i * c + 0.5, H * c); }
    for (var j = 1; j < H; j++) { g.moveTo(0, j * c + 0.5); g.lineTo(W * c, j * c + 0.5); }
    g.stroke();
  }

  function drawBoard() {
    var g = ctx, c = cell, core = runner ? runner.core : null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.C_BG;
    g.fillRect(0, 0, W * c, H * c);
    drawGrid(g, c, W * c, H * c, th.C_GRID);
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
    var text = null, tcol = th.C_CYAN, size = 0.77;
    if (runner.game_over) { text = "GAME OVER"; tcol = th.C_PINK; size = 0.85; }
    else if (runner.counting) { text = runner.count_text; size = 1.5; }
    else if (runner.paused) text = "PAUSED";
    else if (!runner.started) text = "READY";
    if (text) {
      g.font = "bold " + Math.floor(c * size) + "px Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 4;
      g.strokeStyle = th.C_BG;
      g.strokeText(text, W * c / 2, H * c / 2);
      g.fillStyle = tcol;
      g.fillText(text, W * c / 2, H * c / 2);
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
    drawGrid(g, c, W * c, H * c, th.C_GRID);
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

  function updateLabels() {
    if (!runner) return;
    var core = runner.core;
    var score = core.score.toLocaleString("en-US");
    if (score !== lastScore) { el.vScore.textContent = score; lastScore = score; }
    if (core.lines !== lastLines) { el.vLines.textContent = String(core.lines); lastLines = core.lines; }
    var lv = runner.level_mode ? String(core.current_level()) : "-";
    if (lv !== lastLevel) { el.vLevel.textContent = lv; lastLevel = lv; }
    var st = runner.status || (runner.started && !runner.game_over ? "게임 진행 중" : "");
    if (st !== lastStatus) { el.status.textContent = st; lastStatus = st; }
    el.bHold.style.opacity = core.hold_used ? "0.45" : "1";
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
  // Game control
  // ==========================================================
  function hookRunner(r) {
    r.on("change", function () { dirty = true; });
    r.on("paused", function () { if (screen === "game") showPage("pgPause"); fillPause(); });
    r.on("gameover", function () {
      clearTimeout(overTimer);
      overTimer = setTimeout(showGameOver, 900);
      emit("gameover", r);
    });
    r.on("finished", function () { emit("finished", r); });
    r.on("outcome", function (o) { emit("outcome", o, r); });
    r.on("sound", function (name) { emit("sound", name, r); });
    r.on("record", function (ms, code) { emit("record", ms, code); });
    r.on("started", function () { emit("started", r); });
  }

  function startGame(opts) {
    opts = opts || {};
    clearTimeout(overTimer);
    if (runner) emit("abort", runner);
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
    lastStatus = lastScore = lastLines = lastLevel = null;
    emit("newgame", runner);
    gotoGame();
    runner.start_game(now());
    dirty = true;
    return runner;
  }

  function gameInProgress() {
    return runner && runner.started && !runner.game_over && !runner.finished;
  }

  function gotoGame() {
    screen = "game";
    hidePages();
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
    if (runner) runner.leave_screen(now());
  }

  function goMenu() {
    leaveGame();
    clearTimeout(overTimer);
    screen = "menu";
    refreshMenu();
    showPage("pgMenu");
  }

  function fillPause() {
    if (!runner) return;
    var core = runner.core;
    el.pauseInfo.innerHTML = resRows([
      ["SCORE", core.score.toLocaleString("en-US")],
      ["LINES", core.lines],
      ["LEVEL", runner.level_mode ? core.current_level() : "-"],
      ["TIME", NT.fmtTime(runner.ms())]
    ]);
  }

  function resRows(rows) {
    return rows.map(function (r) {
      return '<span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span>";
    }).join("");
  }

  function showGameOver() {
    if (!runner || !runner.game_over || screen !== "game") return;
    var core = runner.core;
    var ms = runner.ms(), mins = ms / 60000;
    el.overInfo.innerHTML = resRows([
      ["SCORE", core.score.toLocaleString("en-US")],
      ["LINES", core.lines],
      ["LEVEL", runner.level_mode ? core.current_level() : "-"],
      ["TIME", NT.fmtTime(ms)],
      ["APM", mins > 0.05 ? Math.round(core.stats.actions / mins) : 0]
    ]);
    showPage("pgOver");
  }

  // ==========================================================
  // Pages
  // ==========================================================
  var PAGES = ["pgMenu", "pgPause", "pgOver", "pgSettings"];
  function hidePages() { PAGES.forEach(function (p) { el[p].classList.remove("show"); }); }
  function showPage(id) { hidePages(); el[id].classList.add("show"); }

  function refreshMenu() {
    el.mClassic.textContent = "일반 모드" + (gameInProgress() ? " (이어하기)" : "");
    el.mLevel.textContent = "레벨업 모드: " + (settings.level_mode ? "ON" : "OFF");
    el.menuSub.textContent = "v5.4-mobile · " + (settings.level_mode
      ? "레벨업 모드: 줄을 지울수록 빨라져요." : "클래식 모드: 속도 고정.");
  }

  function setLevelMode(on) {
    settings.level_mode = !!on;
    if (runner) runner.setLevelMode(settings.level_mode);
    saveSettings();
    refreshMenu();
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
  }

  function closeSettings() {
    waitingKey = null;
    if (settingsFrom === "game" && runner) {
      screen = "game";
      if (gameInProgress() || (runner && runner.started && runner.paused)) { showPage("pgPause"); fillPause(); }
      else hidePages();
    } else {
      goMenu();
    }
  }

  function buildSettings() {
    var body = el.settingsBody;
    body.innerHTML = "";
    function sec(text) { var d = doc.createElement("div"); d.className = "sec"; d.textContent = text; body.appendChild(d); }
    function note(text) { var d = doc.createElement("div"); d.className = "note"; d.textContent = text; body.appendChild(d); }
    function row(label) {
      var r = doc.createElement("div"); r.className = "row";
      var l = doc.createElement("span"); l.className = "lb"; l.textContent = label;
      r.appendChild(l); body.appendChild(r); return r;
    }
    function slider(label, value, lo, hi, unit, onChange) {
      var r = row(label);
      var inp = doc.createElement("input");
      inp.type = "range"; inp.min = lo; inp.max = hi; inp.step = 1; inp.value = value;
      var v = doc.createElement("span"); v.className = "val"; v.textContent = value + unit;
      inp.addEventListener("input", function () { v.textContent = inp.value + unit; onChange(parseInt(inp.value, 10), false); });
      inp.addEventListener("change", function () { onChange(parseInt(inp.value, 10), true); });
      r.appendChild(inp); r.appendChild(v);
    }
    function toggle(label, get, set) {
      var r = row(label);
      var b = doc.createElement("button"); b.className = "btn tog";
      function paint() { var on = get(); b.textContent = on ? "ON" : "OFF"; b.classList.toggle("on", on); }
      b.addEventListener("click", function () { set(!get()); paint(); });
      paint(); r.appendChild(b);
    }
    function button(label, text, fn) {
      var r = row(label);
      var b = doc.createElement("button"); b.className = "btn"; b.textContent = text;
      b.addEventListener("click", fn); r.appendChild(b); return b;
    }

    sec("🎮 게임");
    toggle("레벨업 모드 (일반 모드)", function () { return settings.level_mode; }, setLevelMode);

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

    sec("⌨ 조작키 (키보드)");
    KEY_ACTIONS.forEach(function (a) {
      var b = button(a, keyLabel(settings.keys[a]), function () {
        waitingKey = a;
        buildSettings();
      });
      b.classList.add("keyBtn");
      if (waitingKey === a) { b.classList.add("wait"); b.textContent = "키 입력..."; }
    });
    button("기본 키로 복구", "초기화", function () {
      settings.keys = Object.assign({}, NT.DEFAULT_KEYS); waitingKey = null; saveSettings(); buildSettings();
    });
    note("Shift 키는 항상 홀드로 동작합니다. Esc = 일시정지 / 뒤로.");
    var v = doc.createElement("div"); v.className = "note"; v.style.marginTop = "18px";
    v.textContent = "NEON TETRIS v5.4-mobile (원본 v5.3 Tkinter 이식)";
    body.appendChild(v);
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
    return k.length === 1 ? k.toLowerCase() : k.toLowerCase();
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
        else if (runner) runner.pause(now());
      }
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
  function bindHold(btn, keyId, action) {
    var pid = null;
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      try { btn.setPointerCapture(pid); } catch (err) { /* ignore */ }
      btn.classList.add("on");
      if (runner && screen === "game") { runner.press(keyId, action, now()); dirty = true; }
    });
    function up(e) {
      if (pid === null || (e && e.pointerId !== pid)) return;
      pid = null;
      btn.classList.remove("on");
      if (runner) runner.release(keyId, now());
    }
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("lostpointercapture", up);
  }

  function bindTap(btn, fn) {
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      btn.classList.add("on");
      fn();
    });
    function off() { btn.classList.remove("on"); }
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointercancel", off);
    btn.addEventListener("pointerleave", off);
  }

  function act(action) {
    if (runner && screen === "game") { runner.action(action, now()); dirty = true; }
  }

  // board gestures
  var gest = null;
  function onBoardDown(e) {
    e.preventDefault();
    if (gest || screen !== "game") return;
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
    // swipe down -> hard drop (only if the gesture has not moved the piece sideways)
    var swipe = cell * settings.touch.swipe / 100;
    if (gest.steps === 0 && dyT > swipe && dyT > Math.abs(dxT) * 2) {
      gest.dropped = true;
      act(ACT.HARD);
      return;
    }
    // horizontal drag: one cell per (cell width * drag%) dragged
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
  // Loop
  // ==========================================================
  function frame() {
    if (runner && screen === "game") runner.update(now());
    if (dirty && screen !== "settings") { dirty = false; draw(); }
    global.requestAnimationFrame(frame);
  }

  // ==========================================================
  // Init
  // ==========================================================
  function init() {
    loadSettings();
    applyTheme(settings.theme);

    // game buttons
    bindHold(el.bLeft, "t:left", ACT.LEFT);
    bindHold(el.bRight, "t:right", ACT.RIGHT);
    bindHold(el.bSoft, "t:soft", ACT.SOFT);
    bindTap(el.bRot, function () { act(ACT.CW); });
    bindTap(el.bCcw, function () { act(ACT.CCW); });
    bindTap(el.bHold, function () { act(ACT.HOLD); });
    bindTap(el.bPause, function () { if (runner && screen === "game") runner.pause(now()); });
    bindTap(el.specPrev, function () { if (spec.onPrev) spec.onPrev(); });
    bindTap(el.specNext, function () { if (spec.onNext) spec.onNext(); });

    el.boardWrap.addEventListener("pointerdown", onBoardDown);
    el.boardWrap.addEventListener("pointermove", onBoardMove);
    el.boardWrap.addEventListener("pointerup", onBoardUp);
    el.boardWrap.addEventListener("pointercancel", onBoardUp);

    // pages
    el.mClassic.addEventListener("click", function () {
      if (gameInProgress()) { screen = "game"; showPage("pgPause"); fillPause(); queueLayout(); }
      else startGame({ mode: "classic" });
    });
    el.mLevel.addEventListener("click", function () { setLevelMode(!settings.level_mode); });
    el.mSettings.addEventListener("click", openSettings);
    el.pResume.addEventListener("click", resumeGame);
    el.pRestart.addEventListener("click", function () { startGame({ mode: runner ? runner.mode : "classic" }); });
    el.pMenu.addEventListener("click", goMenu);
    el.oAgain.addEventListener("click", function () { startGame({ mode: runner ? runner.mode : "classic" }); });
    el.oMenu.addEventListener("click", goMenu);
    el.sBack.addEventListener("click", closeSettings);

    // keyboard
    global.addEventListener("keydown", onKeyDown);
    global.addEventListener("keyup", onKeyUp);

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
    layout();
    global.requestAnimationFrame(frame);
  }

  NT.UI = {
    version: "5.4-mobile",
    themes: THEMES,
    applyTheme: applyTheme,
    store: store,
    settings: settings,
    saveSettings: saveSettings,
    spec: spec,
    on: function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
    startGame: startGame,
    goMenu: goMenu,
    layout: layout,
    get runner() { return runner; },
    get screen() { return screen; },
    helpers: { mix: mix, lighten: lighten, darken: darken, drawCell: drawCell }
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
