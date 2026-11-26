/*
 * NEON TETRIS v5.4-mobile — test_core_v5.4.js
 * Headless checks for core_v5.4.js (run: node test_core_v5.4.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "core_v5.4.js"), "utf8"), ctx, { filename: "core_v5.4.js" });
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

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
