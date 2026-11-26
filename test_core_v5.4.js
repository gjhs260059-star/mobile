/*
 * NEON TETRIS v5.4-mobile — test_core_v5.4.js
 * Headless checks for core_v5.4.js + stores / themes / effects / replay (run: node test_core_v5.4.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ["core_v5.4.js", "stores_v5.4.js", "themes_v5.4.js", "effects_v5.4.js", "replay_v5.4.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
}
const NT = ctx.NT;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   - " + name); }
  catch (e) { console.log("FAIL - " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; }
}
function emptyBoard() { return Array.from({ length: NT.HEIGHT }, () => Array(NT.WIDTH).fill(0)); }

test("T-spin double detection + score", () => {
  const c = new NT.GameCore(1, true);
  const b = emptyBoard();
  for (let x = 0; x < 10; x++) { if (x !== 4) b[19][x] = 1; if (x < 3 || x > 5) b[18][x] = 2; }
  b[17][3] = 3;                      // overhang -> 3rd corner
  c.board = b;
  c.spawn(5);
  c.rot = 1; c.shape = NT.rotateCW(NT.SHAPES[5]); c.x = 3; c.y = 17;
  assert.ok(!c.collides(c.x, c.y, c.shape), "start position free");
  assert.ok(c.rotate(1), "rotate CW into slot");
  assert.strictEqual(c.rot, 2);
  assert.strictEqual(c.last_kick, 0);
  assert.strictEqual(c.detect_tspin(), 2);
  const info = c.hard_drop();
  assert.deepStrictEqual(Array.from(info.rows), [18, 19]);
  assert.strictEqual(info.tspin, 2);
  const o = c.resolve();
  assert.strictEqual(o.cleared, 2);
  assert.strictEqual(o.gained, 1200);
  assert.ok(o.msgs.includes("T-SPIN DOUBLE"), o.msgs.join(","));
  assert.strictEqual(c.stats.tspin_double, 1);
  assert.strictEqual(o.attack, 4);   // 2 lines * tspin_mult 2
  assert.strictEqual(c.b2b, true);
});

test("T-spin mini (front corner open, not 5th kick)", () => {
  const c = new NT.GameCore(2, true);
  const b = emptyBoard();
  b[19][0] = 1; b[19][2] = 1; b[17][2] = 1;    // 3 corners, front (rot0 top) has one open
  c.board = b;
  c.spawn(5); c.x = 0; c.y = 17; c.last_rotate = true; c.last_kick = 1; c.rot = 0;
  assert.strictEqual(c.detect_tspin(), 1);
  c.last_kick = 4;
  assert.strictEqual(c.detect_tspin(), 2, "5th kick upgrades mini to full");
});

test("SRS I-piece wall kick (0->1 uses kick #2 = +1,0)", () => {
  const c = new NT.GameCore(3, true);
  const b = emptyBoard();
  b[19][8] = 1; b[19][6] = 1;
  c.board = b;
  c.spawn(0); c.x = 6; c.y = 16;
  assert.ok(!c.collides(c.x, c.y, c.shape));
  assert.ok(c.rotate(1));
  assert.strictEqual(c.rot, 1);
  assert.strictEqual(c.last_kick, 2);
  assert.strictEqual(c.x, 7);
  assert.strictEqual(c.y, 16);
});

test("SRS I-piece CCW at left wall", () => {
  const c = new NT.GameCore(3, true);
  c.spawn(0);
  assert.ok(c.rotate(1));             // rot1: column at x+2
  while (c.move(-1, 0));               // to the left wall: column x = 0 -> c.x = -2
  assert.strictEqual(c.x, -2);
  assert.ok(c.rotate(-1));             // 1->0 kicks: (0,0) fails, (2,0) works
  assert.strictEqual(c.rot, 0);
  assert.strictEqual(c.last_kick, 1);
  assert.strictEqual(c.x, 0);
});

test("perfect clear", () => {
  const c = new NT.GameCore(4, true);
  const b = emptyBoard();
  for (let x = 4; x < 10; x++) b[19][x] = 2;
  c.board = b;
  c.spawn(0); c.x = 0;                 // horizontal I, cells x0..3
  const s0 = c.score;
  const info = c.hard_drop();
  const o = c.resolve();
  assert.strictEqual(o.cleared, 1);
  assert.strictEqual(o.pc, true);
  assert.strictEqual(o.gained, 100 + 800);
  assert.ok(o.msgs.includes("PERFECT CLEAR"));
  assert.strictEqual(c.stats.pcs, 1);
  assert.strictEqual(c.score - s0, 900 + 2 * 19);  // I spawns at y=-1, drops 19
  assert.strictEqual(o.attack, 0 + 10);  // single 0 + pc 10
});

test("7-bag determinism with same seed", () => {
  const seq = (seed) => {
    const c = new NT.GameCore(seed, true);
    const out = [c.piece_index];
    for (let i = 0; i < 69; i++) { c.new_piece(); out.push(c.piece_index); }
    return out;
  };
  const a = seq(12345), b = seq(12345), d = seq(54321);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, d);
  for (let i = 0; i < 70; i += 7) {
    assert.deepStrictEqual(a.slice(i, i + 7).sort(), [0, 1, 2, 3, 4, 5, 6], "bag " + i);
  }
  // garbage RNG deterministic too
  const g1 = new NT.GameCore(7, true), g2 = new NT.GameCore(7, true);
  g1.push_garbage(5); g2.push_garbage(5);
  assert.deepStrictEqual(g1.board, g2.board);
});

test("combo / b2b tetris scoring and level", () => {
  const c = new NT.GameCore(5, true);
  const fill4 = () => {
    const b = emptyBoard();
    for (let y = 16; y < 20; y++) for (let x = 1; x < 10; x++) b[y][x] = 1;
    b[15][5] = 1;                    // leftover cell: no perfect clear
    c.board = b;
    c.spawn(0); c.rotate(1); while (c.move(-1, 0));
    return c.resolve(c.hard_drop());
  };
  const o1 = fill4();
  assert.strictEqual(o1.gained, 800);
  const o2 = fill4();
  assert.ok(o2.b2b && o2.msgs.includes("BACK-TO-BACK"));
  assert.strictEqual(o2.gained, 1200 + 50);   // 1.5x + combo 1
  const o3 = fill4();
  assert.ok(o3.leveled);                      // 12 lines -> level 2
  assert.strictEqual(c.current_level(), 2);
});

test("garbage offset / rise", () => {
  const c = new NT.GameCore(6, true);
  c.receive_garbage(3);
  c.hard_drop();
  // no clear -> 3 garbage rows rise
  assert.strictEqual(c.incoming, 0);
  assert.strictEqual(c.board[19].filter(v => v === 8).length, 9);
  assert.strictEqual(c.board[17].filter(v => v === 8).length, 9);
});

test("runner: countdown, gravity, lock delay, DAS", () => {
  const r = new NT.GameRunner({ seed: 9, levelMode: true, mode: "classic" });
  r.start_game(0);
  r.update(2599); assert.ok(r.counting);
  r.update(2600); assert.ok(r.started && !r.counting);
  const y0 = r.core.y;
  r.update(2600 + 500); assert.strictEqual(r.core.y, y0 + 1);
  // DAS: hold left -> immediate move, then after DAS repeats every ARR until wall
  const x0 = r.core.x;
  r.press("k:a", NT.ACT.LEFT, 3200);
  assert.strictEqual(r.core.x, x0 - 1);
  r.update(3200 + 139); assert.strictEqual(r.core.x, x0 - 1);
  r.update(3200 + 140); assert.strictEqual(r.core.x, x0 - 2);
  r.update(3200 + 140 + 35 * 10);
  r.release("k:a", 3700);
  assert.ok(r.core.collides(r.core.x - 1, r.core.y, r.core.shape), "at wall");
  // drop to floor, then lock after 500ms
  const pieces = r.core.stats.pieces.reduce((a, b) => a + b, 0);
  while (r.core.move(0, 1));
  r.after_move();
  r.update(3700 + 499);
  assert.strictEqual(r.core.stats.pieces.reduce((a, b) => a + b, 0), pieces);
  r.update(3700 + 500);
  assert.strictEqual(r.core.stats.pieces.reduce((a, b) => a + b, 0), pieces + 1);
});

test("sanitizers", () => {
  const r = NT.sanitizeRules({ attack: [99, -3, 2.7, "x"], tspin_mult: 9, b2b: true, combo_pct: 50 });
  assert.deepStrictEqual(Array.from(r.attack), [20, 0, 2, 4]);
  assert.strictEqual(r.tspin_mult, 6);
  assert.strictEqual(r.b2b, 1);
  assert.strictEqual(r.combo_pct, 50);
  const l = NT.sanitizeLimits({ bob: { no_hold: 1, junk: true }, eve: {} });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(l)), { bob: { no_hold: true } });
  assert.strictEqual(NT.pyRound(0.5), 0);
  assert.strictEqual(NT.pyRound(1.5), 2);
  assert.strictEqual(NT.pyRound(2.5), 2);
});

// ---------------- stage 2: stores / themes / effects ----------------
const St = NT.Stores;
function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), map: m };
}
const plainJSON = o => JSON.parse(JSON.stringify(o));

test("sprint records: best sorted fast->slow (TOP 10), recent newest first, first/broken", () => {
  const ls = memStorage();
  const sp = new St.SprintStore(new St.Storage("nt54_", ls));
  assert.strictEqual(sp.best_ms(), null);
  assert.strictEqual(sp.add({ time_ms: 90000, date: "a" }), "first");
  assert.strictEqual(sp.add({ time_ms: 95000, date: "b" }), null);
  assert.strictEqual(sp.add({ time_ms: 80000, date: "c" }), "broken");
  assert.strictEqual(sp.add({ time_ms: 80000, date: "d" }), null);     // tie is not a new record
  assert.deepStrictEqual(Array.from(sp.best.map(e => e.time_ms)), [80000, 80000, 90000, 95000]);
  assert.deepStrictEqual(Array.from(sp.best.slice(0, 2).map(e => e.date)), ["c", "d"]);  // stable
  assert.deepStrictEqual(Array.from(sp.recent.map(e => e.date)), ["d", "c", "b", "a"]);
  for (let i = 0; i < 30; i++) sp.add({ time_ms: 100000 + i, date: "x" + i });
  assert.strictEqual(sp.best.length, 10);
  assert.strictEqual(sp.recent.length, 20);
  // reload + sanitize: junk entries dropped, best re-sorted
  ls.setItem("nt54_sprint_records", JSON.stringify({
    best: [{ time_ms: 5000 }, "junk", { time_ms: -1 }, { time_ms: 3000 }, { time_ms: 1.5 }, { time_ms: true }],
    recent: [{ time_ms: 7 }, null] }));
  const sp2 = new St.SprintStore(new St.Storage("nt54_", ls));
  assert.deepStrictEqual(Array.from(sp2.best.map(e => e.time_ms)), [3000, 5000]);
  assert.deepStrictEqual(Array.from(sp2.recent.map(e => e.time_ms)), [7]);
});

test("stats: sanitize loaded data like StatsStore.load", () => {
  const ls = memStorage({ nt54_statistics: JSON.stringify({
    modes: { classic: { games: 3, lines: "9", best_score: 12.5, pieces: [1, 2, 3], best_time_ms: 0, max_combo: 4, junk: 1 },
             sprint: { best_time_ms: 61000, pieces: [1, 1, 1, 1, 1, 1, 1], finished: true },
             multi: "bad" },
    history: [{ mode: "classic" }, 5, null, { mode: "sprint" }] }) });
  const s = new St.StatsStore(new St.Storage("nt54_", ls));
  const c = s.totals("classic");
  assert.strictEqual(c.games, 3);
  assert.strictEqual(c.lines, 0);            // string rejected
  assert.strictEqual(c.best_score, 0);       // float rejected
  assert.deepStrictEqual(Array.from(c.pieces), [0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(c.best_time_ms, null);  // must be > 0
  assert.strictEqual(c.max_combo, 4);
  assert.ok(!("junk" in c));
  const sp = s.totals("sprint");
  assert.strictEqual(sp.best_time_ms, 61000);
  assert.strictEqual(sp.finished, 0);        // bool rejected
  assert.strictEqual(s.totals("multi").games, 0);
  assert.strictEqual(s.data.history.length, 2);
  // corrupt JSON -> defaults, raw kept as .corrupt
  const bad = memStorage({ nt54_statistics: "{oops" });
  const s2 = new St.StatsStore(new St.Storage("nt54_", bad));
  assert.strictEqual(s2.totals("classic").games, 0);
  assert.strictEqual(bad.getItem("nt54_statistics.corrupt"), "{oops");
});

test("stats: add_game per mode + history cap", () => {
  const s = new St.StatsStore(new St.Storage("nt54_", memStorage()));
  const st = NT.newStats(); st.tetrises = 2; st.max_combo = 5; st.pieces = [1, 0, 0, 0, 0, 0, 2];
  s.add_game({ mode: "sprint", outcome: "cleared", date: "d", time_ms: 70000, score: 100, lines: 40,
               apm: 61.25, ppm: 34.29, stats: st, record: "first" });
  s.add_game({ mode: "sprint", outcome: "cleared", date: "d", time_ms: 65000, score: 90, lines: 40,
               apm: 60, ppm: 30, stats: st, record: "broken" });
  s.add_game({ mode: "classic", outcome: "aborted", date: "d", time_ms: 1000, score: 5, lines: 0,
               apm: 0, ppm: 0, stats: NT.newStats() });
  const t = s.totals("sprint");
  assert.strictEqual(t.games, 2); assert.strictEqual(t.finished, 2);
  assert.strictEqual(t.best_time_ms, 65000); assert.strictEqual(t.records_broken, 1);
  assert.strictEqual(t.tetrises, 4); assert.strictEqual(t.max_combo, 5);
  assert.deepStrictEqual(Array.from(t.pieces), [2, 0, 0, 0, 0, 0, 4]);
  assert.strictEqual(s.totals("classic").aborted, 1);
  assert.strictEqual(s.data.history[0].apm, 61.3);
  for (let i = 0; i < 120; i++) s.add_game({ mode: "classic", outcome: "gameover", date: "d", time_ms: 1, score: 1, lines: 0, apm: 0, ppm: 0, stats: NT.newStats() });
  assert.strictEqual(s.data.history.length, 100);
});

test("achievements: unlock conditions + progress", () => {
  const ls = memStorage({ nt54_achievements: JSON.stringify({ unlocked: { first_line: "2026-01-01", bogus: "x" } }) });
  const a = new St.AchievementStore(new St.Storage("nt54_", ls));
  assert.deepStrictEqual(Array.from(Object.keys(a.unlocked)), ["first_line"]);
  const s = new St.StatsStore(new St.Storage("nt54_", memStorage()));
  let m = St.metricsFromStats(s);
  assert.strictEqual(m.sprint_best_ms, null);
  assert.strictEqual(a.evaluate(m).length, 0);
  // sprint 59 s -> 스프린터, 2분의 벽, 1분의 벽 (not 초인 40 s); le-goal with None is never satisfied
  s.add_game({ mode: "sprint", outcome: "cleared", date: "d", time_ms: 59000, score: 0, lines: 40, apm: 0, ppm: 0, stats: NT.newStats() });
  m = St.metricsFromStats(s);
  const ids = a.evaluate(m, "2026-02-02").map(x => x[0]).sort().slice();
  assert.deepStrictEqual(Array.from(ids), ["sprint_120", "sprint_60", "sprint_finish"]);
  assert.strictEqual(a.unlocked.sprint_60, "2026-02-02");
  assert.ok(JSON.parse(ls.getItem("nt54_achievements")).unlocked.sprint_finish);
  assert.strictEqual(a.evaluate(m).length, 0);                 // only once
  // session metrics combine: 10 combo + T-spin mini in the current game
  const core = new NT.GameCore(1, true);
  core.stats.max_combo = 10; core.stats.tspin_mini = 1; core.score = 50000; core.lines = 3;
  const cm = St.combineMetrics(m, St.sessionMetrics(core, "classic", 301000));
  const got = a.evaluate(cm).map(x => x[0]).sort().slice();
  assert.deepStrictEqual(Array.from(got), ["combo_10", "first_tspin", "score_50k", "survive_5m"]);
  // sprint mode session does not count score / survival
  const sm = St.sessionMetrics(core, "sprint", 999999);
  assert.strictEqual(sm.best_score, 0); assert.strictEqual(sm.max_survival_ms, 0);
  // progress text / ratio
  const A = St.ACH_BY_ID;
  assert.deepStrictEqual(Array.from(St.AchievementStore.progress(A.lines_1000, { lines_total: 1234 })), [1, "1,000 / 1,000"]);
  assert.deepStrictEqual(Array.from(St.AchievementStore.progress(A.sprint_40, { sprint_best_ms: 80000 })), [0.5, "1:20.00 / 0:40.00"]);
  assert.deepStrictEqual(Array.from(St.AchievementStore.progress(A.sprint_40, { sprint_best_ms: null })), [0, "- / 0:40.00"]);
  assert.deepStrictEqual(Array.from(St.AchievementStore.progress(A.survive_5m, { max_survival_ms: 150000 })), [0.5, "2분 30초 / 5분 0초"]);
  assert.strictEqual(St.ACHIEVEMENTS.length, 28);
});

test("TOP 5 high scores: legacy format, rank, cap", () => {
  const ls = memStorage({ nt54_highscore: JSON.stringify({ high_score: 777 }) });
  const sc = new St.ScoreStore(new St.Storage("nt54_", ls));
  assert.deepStrictEqual(plainJSON(sc.scores), [{ score: 777, date: "" }]);
  assert.strictEqual(sc.add(500, "d1"), 1);
  assert.strictEqual(sc.add(900, "d2"), 0);
  [100, 200, 300].forEach(v => sc.add(v, "x"));
  assert.strictEqual(sc.scores.length, 5);
  assert.strictEqual(sc.add(50, "x"), null);                     // fell out of TOP 5
  assert.deepStrictEqual(Array.from(sc.scores.map(e => e.score)), [900, 777, 500, 300, 200]);
  assert.strictEqual(JSON.parse(ls.getItem("nt54_highscore")).high_score, 900);
});

test("themes: sanitize_custom / build_theme / norm_color", () => {
  const Th = NT.Themes;
  assert.strictEqual(Th.THEME_ORDER.length, 6);
  assert.strictEqual(Th.normColor("#abcdef"), "#ABCDEF");
  assert.strictEqual(Th.normColor("#xyz123", "#111111"), "#111111");
  const c = Th.sanitizeCustom({ base: "파스텔", colors: ["#000000", "bad", 3, "#ffffff", "#123456", "#654321", "#00ff00"] });
  assert.strictEqual(c.base, "파스텔");
  assert.deepStrictEqual(Array.from(c.colors), ["#000000", "#A9B7F5", "#F7C6A3", "#FFFFFF", "#123456", "#654321", "#00FF00"]);
  assert.strictEqual(Th.sanitizeCustom({ base: "없음", colors: [1] }).base, "네온 사이버펑크");
  const th = Th.buildTheme("커스텀", c);
  assert.strictEqual(th.style, "pastel");
  assert.strictEqual(th.COLORS[0], "#000000");
  assert.strictEqual(Th.THEMES["파스텔"].COLORS[0], "#9ADCF5");    // base not mutated
  assert.strictEqual(Th.buildTheme("???").C_BG, "#0F1016");
  assert.strictEqual(Th.mix("#000000", "#FFFFFF", 0.5), "#7f7f7f");
});

test("effects: particle cap + outcome effects + toast lifetime", () => {
  const fx = new NT.EffectsManager();
  const th = NT.Themes.buildTheme("네온 사이버펑크");
  fx.on_outcome({ cleared: 4, rows: [16, 17, 18, 19], tspin: 0, b2b: true, combo: 12, pc: true }, 30, th);
  assert.ok(fx.particles.length <= NT.Effects.MAX_PARTICLES);
  assert.ok(fx.texts.length <= 6);
  assert.ok(fx.texts.some(t => t.text === "PERFECT CLEAR"));
  assert.ok(fx.flash > 0 && fx.rings.length > 0);
  fx.toast("첫 발자국", "처음으로 줄을 삭제한다");
  for (let i = 0; i < 25; i++) fx.tick(0.1);
  assert.ok(fx.toast_cur !== null && fx.toast_cur[0] === "첫 발자국");
  for (let i = 0; i < 25; i++) fx.tick(0.1);
  assert.ok(!fx.active());
  fx.particles_on = false; fx.combo_on = false;
  fx.on_outcome({ cleared: 2, rows: [18, 19], tspin: 2, b2b: false, combo: 1, pc: false }, 30, th);
  assert.strictEqual(fx.particles.length, 0);
  assert.strictEqual(fx.texts.length, 0);
});

// ---------------------------------------------------------------- replay (stage 3)
const R = NT.Replay;
function lsMem(limitChars) {
  const m = new Map();
  const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
  return {
    map: m,
    get length() { return m.size; },
    key: i => Array.from(m.keys())[i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      v = String(v);
      if (limitChars && used() - (m.has(k) ? k.length + m.get(k).length : 0) + k.length + v.length > limitChars) {
        const e = new Error("quota"); e.name = "QuotaExceededError"; e.code = 22; throw e;
      }
      m.set(k, v);
    },
    removeItem: k => m.delete(k)
  };
}
function mulberry(seed) {
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// simple placement bot (aggregate height / holes / bumpiness / lines)
function bestPlacement(core) {
  let best = null;
  let shape = NT.SHAPES[core.piece_index].map(r => r.slice());
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -3; x < NT.WIDTH + 1; x++) {
      let y = core.piece_index === 0 ? -1 : 0;
      if (core.collides(x, y, shape)) continue;
      while (!core.collides(x, y + 1, shape)) y++;
      const b = core.board.map(r => r.slice());
      let out = false;
      shape.forEach((row, r) => row.forEach((v, c) => { if (v) { if (y + r < 0) out = true; else b[y + r][x + c] = 1; } }));
      if (out) continue;
      const kept = b.filter(row => !row.every(Boolean));
      const lines = NT.HEIGHT - kept.length;
      while (kept.length < NT.HEIGHT) kept.unshift(Array(NT.WIDTH).fill(0));
      const hs = [], holes = [0];
      for (let c = 0; c < NT.WIDTH; c++) {
        let h = 0, seen = false;
        for (let r = 0; r < NT.HEIGHT; r++) {
          if (kept[r][c]) { if (!seen) { h = NT.HEIGHT - r; seen = true; } } else if (seen) holes[0]++;
        }
        hs.push(h);
      }
      let bump = 0; for (let c = 0; c < NT.WIDTH - 1; c++) bump += Math.abs(hs[c] - hs[c + 1]);
      const score = -0.51 * hs.reduce((a, v) => a + v, 0) + 0.76 * lines - 0.36 * holes[0] - 0.18 * bump;
      if (!best || score > best.score) best = { rot, x, score };
    }
    shape = NT.rotateCW(shape);
  }
  return best;
}

/** play a game with the bot through GameRunner (real timers, DAS presses, soft drops, lock delay,
 *  holds, pause + level toggle, optional garbage) and record it exactly like the UI does */
function botGame(opts) {
  const rnd = mulberry(opts.rseed || 1);
  const r = new NT.GameRunner({ mode: opts.mode, seed: opts.seed, levelMode: opts.levelMode !== false,
                                rules: opts.rules, limits: opts.limits, sprintTarget: opts.sprintTarget, now: 0 });
  const rec = R.ReplayRecorder.forRunner(r);
  r.on("record", (ms, code) => { if (!r.game_over && !r.finished) rec.add(ms, code); });
  let t = 0;
  r.start_game(t);
  let plan = null, planKey = -1, pieces = 0, toggled = 0, garb = 0, holds = 0;
  const maxPieces = opts.pieces || 120;
  while (!r.game_over && !r.finished && t < 3600000) {
    t += 15 + Math.floor(rnd() * 120);
    r.update(t);
    if (opts.garbage && rnd() < opts.garbage) {        // garbage at random times, incl. during the clear flash
      const n = 1 + Math.floor(rnd() * 3); r.receive_garbage(n); garb += n;
    }
    if (opts.toggleLevel && r.started && !r.paused && !r.counting && rnd() < 0.004 && r.mode === "classic") {
      r.pause(t); r.setLevelMode(!r.level_mode); toggled++;
      t += 200; r.update(t); r.start_game(t);          // resume -> countdown
      continue;
    }
    if (!r.can_act()) continue;
    const core = r.core;
    const key = core.stats.pieces.reduce((a, b) => a + b, 0) * 10 + (core.hold_used ? 1 : 0) + holds * 1000;
    if (key !== planKey) {
      planKey = key;
      pieces = core.stats.pieces.reduce((a, b) => a + b, 0);
      if (pieces >= maxPieces) { plan = { dumb: true }; }
      else if (!opts.limits?.no_hold && !core.hold_used && rnd() < 0.06) { r.action(NT.ACT.HOLD, t); holds++; continue; }
      else { plan = bestPlacement(core) || { dumb: true }; plan.lockWait = rnd() < 0.3; }
    }
    if (plan.dumb) { r.action(NT.ACT.HARD, t); continue; }
    if (core.rot !== plan.rot) { if (!r.action(rnd() < 0.8 ? NT.ACT.CW : NT.ACT.CCW, t)) r.action(NT.ACT.HARD, t); continue; }
    if (core.x !== plan.x) {
      const act = core.x < plan.x ? NT.ACT.RIGHT : NT.ACT.LEFT;
      if (Math.abs(core.x - plan.x) > 2 && rnd() < 0.5) {     // DAS hold
        r.press("k:b", act, t);
        let guard = 0;
        while (r.core.active && r.core.x !== plan.x && guard++ < 40) { t += 5; r.update(t); }
        r.release("k:b", t);
      } else if (!r.action(act, t)) r.action(NT.ACT.HARD, t);
      continue;
    }
    const u = rnd();
    if (plan.lockWait) { if (u < 0.3) r.action(NT.ACT.SOFT, t); }   // let gravity + lock delay lock it
    else if (u < 0.6) r.action(NT.ACT.HARD, t);
    else if (u < 0.8) r.action(NT.ACT.SOFT, t);              // soft drops -> gravity / lock delay lock
    // else: wait (gravity + lock timer)
    if (opts.abortAt && pieces >= opts.abortAt && !r.animating) break;
  }
  return { r, rec, t, toggled, garb, holds };
}

function snapshot(core) {
  const st = Object.assign({}, core.stats); delete st.actions; st.pieces = Array.from(st.pieces);
  return JSON.parse(JSON.stringify({
    board: core.board, score: core.score, lines: core.lines, combo: core.combo, b2b: core.b2b,
    b2b_streak: core.b2b_streak, hold: core.hold_index, hold_used: core.hold_used, queue: core.queue,
    active: core.active, pi: core.piece_index, x: core.x, y: core.y, rot: core.rot, inc: core.incoming,
    over: core.game_over, fin: core.finished, lvl: core.current_level(), st
  }));
}

/** save through ReplayStore (compressed in "localStorage"), load, replay to the end */
function roundTrip(g, outcome) {
  const ls = lsMem();
  const store = new R.ReplayStore(ls, "nt54_");
  g.r.clock.stop();
  const timeMs = g.r.ms();
  const meta = { date: "2026-11-26 10:00:00", outcome, score: g.r.core.score, lines: g.r.core.lines,
                 time_ms: timeMs, duration_ms: timeMs + NT.CLEAR_TOTAL_MS, apm: 0 };
  const name = store.save(g.rec, meta, [], new Date(2026, 10, 26, 10, 0, 0));
  assert.ok(name, "saved: " + store.lastError);
  assert.ok(/^20261126_100000_\w+\.rpl$/.test(name), name);
  const raw = ls.getItem("nt54_rpl_" + name);
  const data = store.load(name);
  assert.deepStrictEqual(Array.from(data.ev), Array.from(g.rec.events), "events survive compression");
  const p = new R.ReplayPlayer(data);
  p.advance_to(p.duration);
  assert.ok(p.ended, "player ended");
  return { p, raw, data, store, name };
}

test("replay codec: varint + LZW round trip (incl. dictionary cap, big values)", () => {
  const rnd = mulberry(9);
  for (const n of [0, 1, 2, 100, 5000, 200000]) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(rnd() < 0.5 ? 500 * 16 + 7 : Math.floor(rnd() * (rnd() < 0.01 ? 1e9 : 3000)) * 16 + (i % 13));
    const z = R.compressEvents(a);
    assert.deepStrictEqual(Array.from(R.decompressEvents(z.z, z.n)), a, "n=" + n);
    for (let i = 0; i < z.z.length; i++) { const c = z.z.charCodeAt(i); assert.ok(c >= 32 && c < 32800); }
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.decodeEvents([16 * 100 + 7, 5, 16 * 3 + 8]))), [[100, 7], [100, 5], [103, 8]]);
});

test("replay: scripted classic game (level mode, DAS, soft drop, lock delay, hold, pause + level toggle) replays identically", () => {
  const g = botGame({ mode: "classic", seed: 12345, rseed: 7, pieces: 140, toggleLevel: true });
  assert.ok(g.r.game_over, "bot game ends in a game over");
  assert.ok(g.r.core.lines >= 20, "lines " + g.r.core.lines);
  assert.ok(g.holds > 0, "used hold");
  const codes = new Set(g.rec.events.map(v => v % 16));
  [0, 1, 2, 3, 5, 6, 7, 8].forEach(c => assert.ok(codes.has(c), "has event code " + c));
  const { p, raw } = roundTrip(g, "gameover");
  assert.deepStrictEqual(snapshot(p.core), snapshot(g.r.core));
  assert.ok(raw.length < JSON.stringify(g.rec.events).length / 2, `compressed ${raw.length} vs ${JSON.stringify(g.rec.events).length}`);
});

test("replay: level-mode toggles mid-game are recorded (LVL_ON / LVL_OFF)", () => {
  let g = null;
  for (let s = 1; s < 40 && !(g && g.toggled); s++) g = botGame({ mode: "classic", seed: 900 + s, rseed: s, pieces: 160, toggleLevel: true });
  assert.ok(g.toggled > 0);
  const codes = new Set(g.rec.events.map(v => v % 16));
  assert.ok(codes.has(NT.EV.LVL_ON) || codes.has(NT.EV.LVL_OFF));
  const { p } = roundTrip(g, "gameover");
  assert.deepStrictEqual(snapshot(p.core), snapshot(g.r.core));
});

test("replay: sprint 40 lines (clock stops on the final clear) replays to SPRINT CLEAR", () => {
  const g = botGame({ mode: "sprint", seed: 4242, rseed: 3, pieces: 100000 });
  assert.ok(g.r.finished, "sprint cleared");
  const { p } = roundTrip(g, "cleared");
  assert.ok(p.core.finished);
  assert.ok(p.core.lines >= 40);
  assert.deepStrictEqual(snapshot(p.core), snapshot(g.r.core));
});

test("replay: aborted classic game (stopped mid-play, no level mode)", () => {
  const g = botGame({ mode: "classic", seed: 77, rseed: 11, pieces: 1000, abortAt: 60, levelMode: false });
  assert.ok(!g.r.game_over);
  const { p } = roundTrip(g, "aborted");
  assert.deepStrictEqual(snapshot(p.core), snapshot(g.r.core));
});

test("replay: multiplayer game with garbage (also during the clear flash), rules + limits", () => {
  const rules = { attack: [1, 2, 4, 8], tspin_mult: 3, b2b: 2, combo_pct: 150, pc: 15, max_garbage: 3 };
  const g = botGame({ mode: "multi", seed: 31337, rseed: 5, pieces: 400, garbage: 0.02, rules, limits: { no_hold: true } });
  assert.ok(g.garb > 10, "garbage received " + g.garb);
  const codes = new Set(g.rec.events.map(v => v % 16));
  assert.ok(codes.has(NT.EV.GARB), "GARB recorded");
  assert.ok(!codes.has(NT.EV.HOLD), "no_hold respected");
  const { p, data } = roundTrip(g, "gameover");
  assert.deepStrictEqual(plainJSON(data.rules), plainJSON(g.r.core.rules));
  assert.strictEqual(p.core.rules.max_garbage, 3);
  assert.deepStrictEqual(snapshot(p.core), snapshot(g.r.core));
  // garbage during a line-clear animation must be applied before the resolve
  let hit = false;
  for (let s = 1; s < 30 && !hit; s++) {
    const g2 = botGame({ mode: "multi", seed: 500 + s, rseed: s, pieces: 200, garbage: 0.15, rules });
    hit = g2.rec.events.some(v => v % 16 === NT.EV.GARB_AWAIT);
    if (hit) assert.deepStrictEqual(snapshot(roundTrip(g2, "gameover").p.core), snapshot(g2.r.core));
  }
  assert.ok(hit, "GARB_AWAIT exercised");
});

test("replay: seek (re-simulate from start) == straight playback; anim() steps", () => {
  const g = botGame({ mode: "classic", seed: 2024, rseed: 2, pieces: 50 });
  const { data } = roundTrip(g, "gameover");
  const a = new R.ReplayPlayer(data), b = new R.ReplayPlayer(data);
  const mid = Math.floor(a.duration / 2);
  for (let t = 0; t <= mid; t += 33) a.advance_to(t);
  a.advance_to(mid);
  b.seek(mid);
  assert.deepStrictEqual(snapshot(a.core), snapshot(b.core));
  // find a clear and check the flash steps 1..6
  const c = new R.ReplayPlayer(data);
  let found = false;
  for (let t = 0; t < c.duration && !found; t += 5) {
    c.advance_to(t);
    if (c.pending) {
      found = true;
      const t0 = c.pending[1] - NT.CLEAR_TOTAL_MS;
      c.advance_to(t0); assert.strictEqual(c.anim()[1], 1);
      c.advance_to(t0 + 5 * NT.CLEAR_FRAME_MS); assert.strictEqual(c.anim()[1], 6);
      c.advance_to(t0 + NT.CLEAR_TOTAL_MS); assert.strictEqual(c.anim(), null);
    }
  }
  assert.ok(found);
  // next_lock_time walks piece by piece
  const d = new R.ReplayPlayer(data);
  const t1 = d.next_lock_time(); d.advance_to(t1);
  assert.strictEqual(d.core.stats.pieces.reduce((x, y) => x + y, 0), 1);
});

test("replay store: MAX_REPLAYS pruning (oldest first, protected kept), listing newest first, corrupt skipped, delete", () => {
  const ls = lsMem();
  const store = new R.ReplayStore(ls, "nt54_");
  const rec = new R.ReplayRecorder(1, "classic", true, 0);
  rec.add(100, 7); rec.add(600, 5);
  const names = [];
  for (let i = 0; i < 35; i++) {
    const n = store.save(rec, { date: "d" + i, score: i, outcome: "gameover", duration_ms: 1000 },
                         i > 0 ? [names[0]] : [], new Date(2026, 0, 1, 0, 0, i));
    names.push(n);
  }
  assert.strictEqual(new Set(names).size, 35);
  const files = store.files();
  assert.strictEqual(files.length, R.MAX_REPLAYS);
  assert.ok(files.includes(names[0]), "protected (sprint best) replay kept");
  assert.ok(!files.includes(names[1]) && files.includes(names[34]));
  ls.setItem("nt54_rpl_20990101_000000_classic.rpl", "{broken");
  const lst = store.listing();
  assert.strictEqual(lst.length, R.MAX_REPLAYS);
  assert.strictEqual(lst[0][0], names[34]);
  assert.strictEqual(lst[0][1].score, 34);
  assert.strictEqual(lst[0][1].evz, undefined);
  assert.strictEqual(store.load("20990101_000000_classic.rpl"), null);
  assert.strictEqual(store.load("nope.rpl"), null);
  assert.ok(store.delete(names[34]));
  assert.ok(!store.delete(names[34]));
  // same second -> _2 suffix (like tetris.py)
  const s2 = new R.ReplayStore(lsMem(), "nt54_");
  const d = new Date(2026, 4, 5, 6, 7, 8);
  assert.strictEqual(s2.save(rec, {}, [], d), "20260505_060708_classic.rpl");
  assert.strictEqual(s2.save(rec, {}, [], d), "20260505_060708_classic_2.rpl");
  // event cap
  const big = new R.ReplayRecorder(1, "classic", true, 0);
  for (let i = 0; i < R.MAX_REPLAY_EVENTS + 5; i++) big.add(i, 7);
  assert.strictEqual(big.events.length, R.MAX_REPLAY_EVENTS);
  assert.ok(big.truncated);
  assert.strictEqual(R.replayTitle({ date: "2026-11-26 10:11:12", mode: "sprint", outcome: "cleared", time_ms: 61230, duration_ms: 61560 }),
                     "2026-11-26 10:11   스프린트   완주 1:01.23   [1분 1초]");
  assert.strictEqual(R.replayTitle({ date: "2026-11-26 10:11:12", mode: "classic", outcome: "aborted", score: 12345, lines: 7, duration_ms: 5000 }),
                     "2026-11-26 10:11   일반   12,345점 · 7줄 (중단)   [5초]");
});

test("replay store: QuotaExceeded -> evict oldest unprotected and retry, else null (game goes on)", () => {
  const rnd = mulberry(4);
  const rec = new R.ReplayRecorder(1, "classic", true, 0);
  for (let i = 0; i < 3000; i++) rec.add(i * 100 + Math.floor(rnd() * 99), Math.floor(rnd() * 9));
  const one = JSON.stringify({ x: R.compressEvents(rec.events).z }).length;
  const ls = lsMem(one * 3.5);
  const store = new R.ReplayStore(ls, "nt54_");
  const names = [];
  for (let i = 0; i < 6; i++) names.push(store.save(rec, {}, [], new Date(2026, 0, 1, 0, 0, i)));
  assert.ok(names.every(Boolean), "every save succeeded by evicting: " + names);
  assert.ok(store.files().length <= 3 && store.files().includes(names[5]));
  // everything protected -> no room -> null, previous replays untouched
  const before = store.files();
  assert.strictEqual(store.save(rec, {}, before, new Date(2026, 0, 2)), null);
  assert.strictEqual(store.lastError, "quota");
  assert.deepStrictEqual(store.files(), before);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
