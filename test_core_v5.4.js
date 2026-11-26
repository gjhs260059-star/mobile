/*
 * NEON TETRIS v5.4-mobile — test_core_v5.4.js
 * Headless checks for core_v5.4.js + stores / themes / effects (run: node test_core_v5.4.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ["core_v5.4.js", "stores_v5.4.js", "themes_v5.4.js", "effects_v5.4.js"]) {
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

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
