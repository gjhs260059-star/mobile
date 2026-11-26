/*
 * NEON TETRIS v5.4-mobile — stores_v5.4.js
 * ---------------------------------------------------------------
 * Port of tetris.py (v5.3) section 9 + TOP 5 high scores:
 *   ScoreStore       (highscore.json      -> localStorage "nt54_highscore")
 *   StatsStore       (statistics.json     -> "nt54_statistics")
 *   SprintStore      (sprint_records.json -> "nt54_sprint_records")
 *   AchievementStore (achievements.json   -> "nt54_achievements")
 *   ACHIEVEMENTS, metricsFromStats / sessionMetrics / combineMetrics, fmtDur
 * Loaded data is sanitized exactly like the Python loaders. Every storage access
 * is wrapped in try/catch; a corrupt entry is kept as "<key>.corrupt" (read_json).
 * Storage backend is injectable (node tests): new NT.Stores.Storage(prefix, backend).
 * Exposed as window.NT.Stores.
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});

  var MAX_RECORDS = 5;
  var MAX_HISTORY = 100;
  var SPRINT_BEST_KEEP = 10;
  var SPRINT_RECENT_KEEP = 20;

  // ---------------- storage (read_json / write_json) ----------------
  function Storage(prefix, backend) {
    this.prefix = prefix === undefined ? "nt54_" : prefix;
    this.backend = backend || null;
  }
  Storage.prototype._ls = function () {
    if (this.backend) return this.backend;
    try { return global.localStorage || null; } catch (e) { return null; }
  };
  /** JSON read. missing -> def; corrupt -> keep the raw text as "<key>.corrupt" and return def */
  Storage.prototype.read = function (key, def) {
    var ls = this._ls(), raw = null;
    if (!ls) return def;
    try { raw = ls.getItem(this.prefix + key); } catch (e) { return def; }
    if (raw === null || raw === undefined) return def;
    try { return JSON.parse(raw); } catch (e) {
      try { console.warn("[경고] " + key + " 를 읽을 수 없어 기본값을 사용합니다: " + e); } catch (e2) { /* ignore */ }
      try { ls.setItem(this.prefix + key + ".corrupt", raw); ls.removeItem(this.prefix + key); } catch (e3) { /* ignore */ }
      return def;
    }
  };
  Storage.prototype.write = function (key, data) {
    var ls = this._ls();
    if (!ls) return false;
    try { ls.setItem(this.prefix + key, JSON.stringify(data)); return true; }
    catch (e) {
      try { console.warn("[경고] " + key + " 저장 실패: " + e); } catch (e2) { /* ignore */ }
      return false;
    }
  };
  Storage.prototype.remove = function (key) {
    var ls = this._ls();
    try { if (ls) ls.removeItem(this.prefix + key); } catch (e) { /* ignore */ }
  };

  // ---------------- helpers ----------------
  function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
  function isDict(d) { return d !== null && typeof d === "object" && !Array.isArray(d); }
  function int(v) { var n = Number(v); return isFinite(n) ? Math.trunc(n) : 0; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function today(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function nowStamp(d) {
    d = d || new Date();
    return today(d) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmtTime(ms) {
    if (NT.fmtTime) return NT.fmtTime(ms);
    if (ms === null || ms === undefined) return "--:--.--";
    var cs = Math.floor(Math.max(0, Math.trunc(ms)) / 10), sec = (cs % 6000) / 100;
    return Math.floor(cs / 6000) + ":" + (sec < 10 ? "0" : "") + sec.toFixed(2);
  }
  /** fmt_dur: 1시간 2분 3초 */
  function fmtDur(ms) {
    var s = Math.floor(Math.max(0, int(ms)) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    if (h) return h + "시간 " + m + "분 " + s + "초";
    if (m) return m + "분 " + s + "초";
    return s + "초";
  }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }

  // ==========================================================
  // TOP 5 (load_scores / record_score)
  // ==========================================================
  function ScoreStore(storage) {
    this.storage = storage || new Storage();
    this.scores = [];
    this.load();
  }
  ScoreStore.prototype.load = function () {
    var data = this.storage.read("highscore", null);
    var result = [];
    if (isDict(data)) {
      var list = Array.isArray(data.high_scores) ? data.high_scores : [];
      list.forEach(function (item) {
        if (isDict(item) && isInt(item.score)) {
          result.push({ score: item.score, date: item.date === undefined || item.date === null ? "" : String(item.date) });
        }
      });
      if (!result.length && isInt(data.high_score) && data.high_score > 0) {
        result.push({ score: data.high_score, date: "" });
      }
    }
    result.sort(function (a, b) { return b.score - a.score; });
    this.scores = result.slice(0, MAX_RECORDS);
  };
  ScoreStore.prototype.best = function () { return this.scores.length ? this.scores[0].score : 0; };
  /** add a classic score -> returns its rank (0-based) or null if it fell out of the TOP 5 */
  ScoreStore.prototype.add = function (score, date) {
    var entry = { score: score, date: date || today() };
    this.scores.push(entry);
    this.scores.sort(function (a, b) { return b.score - a.score; });    // stable, like Python
    this.scores = this.scores.slice(0, MAX_RECORDS);
    var rank = this.scores.indexOf(entry);
    this.storage.write("highscore", { high_score: this.best(), high_scores: this.scores });
    return rank >= 0 ? rank : null;
  };

  // ==========================================================
  // StatsStore
  // ==========================================================
  var STAT_MODES = ["classic", "sprint", "multi"];
  var SUM_KEYS = ["soft_drops", "hard_drops", "drop_dist", "pcs", "actions", "attack",
                  "singles", "doubles", "triples", "tetrises",
                  "tspin", "tspin_mini", "tspin_zero", "tspin_single", "tspin_double", "tspin_triple"];
  var MAX_KEYS = ["max_combo", "max_b2b"];

  function emptyModeStats() {
    var d = { games: 0, finished: 0, fails: 0, aborted: 0,
              play_time_ms: 0, score_total: 0, best_score: 0, lines: 0,
              max_survival_ms: 0, best_time_ms: null, records_broken: 0, wins: 0,
              pieces: [0, 0, 0, 0, 0, 0, 0] };
    SUM_KEYS.concat(MAX_KEYS).forEach(function (k) { d[k] = 0; });
    return d;
  }

  function StatsStore(storage) {
    this.storage = storage || new Storage();
    this.data = { version: 1, modes: {}, history: [] };
    var self = this;
    STAT_MODES.forEach(function (m) { self.data.modes[m] = emptyModeStats(); });
    this.load();
  }
  StatsStore.prototype.load = function () {
    var raw = this.storage.read("statistics", null);
    if (!isDict(raw)) return;
    var modes = raw.modes, self = this;
    if (isDict(modes)) {
      STAT_MODES.forEach(function (m) {
        var src = modes[m];
        if (!isDict(src)) return;
        var dst = self.data.modes[m];
        Object.keys(dst).forEach(function (k) {
          var v = src[k];
          if (k === "pieces") {
            if (Array.isArray(v) && v.length === 7 && v.every(isInt)) dst[k] = v.slice();
          } else if (k === "best_time_ms") {
            if (isInt(v) && v > 0) dst[k] = v;
          } else if (isInt(v)) {
            dst[k] = v;
          }
        });
      });
    }
    var hist = raw.history;
    if (Array.isArray(hist)) this.data.history = hist.filter(isDict).slice(-MAX_HISTORY);
  };
  StatsStore.prototype.save = function () { return this.storage.write("statistics", this.data); };
  StatsStore.prototype.totals = function (mode) { return this.data.modes[mode]; };
  /** add one game summary (s.mode keeps modes separate) */
  StatsStore.prototype.add_game = function (s) {
    var t = this.data.modes[s.mode];
    if (!t) return;
    t.games += 1;
    if (s.outcome === "cleared" || s.outcome === "win") {
      t.finished += 1;
      if (s.outcome === "win") t.wins += 1;
    } else if (s.outcome === "gameover") {
      t.fails += 1;
    } else {
      t.aborted += 1;
    }
    t.play_time_ms += s.time_ms;
    t.score_total += s.score;
    t.best_score = Math.max(t.best_score, s.score);
    t.lines += s.lines;
    var st = s.stats || {};
    SUM_KEYS.forEach(function (k) { t[k] += int(st[k] || 0); });
    MAX_KEYS.forEach(function (k) { t[k] = Math.max(t[k], int(st[k] || 0)); });
    for (var i = 0; i < 7; i++) t.pieces[i] += int(st.pieces ? st.pieces[i] : 0);
    t.max_survival_ms = Math.max(t.max_survival_ms, s.time_ms);
    if (s.outcome === "cleared") {
      if (t.best_time_ms === null || s.time_ms < t.best_time_ms) t.best_time_ms = s.time_ms;
    }
    if (s.record === "broken") t.records_broken += 1;
    this.data.history.push({
      mode: s.mode, date: s.date, outcome: s.outcome,
      time_ms: s.time_ms, score: s.score, lines: s.lines,
      apm: round1(s.apm), ppm: round1(s.ppm) });
    this.data.history = this.data.history.slice(-MAX_HISTORY);
    this.save();
  };
  StatsStore.prototype.addGame = StatsStore.prototype.add_game;

  // ==========================================================
  // SprintStore
  // ==========================================================
  function SprintStore(storage) {
    this.storage = storage || new Storage();
    this.best = [];
    this.recent = [];
    this.load();
  }
  SprintStore._clean = function (lst, cap) {
    var out = [];
    if (Array.isArray(lst)) {
      lst.forEach(function (e) { if (isDict(e) && isInt(e.time_ms) && e.time_ms > 0) out.push(e); });
    }
    return out.slice(0, cap);
  };
  SprintStore.prototype.load = function () {
    var raw = this.storage.read("sprint_records", null);
    if (isDict(raw)) {
      this.best = SprintStore._clean(raw.best, SPRINT_BEST_KEEP);
      this.best.sort(function (a, b) { return a.time_ms - b.time_ms; });
      this.recent = SprintStore._clean(raw.recent, SPRINT_RECENT_KEEP);
    }
  };
  SprintStore.prototype.save = function () {
    return this.storage.write("sprint_records", { best: this.best, recent: this.recent });
  };
  SprintStore.prototype.best_ms = function () { return this.best.length ? this.best[0].time_ms : null; };
  /** returns "first" (first clear) / "broken" (new best) / null */
  SprintStore.prototype.add = function (entry) {
    var prev = this.best_ms(), kind = null;
    if (prev === null) kind = "first";
    else if (entry.time_ms < prev) kind = "broken";
    this.recent.unshift(entry);
    this.recent = this.recent.slice(0, SPRINT_RECENT_KEEP);
    this.best.push(entry);
    this.best.sort(function (a, b) { return a.time_ms - b.time_ms; });
    this.best = this.best.slice(0, SPRINT_BEST_KEEP);
    this.save();
    return kind;
  };

  // ==========================================================
  // Achievements  (id, name, desc, metric, goal, ge|le)
  // ==========================================================
  var ACHIEVEMENTS = [
    ["first_line", "첫 발자국", "처음으로 줄을 삭제한다", "lines_total", 1, "ge"],
    ["first_tetris", "테트리스!", "한 번에 4줄을 삭제한다", "tetrises", 1, "ge"],
    ["combo_10", "콤보 폭주", "10콤보를 달성한다", "max_combo", 10, "ge"],
    ["first_tspin", "회전의 기술", "T-스핀(또는 미니)에 처음 성공한다", "tspin_any", 1, "ge"],
    ["first_pc", "신의 손", "퍼펙트 클리어를 처음 달성한다", "pcs", 1, "ge"],
    ["lines_1000", "줄지우기 장인", "누적 1,000줄을 삭제한다", "lines_total", 1000, "ge"],
    ["sprint_finish", "스프린터", "스프린트 40줄을 완주한다", "sprint_clears", 1, "ge"],
    ["sprint_record", "신기록 사냥꾼", "스프린트 최고 기록을 갱신한다", "sprint_broken", 1, "ge"],
    ["score_50k", "5만 점 클럽", "일반 모드에서 50,000점을 넘긴다", "best_score", 50000, "ge"],
    ["score_100k", "10만 점 클럽", "일반 모드에서 100,000점을 넘긴다", "best_score", 100000, "ge"],
    ["score_500k", "50만 점의 전설", "일반 모드에서 500,000점을 넘긴다", "best_score", 500000, "ge"],
    ["survive_5m", "버티기 입문", "한 판에서 5분 이상 생존한다", "max_survival_ms", 300000, "ge"],
    ["survive_15m", "철인", "한 판에서 15분 이상 생존한다", "max_survival_ms", 900000, "ge"],
    ["tspin_triple", "트리플 스피너", "T-스핀 트리플에 성공한다", "tspin_triple", 1, "ge"],
    ["b2b_5", "연속 고난도", "Back-to-Back을 5연속으로 잇는다", "max_b2b", 5, "ge"],
    ["combo_20", "끝나지 않는 콤보", "20콤보를 달성한다", "max_combo", 20, "ge"],
    ["pc_10", "완벽주의자", "퍼펙트 클리어를 10회 달성한다", "pcs", 10, "ge"],
    ["tetris_500", "테트리스 중독", "테트리스를 누적 500회 성공한다", "tetrises", 500, "ge"],
    ["tspin_100", "T 마스터", "T-스핀을 누적 100회 성공한다", "tspin", 100, "ge"],
    ["lines_10000", "만 줄의 신화", "누적 10,000줄을 삭제한다", "lines_total", 10000, "ge"],
    ["games_100", "단골 손님", "게임을 100판 플레이한다", "games_total", 100, "ge"],
    ["drops_10000", "낙하의 달인", "하드 드롭을 누적 10,000회 한다", "hard_drops", 10000, "ge"],
    ["sprint_120", "2분의 벽", "스프린트를 2분 안에 완주한다", "sprint_best_ms", 120000, "le"],
    ["sprint_60", "1분의 벽", "스프린트를 1분 안에 완주한다", "sprint_best_ms", 60000, "le"],
    ["sprint_40", "초인", "스프린트를 40초 안에 완주한다", "sprint_best_ms", 40000, "le"],
    ["first_win", "첫 승리", "멀티플레이에서 1위를 차지한다", "multi_wins", 1, "ge"],
    ["win_10", "상위 포식자", "멀티플레이에서 10번 승리한다", "multi_wins", 10, "ge"],
    ["attack_100", "공격 개시", "멀티플레이에서 누적 100줄을 공격한다", "attack_total", 100, "ge"]
  ];
  var ACH_BY_ID = {};
  ACHIEVEMENTS.forEach(function (a) { ACH_BY_ID[a[0]] = a; });
  var ADD_METRICS = ["lines_total", "tetrises", "tspin", "tspin_any", "tspin_triple", "pcs", "hard_drops",
                     "attack_total"];
  var MAX_METRICS = ["max_combo", "max_b2b", "best_score", "max_survival_ms"];

  /** achievement metrics from the saved totals (classic + sprint + multi) */
  function metricsFromStats(store) {
    var c = store.totals("classic"), s = store.totals("sprint"), m = store.totals("multi");
    var allm = [c, s, m];
    function tot(k) { return allm.reduce(function (a, x) { return a + x[k]; }, 0); }
    function mx(k) { return Math.max.apply(null, allm.map(function (x) { return x[k]; })); }
    return {
      lines_total: tot("lines"),
      tetrises: tot("tetrises"),
      tspin: tot("tspin"),
      tspin_any: tot("tspin") + tot("tspin_mini"),
      tspin_triple: tot("tspin_triple"),
      pcs: tot("pcs"),
      hard_drops: tot("hard_drops"),
      attack_total: tot("attack"),
      max_combo: mx("max_combo"),
      max_b2b: mx("max_b2b"),
      best_score: c.best_score,
      max_survival_ms: c.max_survival_ms,
      sprint_clears: s.finished,
      sprint_best_ms: s.best_time_ms,
      sprint_broken: s.records_broken,
      multi_wins: m.wins,
      games_total: tot("games")
    };
  }

  /** metrics of the game in progress (so achievements unlock before it is saved) */
  function sessionMetrics(core, mode, timeMs) {
    var st = core.stats;
    return {
      lines_total: core.lines, tetrises: st.tetrises, tspin: st.tspin,
      tspin_any: st.tspin + st.tspin_mini, tspin_triple: st.tspin_triple,
      pcs: st.pcs, hard_drops: st.hard_drops, attack_total: st.attack,
      max_combo: st.max_combo, max_b2b: st.max_b2b,
      best_score: mode === "classic" ? core.score : 0,
      max_survival_ms: mode === "classic" ? timeMs : 0
    };
  }

  function combineMetrics(base, sess) {
    var m = Object.assign({}, base);
    ADD_METRICS.forEach(function (k) { m[k] = base[k] + (sess[k] || 0); });
    MAX_METRICS.forEach(function (k) { m[k] = Math.max(base[k], sess[k] || 0); });
    return m;
  }

  function AchievementStore(storage) {
    this.storage = storage || new Storage();
    this.unlocked = {};
    var raw = this.storage.read("achievements", null);
    var self = this;
    if (isDict(raw) && isDict(raw.unlocked)) {
      Object.keys(raw.unlocked).forEach(function (k) {
        if (ACH_BY_ID[k]) self.unlocked[k] = String(raw.unlocked[k]);
      });
    }
  }
  AchievementStore.prototype.save = function () { return this.storage.write("achievements", { unlocked: this.unlocked }); };
  AchievementStore.satisfied = function (ach, metrics) {
    var v = metrics[ach[3]];
    if (v === null || v === undefined) return false;
    return ach[5] === "ge" ? v >= ach[4] : v <= ach[4];
  };
  /** [ratio 0..1, text] */
  AchievementStore.progress = function (ach, metrics) {
    var v = metrics[ach[3]];
    if (v === undefined) v = null;
    var goal = ach[4], text;
    if (ach[3] === "max_survival_ms" || ach[3] === "sprint_best_ms") {
      var fmt = ach[3] === "sprint_best_ms" ? fmtTime : fmtDur;
      var vt = (v !== null && (ach[3] === "sprint_best_ms" || v >= 0)) ? fmt(v) : "-";
      text = vt + " / " + fmt(goal);
    } else {
      text = ach[5] === "ge" ? num(Math.min(v || 0, goal)) + " / " + num(goal) : (v === null ? "None" : v) + " / " + goal;
    }
    if (v === null) return [0.0, text];
    if (ach[5] === "ge") return [Math.max(0, Math.min(1, v / goal)), text];
    return [v <= goal ? 1.0 : Math.max(0, Math.min(1, goal / v)), text];
  };
  AchievementStore.prototype.satisfied = AchievementStore.satisfied;
  AchievementStore.prototype.progress = AchievementStore.progress;
  /** newly unlocked achievements (saved immediately) */
  AchievementStore.prototype.evaluate = function (metrics, date) {
    var nw = [], self = this;
    ACHIEVEMENTS.forEach(function (ach) {
      if (!self.unlocked[ach[0]] && AchievementStore.satisfied(ach, metrics)) {
        self.unlocked[ach[0]] = date || today();
        nw.push(ach);
      }
    });
    if (nw.length) this.save();
    return nw;
  };
  AchievementStore.prototype.count = function () { return Object.keys(this.unlocked).length; };

  NT.Stores = {
    VERSION: "5.4-mobile",
    MAX_RECORDS: MAX_RECORDS, MAX_HISTORY: MAX_HISTORY,
    SPRINT_BEST_KEEP: SPRINT_BEST_KEEP, SPRINT_RECENT_KEEP: SPRINT_RECENT_KEEP,
    STAT_MODES: STAT_MODES, SUM_KEYS: SUM_KEYS, MAX_KEYS: MAX_KEYS,
    ACHIEVEMENTS: ACHIEVEMENTS, ACH_BY_ID: ACH_BY_ID, ADD_METRICS: ADD_METRICS, MAX_METRICS: MAX_METRICS,
    Storage: Storage, ScoreStore: ScoreStore, StatsStore: StatsStore, SprintStore: SprintStore,
    AchievementStore: AchievementStore, emptyModeStats: emptyModeStats,
    metricsFromStats: metricsFromStats, sessionMetrics: sessionMetrics, combineMetrics: combineMetrics,
    fmtDur: fmtDur, fmtTime: fmtTime, today: today, nowStamp: nowStamp, round1: round1, isInt: isInt
  };
})(typeof window !== "undefined" ? window : globalThis);
