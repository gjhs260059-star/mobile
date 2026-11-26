/*
 * NEON TETRIS v5.4-mobile — core_v5.4.js
 * ---------------------------------------------------------------
 * UI-free game logic, a faithful port of GameCore from tetris.py (v5.3).
 *   - constants / SRS shapes / kick tables
 *   - rules + limits sanitizers, new_stats()
 *   - seeded PRNG (7-bag + garbage) -> deterministic for replay / multiplayer
 *   - GameCore   : board / pieces / scoring / T-spin / B2B / combo / PC / garbage / attack
 *   - GameClock  : pause-aware game clock (injectable "now")
 *   - GameRunner : the timer logic that the Tkinter UI class drove with root.after()
 *                  (gravity, lock delay + resets, line-clear animation, countdown,
 *                   pause, DAS/ARR key repeat), driven by explicit time values.
 * No DOM access here. Exposed as the global window.NT (or globalThis.NT).
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});
  NT.VERSION = "5.4-mobile";
  NT.CORE_VERSION = "5.4-mobile";

  // ==========================================================
  // Constants (tetris.py section 2)
  // ==========================================================
  var WIDTH = 10, HEIGHT = 20;
  var SPEED = 500, MIN_SPEED = 60, SPEED_STEP = 45, LINES_PER_LEVEL = 10;
  var LOCK_DELAY = 500, MAX_LOCK_RESETS = 15;
  var DAS = 140, ARR = 35, SOFT_DELAY = 90, SOFT_ARR = 40;
  var CLEAR_FRAMES = 6, CLEAR_FRAME_MS = 55, CLEAR_TOTAL_MS = CLEAR_FRAMES * CLEAR_FRAME_MS;
  var NEXT_COUNT = 3;
  var SPRINT_LINES = 40, SPRINT_SPEED = SPEED;

  // SRS shapes, order: I J L O S T Z
  var SHAPES = [
    [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    [[1, 1], [1, 1]],
    [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
  ];
  var PIECE_NAMES = ["I", "J", "L", "O", "S", "T", "Z"];

  function trim(shape) {
    var rows = shape.filter(function (r) { return r.some(Boolean); });
    var cols = [];
    for (var c = 0; c < shape[0].length; c++) {
      if (shape.some(function (r) { return r[c]; })) cols.push(c);
    }
    return rows.map(function (r) { return cols.map(function (c) { return r[c]; }); });
  }
  var TIGHT = SHAPES.map(trim);

  // SRS kicks: key "from,to" -> [[dx, dy]...]  (dy: up is +)
  var JLSTZ_KICKS = {
    "0,1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "1,0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "1,2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "2,1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "2,3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "3,2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "3,0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "0,3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
  };
  var I_KICKS = {
    "0,1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    "1,0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    "1,2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    "2,1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    "2,3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    "3,2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    "3,0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    "0,3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
  };

  // Actions (same Korean names as tetris.py DEFAULT_KEYS)
  var ACT = {
    LEFT: "왼쪽 이동", RIGHT: "오른쪽 이동", SOFT: "아래 이동",
    CW: "시계 회전", CCW: "반시계 회전", HARD: "즉시 낙하",
    HOLD: "홀드", PAUSE: "일시정지"
  };
  var DEFAULT_KEYS = {};
  DEFAULT_KEYS[ACT.LEFT] = "a";
  DEFAULT_KEYS[ACT.RIGHT] = "d";
  DEFAULT_KEYS[ACT.SOFT] = "s";
  DEFAULT_KEYS[ACT.CW] = "w";
  DEFAULT_KEYS[ACT.CCW] = "q";
  DEFAULT_KEYS[ACT.HARD] = "space";
  DEFAULT_KEYS[ACT.HOLD] = "c";      // Shift is always HOLD too
  DEFAULT_KEYS[ACT.PAUSE] = "p";

  var DEFAULT_SENS = { das: DAS, arr: ARR, soft_delay: SOFT_DELAY, soft_arr: SOFT_ARR };
  var SENS_RANGE = { das: [40, 400], arr: [5, 150], soft_delay: [20, 300], soft_arr: [5, 150] };

  // replay event codes (0-8 = tetris.py). v5.4 additions so every mode replays exactly:
  //   GARB / GARB_AWAIT: one garbage line received (multiplayer) before / during a line clear
  //   LVL_ON / LVL_OFF (+ _AWAIT): level mode toggled during a classic game (set_level_mode),
  //                    before / during a line clear
  var EV = { LEFT: 0, RIGHT: 1, SOFT: 2, CW: 3, CCW: 4, HARD: 5, HOLD: 6, GRAV: 7, LOCK: 8,
             GARB: 9, GARB_AWAIT: 10, LVL_ON: 11, LVL_OFF: 12, LVL_ON_AWAIT: 13, LVL_OFF_AWAIT: 14 };

  // ==========================================================
  // Rules / limits (tetris.py section 6)
  // ==========================================================
  var FRONT_CORNERS = {
    0: [[0, 0], [2, 0]],
    1: [[2, 0], [2, 2]],
    2: [[0, 2], [2, 2]],
    3: [[0, 0], [0, 2]]
  };
  var TSPIN_SCORE = [0, 800, 1200, 1600];
  var TSPIN_MINI_SCORE = [0, 200, 400, 400];
  var LINE_SCORE = [0, 100, 300, 500, 800];
  var PC_BONUS = [0, 800, 1200, 1800, 2000];
  var ATTACK_LINES = [0, 0, 1, 2, 4];
  var COMBO_ATTACK = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
  var MAX_GARBAGE_PER_LOCK = 8;

  var DEFAULT_RULES = { attack: [0, 1, 2, 4], tspin_mult: 2, b2b: 1,
                        combo_pct: 100, pc: 10, max_garbage: MAX_GARBAGE_PER_LOCK };
  var RULE_PRESETS = {
    "기본": DEFAULT_RULES,
    "뉴비": { attack: [0, 1, 1, 2], tspin_mult: 1, b2b: 0, combo_pct: 50, pc: 5, max_garbage: 4 },
    "하드코어": { attack: [1, 2, 4, 8], tspin_mult: 3, b2b: 2, combo_pct: 150, pc: 15, max_garbage: 12 },
    "콤보 중심": { attack: [0, 1, 2, 3], tspin_mult: 2, b2b: 1, combo_pct: 250, pc: 10, max_garbage: 8 }
  };
  var RULE_LIMITS = { attack: [0, 20], tspin_mult: [0, 6], b2b: [0, 10],
                      combo_pct: [0, 500], pc: [0, 40], max_garbage: [1, 20] };
  var LIMIT_KEYS = [["no_tspin", "T-스핀 금지"], ["no_hold", "홀드 금지"], ["no_ghost", "고스트 숨김"]];

  function isDict(d) { return d !== null && typeof d === "object" && !Array.isArray(d); }

  function sanitizeLimits(data) {
    var out = {};
    if (isDict(data)) {
      Object.keys(data).forEach(function (nick) {
        var d = data[nick];
        if (isDict(d)) {
          var lim = {}, any = false;
          LIMIT_KEYS.forEach(function (k) { if (d[k[0]]) { lim[k[0]] = true; any = true; } });
          if (any) out[Array.from(String(nick)).slice(0, 20).join("")] = lim;
        }
      });
    }
    return out;
  }

  function rulesText(r) {
    var a = r.attack;
    return "싱글 " + a[0] + " / 더블 " + a[1] + " / 트리플 " + a[2] + " / 테트리스 " + a[3] +
      " · T-스핀 ×" + r.tspin_mult + " · B2B +" + r.b2b + " · 콤보 " + r.combo_pct +
      "% · 퍼펙트 +" + r.pc + " · 방해줄 상한 " + r.max_garbage;
  }

  function sanitizeRules(data) {
    var out = {};
    Object.keys(DEFAULT_RULES).forEach(function (k) {
      var v = DEFAULT_RULES[k];
      out[k] = Array.isArray(v) ? v.slice() : v;
    });
    if (!isDict(data)) return out;
    function num(v, lim, def) {
      if (typeof v === "number" && isFinite(v)) return Math.max(lim[0], Math.min(lim[1], Math.trunc(v)));
      return def;
    }
    var att = data.attack;
    if (Array.isArray(att) && att.length === 4) {
      out.attack = att.map(function (a, i) { return num(a, RULE_LIMITS.attack, out.attack[i]); });
    }
    ["tspin_mult", "b2b", "combo_pct", "pc", "max_garbage"].forEach(function (k) {
      out[k] = num(data[k], RULE_LIMITS[k], out[k]);
    });
    return out;
  }

  function newStats() {
    return {
      singles: 0, doubles: 0, triples: 0, tetrises: 0,
      tspin: 0, tspin_mini: 0, tspin_zero: 0,
      tspin_single: 0, tspin_double: 0, tspin_triple: 0,
      max_combo: 0, max_b2b: 0,
      soft_drops: 0, hard_drops: 0, drop_dist: 0,
      pcs: 0, actions: 0, attack: 0, pieces: [0, 0, 0, 0, 0, 0, 0]
    };
  }

  // Python round() = banker's rounding (round half to even)
  function pyRound(x) {
    var f = Math.floor(x), diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  // ==========================================================
  // Seeded PRNG (mulberry32). Python used random.Random(seed); the exact
  // sequence differs, but the algorithm (Fisher-Yates shuffle, randrange)
  // mirrors Python's so a given seed is fully reproducible in JS.
  // ==========================================================
  function Rng(seed) {
    this.s = (seed >>> 0);
  }
  Rng.prototype.next = function () {           // float in [0, 1)
    var t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Rng.prototype.randrange = function (n) { return Math.floor(this.next() * n); };
  Rng.prototype.shuffle = function (a) {      // same loop as Python's random.shuffle
    for (var i = a.length - 1; i > 0; i--) {
      var j = this.randrange(i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
  Rng.prototype.getState = function () { return this.s; };
  Rng.prototype.setState = function (s) { this.s = s >>> 0; };

  function randomSeed() {
    try {
      var c = global.crypto;
      if (c && c.getRandomValues) {
        var a = new Uint32Array(1);
        c.getRandomValues(a);
        return a[0] >>> 0;
      }
    } catch (e) { /* ignore */ }
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }

  function rotateCW(shape) {      // zip(*shape[::-1])
    var n = shape.length, m = shape[0].length, out = [];
    for (var r = 0; r < m; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(shape[n - 1 - c][r]);
      out.push(row);
    }
    return out;
  }
  function rotateCCW(shape) {     // [list(r) for r in zip(*shape)][::-1]
    var n = shape.length, m = shape[0].length, out = [];
    for (var r = 0; r < m; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(shape[c][m - 1 - r]);
      out.push(row);
    }
    return out;
  }
  function copyShape(s) { return s.map(function (r) { return r.slice(); }); }
  function emptyRow() { var r = []; for (var i = 0; i < WIDTH; i++) r.push(0); return r; }

  // ==========================================================
  // GameCore
  // ==========================================================
  function GameCore(seed, levelMode, sprintTarget, rules, limits) {
    // accept an options object too: new GameCore({seed, levelMode, ...})
    if (isDict(seed)) {
      var o = seed;
      seed = o.seed; levelMode = o.levelMode; sprintTarget = o.sprintTarget;
      rules = o.rules; limits = o.limits;
    }
    if (levelMode === undefined) levelMode = true;
    this.rules = sanitizeRules(rules);
    var lim = {};
    LIMIT_KEYS.forEach(function (k) { if (isDict(limits) && limits[k[0]]) lim[k[0]] = true; });
    this.limits = lim;
    this.show_ghost = !this.limits.no_ghost;
    this.seed = (seed === null || seed === undefined) ? randomSeed() : (seed >>> 0);
    this.rng = new Rng(this.seed);
    this.level_mode = !!levelMode;
    this.sprint_target = sprintTarget || 0;

    this.board = [];
    for (var i = 0; i < HEIGHT; i++) this.board.push(emptyRow());
    this.score = 0;
    this.lines = 0;
    this.combo = -1;
    this.b2b = false;
    this.b2b_streak = 0;
    this.stats = newStats();
    this.incoming = 0;
    this.garbage_rng = new Rng((this.seed ^ 0x9E3779B9) >>> 0);

    this.hold_index = null;
    this.hold_used = false;
    this.queue = [];
    this.bag = [];

    this.game_over = false;
    this.finished = false;
    this.awaiting = null;
    this.active = false;
    this.piece_index = 0;
    this.rot = 0;
    this.shape = SHAPES[0];
    this.x = 0;
    this.y = 0;
    this.lock_resets = 0;
    this.last_rotate = false;
    this.last_kick = -1;

    this.refill_queue();
    this.new_piece();
  }

  var GP = GameCore.prototype;

  GP.current_level = function () {
    if (!this.level_mode) return 1;
    return Math.floor(this.lines / LINES_PER_LEVEL) + 1;
  };

  GP.refill_queue = function () {
    while (this.queue.length < NEXT_COUNT + 1) {
      if (!this.bag.length) {
        this.bag = [0, 1, 2, 3, 4, 5, 6];
        this.rng.shuffle(this.bag);
      }
      this.queue.push(this.bag.pop());
    }
  };

  GP.spawn = function (index) {
    this.piece_index = index;
    this.rot = 0;
    this.shape = copyShape(SHAPES[index]);
    this.x = Math.floor((WIDTH - this.shape[0].length) / 2);
    this.y = index === 0 ? -1 : 0;
    this.active = true;
    this.lock_resets = 0;
    this.last_rotate = false;
    this.last_kick = -1;
    if (this.collides(this.x, this.y, this.shape)) {
      this.game_over = true;
      this.active = false;
    }
  };

  GP.new_piece = function () {
    this.hold_used = false;
    var index = this.queue.shift();
    this.refill_queue();
    this.spawn(index);
  };

  GP.hold = function () {
    if (this.limits.no_hold || this.hold_used || !this.active || this.game_over || this.awaiting) return false;
    if (this.hold_index === null) {
      this.hold_index = this.piece_index;
      this.new_piece();
    } else {
      var saved = this.hold_index;
      this.hold_index = this.piece_index;
      this.spawn(saved);
    }
    this.hold_used = true;
    return true;
  };

  GP.collides = function (x, y, shape) {
    for (var r = 0; r < shape.length; r++) {
      var row = shape[r];
      for (var c = 0; c < row.length; c++) {
        if (row[c]) {
          var nx = x + c, ny = y + r;
          if (nx < 0 || nx >= WIDTH || ny >= HEIGHT) return true;
          if (ny >= 0 && this.board[ny][nx]) return true;
        }
      }
    }
    return false;
  };

  GP.ghost_y = function () {
    var gy = this.y;
    while (!this.collides(this.x, gy + 1, this.shape)) gy++;
    return gy;
  };

  GP._ready = function () { return this.active && !this.game_over && !this.awaiting; };

  GP.move = function (dx, dy) {
    if (!this._ready() || this.collides(this.x + dx, this.y + dy, this.shape)) return false;
    this.x += dx;
    this.y += dy;
    this.last_rotate = false;
    return true;
  };

  GP.soft_drop = function () {
    if (this.move(0, 1)) {
      this.score += 1;
      this.stats.soft_drops += 1;
      this.stats.drop_dist += 1;
      return true;
    }
    return false;
  };

  GP.gravity_step = function () { return this.move(0, 1); };

  GP.rotate = function (direction) {
    if (!this._ready() || this.piece_index === 3) return false;
    var rotated = direction > 0 ? rotateCW(this.shape) : rotateCCW(this.shape);
    var newRot = ((this.rot + direction) % 4 + 4) % 4;
    var table = this.piece_index === 0 ? I_KICKS : JLSTZ_KICKS;
    var kicks = table[this.rot + "," + newRot];
    for (var i = 0; i < kicks.length; i++) {
      var nx = this.x + kicks[i][0], ny = this.y - kicks[i][1];
      if (!this.collides(nx, ny, rotated)) {
        this.x = nx; this.y = ny;
        this.shape = rotated;
        this.rot = newRot;
        this.last_rotate = true;
        this.last_kick = i;
        return true;
      }
    }
    return false;
  };

  GP.hard_drop = function () {
    if (!this._ready()) return null;
    var dist = 0;
    while (!this.collides(this.x, this.y + 1, this.shape)) { this.y++; dist++; }
    if (dist) {
      this.score += 2 * dist;
      this.last_rotate = false;
    }
    this.stats.hard_drops += 1;
    this.stats.drop_dist += dist;
    return this.lock();
  };

  GP._blocked = function (x, y) {
    return x < 0 || x >= WIDTH || y >= HEIGHT || (y >= 0 && this.board[y][x] !== 0);
  };

  /** 0 = none, 1 = T-spin mini, 2 = T-spin (3-corner + front corners / 5th kick) */
  GP.detect_tspin = function () {
    if (this.limits.no_tspin || this.piece_index !== 5 || !this.last_rotate) return 0;
    var self = this, filled = 0;
    [[0, 0], [2, 0], [0, 2], [2, 2]].forEach(function (p) {
      if (self._blocked(self.x + p[0], self.y + p[1])) filled++;
    });
    if (filled < 3) return 0;
    var front = FRONT_CORNERS[this.rot].every(function (p) {
      return self._blocked(self.x + p[0], self.y + p[1]);
    });
    return (front || this.last_kick === 4) ? 2 : 1;
  };

  GP.lock = function () {
    if (!this.active || this.game_over || this.awaiting) return null;
    var tspin = this.detect_tspin();
    var lockout = false;
    for (var r = 0; r < this.shape.length; r++) {
      for (var c = 0; c < this.shape[r].length; c++) {
        if (this.shape[r][c]) {
          var nx = this.x + c, ny = this.y + r;
          if (ny < 0) lockout = true;
          else this.board[ny][nx] = this.piece_index + 1;
        }
      }
    }
    this.stats.pieces[this.piece_index] += 1;
    this.active = false;

    if (lockout) {
      this.game_over = true;
      return { rows: [], tspin: tspin, lockout: true, outcome: null };
    }
    var full = [];
    this.board.forEach(function (row, i) { if (row.every(Boolean)) full.push(i); });
    var info = { rows: full, tspin: tspin, lockout: false, outcome: null };
    if (full.length) this.awaiting = info;
    else info.outcome = this._score(info);
    return info;
  };

  GP.resolve = function () {
    var info = this.awaiting;
    if (info === null) return null;
    this.awaiting = null;
    var rows = {};
    info.rows.forEach(function (i) { rows[i] = true; });
    var keep = this.board.filter(function (row, i) { return !rows[i]; });
    var nb = [];
    for (var k = 0; k < info.rows.length; k++) nb.push(emptyRow());
    this.board = nb.concat(keep);
    info.outcome = this._score(info);
    return info.outcome;
  };

  GP.push_garbage = function (n) {
    for (var k = 0; k < n; k++) {
      if (this.board[0].some(Boolean)) this.game_over = true;
      var gap = this.garbage_rng.randrange(WIDTH);
      var row = [];
      for (var i = 0; i < WIDTH; i++) row.push(8);
      row[gap] = 0;
      this.board = this.board.slice(1).concat([row]);
    }
  };

  /** multiplayer hook: opponent attack arrives (applied on the next lock without a clear) */
  GP.receive_garbage = function (n) {
    n = Math.max(0, Math.trunc(n) || 0);
    if (n && this.on_garbage) this.on_garbage(n, this.awaiting !== null);   // replay recorder hook
    this.incoming += n;
    return this.incoming;
  };

  GP._score = function (info) {
    var cleared = info.rows.length;
    var tspin = info.tspin;
    var st = this.stats;
    var level = this.current_level();
    var msgs = [];
    var gained = 0, b2bHit = false, pc = false;

    if (cleared) {
      var c3 = Math.min(cleared, 3);
      if (tspin === 2) {
        gained = TSPIN_SCORE[c3];
        msgs.push("T-SPIN " + ["", "SINGLE", "DOUBLE", "TRIPLE"][c3]);
        st.tspin += 1;
        st[["", "tspin_single", "tspin_double", "tspin_triple"][c3]] += 1;
      } else if (tspin === 1) {
        gained = TSPIN_MINI_SCORE[c3];
        msgs.push("T-SPIN MINI" + ["", " SINGLE", " DOUBLE", ""][c3]);
        st.tspin_mini += 1;
      } else {
        gained = LINE_SCORE[cleared];
        if (cleared === 4) msgs.push("TETRIS");
      }
      st[["", "singles", "doubles", "triples", "tetrises"][cleared]] += 1;

      var difficult = tspin > 0 || cleared === 4;
      if (difficult && this.b2b) {
        gained = Math.floor(gained * 1.5);
        msgs.push("BACK-TO-BACK");
        b2bHit = true;
        this.b2b_streak += 1;
        st.max_b2b = Math.max(st.max_b2b, this.b2b_streak);
      } else {
        this.b2b_streak = 0;
      }
      this.b2b = difficult;

      this.combo += 1;
      if (this.combo > 0) {
        gained += 50 * this.combo;
        msgs.push(this.combo + " COMBO");
        st.max_combo = Math.max(st.max_combo, this.combo);
      }

      this.lines += cleared;

      if (this.board.every(function (row) { return !row.some(Boolean); })) {
        pc = true;
        gained += PC_BONUS[cleared];
        msgs.push("PERFECT CLEAR");
        st.pcs += 1;
      }
    } else {
      this.combo = -1;
      if (tspin === 2) {
        gained = 400;
        msgs.push("T-SPIN");
        st.tspin += 1;
        st.tspin_zero += 1;
      } else if (tspin === 1) {
        gained = 100;
        msgs.push("T-SPIN MINI");
        st.tspin_mini += 1;
      }
    }

    this.score += gained * level;

    var leveled = this.level_mode && this.current_level() > level;
    if (leveled) msgs.push("LEVEL UP! → " + this.current_level());

    // multiplayer: attack -> cancel incoming -> rise garbage if no clear
    var attack = 0;
    if (cleared) {
      var rl = this.rules;
      if (tspin === 2) attack = cleared * rl.tspin_mult;
      else if (tspin === 1) attack = cleared - 1;
      else attack = rl.attack[Math.min(cleared, 4) - 1];
      if (b2bHit) attack += rl.b2b;
      if (this.combo >= 0) {
        var base = COMBO_ATTACK[Math.min(this.combo, COMBO_ATTACK.length - 1)];
        attack += pyRound(base * rl.combo_pct / 100.0);
      }
      if (pc) attack += rl.pc;
    }
    var canceled = 0, added = 0;
    if (this.incoming) {
      if (attack) {
        canceled = Math.min(this.incoming, attack);
        this.incoming -= canceled;
        attack -= canceled;
      }
      if (!cleared && this.incoming) {
        added = Math.min(this.incoming, this.rules.max_garbage);
        this.incoming -= added;
        this.push_garbage(added);
      }
    }
    st.attack += attack;

    var done = !!this.sprint_target && this.lines >= this.sprint_target;
    if (done) {
      this.finished = true;
      this.active = false;
    } else {
      this.new_piece();
    }

    return {
      cleared: cleared, tspin: tspin, b2b: b2bHit, combo: this.combo,
      pc: pc, gained: gained * level, leveled: leveled, msgs: msgs,
      rows: info.rows.slice(), finished: done, game_over: this.game_over,
      attack: attack, canceled: canceled, garbage: added
    };
  };

  /** multiplayer snapshot, same tuple as tetris.py board_snapshot() */
  GP.board_snapshot = function () {
    var b = "";
    for (var y = 0; y < HEIGHT; y++) for (var x = 0; x < WIDTH; x++) b += this.board[y][x];
    return { b: b, pi: this.active ? this.piece_index : -1, r: this.rot, x: this.x, y: this.y,
             sc: this.score, ln: this.lines, inc: this.incoming };
  };

  function parseBoard(ev) {
    if (!isDict(ev)) return null;
    var b = ev.b;
    if (!(typeof b === "string" && b.length === WIDTH * HEIGHT && /^[0-8]+$/.test(b))) return null;
    var d = { b: b };
    ["pi", "r", "x", "y", "sc", "ln", "inc"].forEach(function (k) {
      var v = ev[k];
      d[k] = (typeof v === "number" && Number.isInteger(v)) ? v : 0;
    });
    return d;
  }

  // ==========================================================
  // GameClock (pause-aware). now() returns milliseconds.
  // ==========================================================
  function GameClock(now) {
    this.now = now || function () { return (global.performance ? global.performance.now() : Date.now()); };
    this.reset();
  }
  GameClock.prototype.reset = function () { this.t0 = 0; this.acc = 0; this.running = false; };
  GameClock.prototype.start = function () {
    if (!this.running) { this.t0 = this.now(); this.running = true; }
  };
  GameClock.prototype.stop = function () {
    if (this.running) { this.acc += this.now() - this.t0; this.running = false; }
  };
  GameClock.prototype.ms = function () {
    return Math.floor(this.acc + (this.running ? this.now() - this.t0 : 0));
  };

  // ==========================================================
  // GameRunner: the timer/input logic of the Tkinter Tetris class
  // (start_gravity/tick, after_move/ensure_lock/on_lock_timer,
  //  animate_clear/finish_clear, countdown, pause, DAS repeat).
  // Every timer is an absolute deadline; update(now) fires them in time
  // order, so behaviour does not depend on the frame rate.
  // ==========================================================
  var REPEATABLE = {};
  REPEATABLE[ACT.LEFT] = "lr";
  REPEATABLE[ACT.RIGHT] = "lr";
  REPEATABLE[ACT.SOFT] = "soft";

  function GameRunner(opts) {
    opts = opts || {};
    this.opts = opts;
    this.mode = opts.mode || "classic";             // classic / sprint / multi
    this.sens = Object.assign({}, DEFAULT_SENS, opts.sens || {});
    this.listeners = {};
    this._now = 0;
    var self = this;
    this.clock = new GameClock(function () { return self._now; });
    this.restart(opts.seed, opts.now || 0);
  }
  var RP = GameRunner.prototype;

  RP.on = function (name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); return this; };
  RP._emit = function (name, a, b) {
    var l = this.listeners[name];
    if (l) for (var i = 0; i < l.length; i++) l[i](a, b);
  };

  RP.restart = function (seed, now) {
    var o = this.opts;
    if (now !== undefined) this._now = now;
    var sprint = this.mode === "sprint";
    var target = sprint ? (o.sprintTarget || SPRINT_LINES) : 0;
    var lm = !!o.levelMode && this.mode === "classic";
    this.core = new GameCore(seed === undefined ? null : seed, lm, target,
                             this.mode === "multi" ? o.rules : null,
                             this.mode === "multi" ? o.limits : null);
    this.level_mode = lm;
    var self = this;
    this.core.on_garbage = function (n, awaiting) {      // replay: garbage is an input too
      for (var i = 0; i < n; i++) self._emit("record", self.clock.ms(), awaiting ? EV.GARB_AWAIT : EV.GARB);
    };
    this.clock.reset();
    this.clock_locked = false;
    this.started = false;
    this.paused = false;
    this.counting = false;
    this.count_number = 0;
    this.count_text = "";
    this.game_over = false;
    this.finished = false;
    this.animating = false;
    this.clearing = [];
    this.anim_step = 0;
    this.status = "";
    this.t = { grav: null, lock: null, anim: null, count: null, rep: null };
    this.repeat_key = null;
    this.repeat_action = null;
    this.held = {};          // keyId -> action
    this._emit("change");
  };

  /** set_level_mode(): applies to the running classic game immediately (as tetris.py) */
  RP.setLevelMode = function (on) {
    this.opts.levelMode = !!on;
    if (this.mode === "classic") {
      if (this.core.level_mode !== !!on) {
        var aw = this.core.awaiting !== null;
        this._emit("record", this.clock.ms(), on ? (aw ? EV.LVL_ON_AWAIT : EV.LVL_ON) : (aw ? EV.LVL_OFF_AWAIT : EV.LVL_OFF));
      }
      this.level_mode = !!on;
      this.core.level_mode = !!on;
    }
    this._emit("change");
  };

  RP.setSens = function (s) { this.sens = Object.assign({}, DEFAULT_SENS, s || {}); };

  RP.get_speed = function () {
    if (this.mode === "sprint") return SPRINT_SPEED;
    if (!this.level_mode) return SPEED;
    return Math.max(MIN_SPEED, SPEED - (this.core.current_level() - 1) * SPEED_STEP);
  };

  RP.repeatTiming = function (action) {
    var s = this.sens;
    return REPEATABLE[action] === "soft" ? [s.soft_delay, s.soft_arr] : [s.das, s.arr];
  };

  RP.rec = function (code) {
    if (this.started) this._emit("record", this.clock.ms(), code);
  };

  // ---------- timers ----------
  RP._set = function (name, delay) { this.t[name] = this._now + delay; };
  RP._cancel = function (name) { this.t[name] = null; };
  RP.cancel_timers = function (includeAnim) {
    this._cancel("grav"); this._cancel("count"); this._cancel("lock");
    if (includeAnim !== false) this._cancel("anim");
  };

  /** advance the simulation to wall/game time `now` (ms) */
  RP.update = function (now) {
    var guard = 0;
    for (;;) {
      var best = null, bt = Infinity;
      for (var k in this.t) {
        var v = this.t[k];
        if (v !== null && v <= now && v < bt) { bt = v; best = k; }
      }
      if (best === null || ++guard > 100000) break;
      this._now = bt;
      this.t[best] = null;
      this["_fire_" + best]();
    }
    this._now = Math.max(this._now, now);
  };

  RP.nextDeadline = function () {
    var bt = Infinity;
    for (var k in this.t) if (this.t[k] !== null && this.t[k] < bt) bt = this.t[k];
    return bt;
  };

  // ---------- start / countdown / pause ----------
  RP.start_game = function (now) {
    if (now !== undefined) this.update(now);
    if (this.game_over || this.counting || this.finished) return false;
    if (this.started && !this.paused) return false;
    this.paused = false;
    this.begin_countdown();
    return true;
  };

  RP.begin_countdown = function () {
    this.cancel_timers(false);
    this.counting = true;
    this.count_number = 3;
    this.status = "게임 준비 중...";
    this._countdown();
  };

  RP._countdown = function () {
    this.count_text = this.count_number > 0 ? String(this.count_number) : "START!";
    if (this.count_number > 0) {
      this.count_number -= 1;
      this._set("count", 700);
    } else {
      this._set("count", 500);
      this._finishPending = true;
    }
    this._emit("countdown", this.count_text);
    this._emit("change");
  };

  RP._fire_count = function () {
    if (this._finishPending) {
      this._finishPending = false;
      this.finish_countdown();
    } else {
      this._countdown();
    }
  };

  RP.finish_countdown = function () {
    this.counting = false;
    this.count_text = "";
    this.started = true;
    this.paused = false;
    if (!this.clock_locked) this.clock.start();
    this.status = "";
    if (!this.animating) {
      this.ensure_lock();
      this.start_gravity();
    }
    this._emit("started");
    this._emit("change");
  };

  RP.pause = function (now) {
    if (now !== undefined) this.update(now);
    if (this.mode === "multi" || !this.started || this.game_over || this.counting || this.finished) return false;
    if (this.paused) return this.start_game();
    this.paused = true;
    this.clock.stop();
    this._cancel("grav");
    this._cancel("lock");
    this.stop_repeat();
    this.status = "일시정지";
    this._emit("paused");
    this._emit("change");
    return true;
  };

  /** leave_game_screen(): going to the menu / app hidden -> pause (countdown is aborted) */
  RP.leave_screen = function (now) {
    if (now !== undefined) this.update(now);
    if (this.counting) {
      this._cancel("count");
      this._finishPending = false;
      this.counting = false;
      this.count_text = "";
      if (this.started) { this.paused = true; this.status = "일시정지"; }
    } else if (this.started && !this.paused && !this.game_over && !this.finished) {
      this.pause();
    }
    this.releaseAll();
    this._emit("change");
  };

  // ---------- gravity / lock delay ----------
  RP.start_gravity = function () { this._set("grav", this.get_speed()); };

  RP._fire_grav = function () {
    if (!this.started || this.paused || this.game_over || this.counting || this.animating) return;
    var core = this.core;
    if (core.active) {
      if (core.gravity_step()) {
        this.rec(EV.GRAV);
        this.after_move();
        this._emit("change");
      } else {
        this.ensure_lock();
      }
    }
    this.start_gravity();
  };

  RP.grounded = function () {
    var c = this.core;
    return c.collides(c.x, c.y + 1, c.shape);
  };

  RP.after_move = function () {
    var core = this.core;
    if (this.grounded()) {
      if (this.t.lock === null) {
        this._set("lock", LOCK_DELAY);
      } else if (core.lock_resets < MAX_LOCK_RESETS) {
        core.lock_resets += 1;
        this._set("lock", LOCK_DELAY);
      }
    } else {
      this._cancel("lock");
    }
  };

  RP.ensure_lock = function () {
    if (this.core.active && this.t.lock === null && this.grounded()) this._set("lock", LOCK_DELAY);
  };

  RP._fire_lock = function () {
    var core = this.core;
    if (!core.active || this.game_over || this.animating || this.paused || this.counting) return;
    this.rec(EV.LOCK);
    this.handle_lock(core.lock());
  };

  // ---------- actions ----------
  RP.do_move = function (dx) {
    if (this.core.move(dx, 0)) {
      this.rec(dx < 0 ? EV.LEFT : EV.RIGHT);
      this.after_move();
      this._emit("move", dx);
      this._emit("change");
      return true;
    }
    return false;
  };

  RP.do_soft = function () {
    if (this.core.soft_drop()) {
      this.rec(EV.SOFT);
      this.after_move();
      this._emit("change");
      return true;
    }
    return false;
  };

  RP.do_rotate = function (direction) {
    if (this.core.rotate(direction)) {
      this.rec(direction > 0 ? EV.CW : EV.CCW);
      this._emit("sound", "rotate");
      this.after_move();
      this._emit("change");
      return true;
    }
    return false;
  };

  RP.do_hold = function () {
    if (this.core.limits.no_hold) {
      this.status = "🚫 방장이 홀드를 금지했어요";
      this._emit("change");
      return false;
    }
    if (this.core.hold()) {
      this.rec(EV.HOLD);
      this._emit("sound", "hold");
      this._cancel("lock");
      if (this.core.game_over) { this.end_game(); return true; }
      this._emit("change");
      return true;
    }
    return false;
  };

  RP.do_drop = function () {
    if (!this.core.active) return false;
    this.rec(EV.HARD);
    this.handle_lock(this.core.hard_drop());
    return true;
  };

  RP.can_act = function () {
    return this.started && !this.paused && !this.game_over && !this.counting &&
      !this.animating && !this.finished && this.core.active;
  };

  RP.apply_action = function (action) {
    switch (action) {
      case ACT.LEFT: return this.do_move(-1);
      case ACT.RIGHT: return this.do_move(1);
      case ACT.SOFT: return this.do_soft();
      case ACT.CW: return this.do_rotate(1);
      case ACT.CCW: return this.do_rotate(-1);
      case ACT.HARD: return this.do_drop();
      case ACT.HOLD: return this.do_hold();
    }
    return false;
  };

  /** single action (tap / drag step). Counts toward APM like a key press. */
  RP.action = function (action, now) {
    if (now !== undefined) this.update(now);
    if (action === ACT.PAUSE) return this.pause();
    if (!this.can_act()) return false;
    var ok = this.apply_action(action);
    if (ok) this.core.stats.actions += 1;
    return ok;
  };

  /** key/button down (on_press). keyId distinguishes physical sources. */
  RP.press = function (keyId, action, now) {
    if (now !== undefined) this.update(now);
    if (this.held[keyId] !== undefined) return false;   // auto-repeat
    this.held[keyId] = action;
    if (this.counting) return false;
    if (action === ACT.PAUSE) { this.pause(); return true; }
    if (!this.can_act()) return false;
    var ok = this.apply_action(action);
    if (ok) this.core.stats.actions += 1;
    if (REPEATABLE[action]) this.start_repeat(keyId, action, this.repeatTiming(action)[0]);
    return ok;
  };

  RP.release = function (keyId, now) {
    if (now !== undefined) this.update(now);
    if (this.held[keyId] === undefined) return;
    delete this.held[keyId];
    if (this.repeat_key === keyId) {
      this.stop_repeat();
      for (var hk in this.held) {
        var act = this.held[hk];
        if (REPEATABLE[act] && this.can_act()) {
          this.start_repeat(hk, act, this.repeatTiming(act)[1]);
          break;
        }
      }
    }
  };

  RP.releaseAll = function () {
    this.held = {};
    this.stop_repeat();
  };

  RP.start_repeat = function (keyId, action, delay) {
    this.stop_repeat();
    this.repeat_key = keyId;
    this.repeat_action = action;
    this._set("rep", delay);
  };

  RP.stop_repeat = function () {
    this._cancel("rep");
    this.repeat_key = null;
    this.repeat_action = null;
  };

  RP._fire_rep = function () {
    var key = this.repeat_key, action = this.repeat_action;
    if (key === null || this.held[key] === undefined ||
        !(this.started && !this.paused && !this.game_over && !this.counting)) {
      this.repeat_key = null; this.repeat_action = null;
      return;
    }
    if (this.can_act()) this.apply_action(action);
    this._set("rep", this.repeatTiming(action)[1]);
  };

  // ---------- lock / line clear ----------
  RP.handle_lock = function (info) {
    this._cancel("lock");
    if (info === null || info === undefined) return;
    if (info.lockout) { this.end_game(); return; }
    var rows = info.rows;
    if (rows.length) {
      var core = this.core;
      if (core.sprint_target && core.lines + rows.length >= core.sprint_target) {
        this.clock.stop();
        this.clock_locked = true;
      }
      this.start_clear_animation(rows);
    } else {
      this.after_lock(info.outcome);
      if (this.core.game_over) { this.end_game(); return; }
      this._emit("change");
      if (this.started && !this.paused && !this.game_over && !this.counting) this.start_gravity();
    }
  };

  RP.start_clear_animation = function (rows) {
    this.animating = true;
    this.clearing = rows.slice();
    this.anim_step = 0;
    this._cancel("grav");
    this._emit("clearstart", rows.slice());
    this._fire_anim();
  };

  RP._fire_anim = function () {
    if (!this.animating) return;
    if (this.anim_step >= CLEAR_FRAMES) { this.finish_clear(); return; }
    this.anim_step += 1;
    this._emit("change");
    this._set("anim", CLEAR_FRAME_MS);
  };

  RP.finish_clear = function () {
    var outcome = this.core.resolve();
    this.clearing = [];
    this.animating = false;
    this.after_lock(outcome);
    if (outcome.finished) { this.finish_sprint(); return; }
    if (this.core.game_over) { this.end_game(); return; }
    this._emit("change");
    if (this.started && !this.paused && !this.game_over && !this.counting) this.start_gravity();
  };

  RP.after_lock = function (o) {
    if (this.mode === "multi") {
      if (o.canceled) o.msgs.push("🛡️ " + o.canceled + "줄 상쇄!");
      if (o.garbage) { o.msgs.push("⚠️ 방해줄 " + o.garbage + "줄 올라옴"); this._emit("sound", "garbage"); }
    }
    if (o.msgs.length) this.status = o.msgs.join(" · ");
    else if (!this.game_over && this.started) this.status = "";
    this._emit("outcome", o);
    this._emit("sound", outcomeSound(o));
  };

  RP.receive_garbage = function (n) {
    this.core.receive_garbage(n);
    this._emit("change");
  };

  RP.end_game = function () {
    if (this.game_over) return;
    this.game_over = true;
    this.core.active = false;
    this.cancel_timers();
    this.stop_repeat();
    this.clock.stop();
    this.clock_locked = true;
    this.animating = false;
    this.clearing = [];
    this.status = "게임 오버!";
    this._emit("sound", "gameover");
    this._emit("gameover");
    this._emit("change");
  };

  RP.finish_sprint = function () {
    this.finished = true;
    this.cancel_timers();
    this.stop_repeat();
    this.clock.stop();
    this.clock_locked = true;
    this._emit("finished");
    this._emit("change");
  };

  RP.ms = function () { return this.clock.ms(); };

  function outcomeSound(o) {
    if (o.pc) return "pc";
    if (o.leveled) return "levelup";
    if (o.cleared === 4) return "tetris";
    if (o.tspin) return "tspin";
    if (o.cleared) return "clear";
    return "lock";
  }

  function fmtTime(ms) {
    if (ms === null || ms === undefined) return "--:--.--";
    var cs = Math.floor(Math.max(0, Math.trunc(ms)) / 10);
    var sec = (cs % 6000) / 100;
    var s = sec.toFixed(2);
    if (sec < 10) s = "0" + s;
    return Math.floor(cs / 6000) + ":" + s;
  }

  // ==========================================================
  // exports
  // ==========================================================
  Object.assign(NT, {
    WIDTH: WIDTH, HEIGHT: HEIGHT,
    SPEED: SPEED, MIN_SPEED: MIN_SPEED, SPEED_STEP: SPEED_STEP, LINES_PER_LEVEL: LINES_PER_LEVEL,
    LOCK_DELAY: LOCK_DELAY, MAX_LOCK_RESETS: MAX_LOCK_RESETS,
    DAS: DAS, ARR: ARR, SOFT_DELAY: SOFT_DELAY, SOFT_ARR: SOFT_ARR,
    CLEAR_FRAMES: CLEAR_FRAMES, CLEAR_FRAME_MS: CLEAR_FRAME_MS, CLEAR_TOTAL_MS: CLEAR_TOTAL_MS,
    NEXT_COUNT: NEXT_COUNT, SPRINT_LINES: SPRINT_LINES, SPRINT_SPEED: SPRINT_SPEED,
    SHAPES: SHAPES, PIECE_NAMES: PIECE_NAMES, TIGHT: TIGHT, trim: trim,
    JLSTZ_KICKS: JLSTZ_KICKS, I_KICKS: I_KICKS,
    ACT: ACT, DEFAULT_KEYS: DEFAULT_KEYS, DEFAULT_SENS: DEFAULT_SENS, SENS_RANGE: SENS_RANGE, EV: EV,
    FRONT_CORNERS: FRONT_CORNERS, TSPIN_SCORE: TSPIN_SCORE, TSPIN_MINI_SCORE: TSPIN_MINI_SCORE,
    LINE_SCORE: LINE_SCORE, PC_BONUS: PC_BONUS, ATTACK_LINES: ATTACK_LINES, COMBO_ATTACK: COMBO_ATTACK,
    MAX_GARBAGE_PER_LOCK: MAX_GARBAGE_PER_LOCK,
    DEFAULT_RULES: DEFAULT_RULES, RULE_PRESETS: RULE_PRESETS, RULE_LIMITS: RULE_LIMITS, LIMIT_KEYS: LIMIT_KEYS,
    sanitizeRules: sanitizeRules, sanitizeLimits: sanitizeLimits, rulesText: rulesText, newStats: newStats,
    pyRound: pyRound, Rng: Rng, randomSeed: randomSeed, rotateCW: rotateCW, rotateCCW: rotateCCW,
    GameCore: GameCore, GameClock: GameClock, GameRunner: GameRunner,
    parseBoard: parseBoard, outcomeSound: outcomeSound, fmtTime: fmtTime
  });
})(typeof window !== "undefined" ? window : globalThis);
