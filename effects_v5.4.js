/*
 * NEON TETRIS v5.4-mobile — effects_v5.4.js
 * ---------------------------------------------------------------
 * Port of tetris.py (v5.3) EffectsManager: line-clear particles, combo banners,
 * TETRIS / T-SPIN / PERFECT CLEAR / NEW RECORD effects, border flash, rings and
 * the achievement toast. Separate from game logic; drawn on its own overlay canvas.
 * Units: board pixels. Speeds in tetris.py are px/s for a 30px cell, so they are
 * scaled by cell/30 to look the same at any phone cell size.
 * Particles are capped at MAX_PARTICLES (160, as tetris.py). The UI ticks/draws it
 * from requestAnimationFrame only while active() is true.
 * Exposed as window.NT.EffectsManager.
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});
  var W = 10, H = 20, BASE_CELL = 30;
  var RAINBOW = ["#FF2E63", "#FF9100", "#FFEA00", "#39FF14", "#00F5FF", "#4D7CFF", "#BF5FFF"];
  var MAX_PARTICLES = 160;

  function uni(a, b) { return a + Math.random() * (b - a); }
  function choice(a) { return a[Math.floor(Math.random() * a.length)]; }
  function mix(c1, c2, t) {
    if (NT.Themes) return NT.Themes.mix(c1, c2, t);
    var a = c1.replace("#", ""), b = c2.replace("#", ""), out = "#";
    for (var i = 0; i < 6; i += 2) {
      var v = Math.trunc(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t);
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return out;
  }

  function EffectsManager() {
    this.particles_on = true;
    this.combo_on = true;
    this.perfect_on = true;
    this.particles = [];     // [x, y, vx, vy, life, max_life, color, size, gravity]
    this.texts = [];
    this.rings = [];         // [cx, cy, r, vr, life, max_life, color, width]
    this.toasts = [];
    this.toast_cur = null;   // [text, sub, age]
    this.flash = 0;
    this.flash_color = "#FFFFFF";
  }
  var EP = EffectsManager.prototype;

  EP.clear = function () {
    this.particles.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
    this.toasts.length = 0;
    this.toast_cur = null;
    this.flash = 0;
  };

  EP.active = function () {
    return !!(this.particles.length || this.texts.length || this.rings.length || this.toast_cur ||
              this.toasts.length || this.flash > 0);
  };

  // ---------------- creation ----------------
  EP._add_particle = function (x, y, vx, vy, life, color, size, gravity) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push([x, y, vx, vy, life, life, color, size, gravity || 0]);
  };

  EP.burst_rows = function (rows, cell, th, perRow) {
    if (!this.particles_on) return;
    perRow = perRow || 12;
    var k = cell / BASE_CELL, colors = th.COLORS;
    for (var i = 0; i < rows.length; i++) {
      for (var n = 0; n < perRow; n++) {
        this._add_particle(uni(0, W * cell), (rows[i] + 0.5) * cell,
                           uni(-160, 160) * k, uni(-220, 60) * k,
                           uni(0.45, 0.85), choice(colors), uni(2, 4.5) * k, 520 * k);
      }
    }
  };

  EP.burst_center = function (cell, n, colors, speed, life, gravity) {
    if (speed === undefined) speed = 420;
    if (life === undefined) life = 1.0;
    if (gravity === undefined) gravity = 300;
    var k = cell / BASE_CELL, cx = W * cell / 2, cy = H * cell / 2;
    for (var i = 0; i < n; i++) {
      var a = uni(0, 2 * Math.PI), sp = uni(speed * 0.3, speed) * k;
      this._add_particle(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
                         uni(life * 0.6, life), choice(colors), uni(2.5, 5.5) * k, gravity * k);
    }
  };

  EP.banner = function (text, color, size, dur, yFrac, pulse, rainbow) {
    this.texts.push({ text: text, color: color, size: size, dur: dur, age: 0,
                      y: yFrac === undefined ? 0.32 : yFrac,
                      pulse: pulse === undefined ? true : pulse, rainbow: !!rainbow });
    if (this.texts.length > 6) this.texts.shift();
  };

  EP.toast = function (text, sub) { this.toasts.push([text, sub || ""]); };

  EP.combo = function (n, cell, th) {
    if (!this.combo_on) return;
    var size = cell * (0.75 + 0.07 * Math.min(n, 14)), color, rainbow = false;
    if (n < 3) color = th.C_TEXT;
    else if (n < 6) color = th.C_CYAN;
    else if (n < 10) color = th.C_PINK;
    else { color = "#FFEA00"; rainbow = true; }
    this.banner(n + " COMBO", color, size, 0.8 + Math.min(n, 12) * 0.03, 0.40, true, rainbow);
    if (n >= 5 && this.particles_on) {
      this.burst_center(cell, Math.min(60, 8 + n * 3), n >= 10 ? RAINBOW : th.COLORS, 260 + n * 15, 0.8);
    }
  };

  EP.tetris = function (cell, th) {
    var k = cell / BASE_CELL;
    this.banner("TETRIS!", "#FFFFFF", cell * 1.5, 1.2, 0.28, true, true);
    this.flash = 0.45;
    this.flash_color = th.C_CYAN;
    if (this.particles_on) {
      this.burst_center(cell, 70, RAINBOW, 520, 1.0);
      this.rings.push([W * cell / 2, H * cell / 2, 10 * k, 520 * k, 0.7, 0.7, th.C_CYAN, 4 * k]);
    }
  };

  EP.tspin = function (text, cell, th) {
    this.banner(text, th.C_CYAN, cell * 0.9, 1.0, 0.22);
    this.flash = 0.3;
    this.flash_color = th.C_PINK;
    if (this.particles_on) this.burst_center(cell, 30, [th.C_CYAN, th.C_PINK, "#FFFFFF"], 360, 0.7);
  };

  EP.perfect = function (cell, th) {
    if (!this.perfect_on) return;
    var k = cell / BASE_CELL, w = W * cell, h = H * cell;
    this.banner("PERFECT CLEAR", "#FFFFFF", cell * 1.15, 2.4, 0.45, true, true);
    this.flash = 0.8;
    this.flash_color = "#FFEA00";
    for (var i = 0; i < 4; i++) {
      this.rings.push([w / 2, h / 2, 5 * k, (420 + i * 120) * k, 1.4 + i * 0.2, 1.4 + i * 0.2,
                       RAINBOW[(i * 2) % 7], 5 * k]);
    }
    if (this.particles_on) {
      for (var n = 0; n < 70; n++) {
        this._add_particle(uni(0, w), uni(-h * 0.3, 0), uni(-40, 40) * k, uni(60, 220) * k,
                           uni(1.6, 2.6), choice(RAINBOW), uni(3, 6) * k, 90 * k);
      }
      this.burst_center(cell, 60, RAINBOW, 600, 1.4);
    }
  };

  EP.record = function (cell, th) {
    var k = cell / BASE_CELL, w = W * cell, h = H * cell;
    this.banner("NEW RECORD!", "#FFEA00", cell * 1.2, 3.2, 0.36, true, true);
    this.flash = 1.0;
    this.flash_color = "#FFEA00";
    this.rings.push([w / 2, h / 2, 5 * k, 380 * k, 1.6, 1.6, "#FFEA00", 5 * k]);
    for (var n = 0; n < 90; n++) {
      this._add_particle(uni(0, w), uni(-h * 0.4, 0), uni(-50, 50) * k, uni(80, 260) * k,
                         uni(2.0, 3.2), choice(RAINBOW), uni(3, 6) * k, 100 * k);
    }
  };

  EP.on_outcome = function (o, cell, th) {
    if (o.cleared) {
      this.burst_rows(o.rows, cell, th);
      if (o.tspin) {
        if (this.combo_on) {
          var names = ["", " SINGLE", " DOUBLE", " TRIPLE"];
          var mini = o.tspin === 1 ? "T-SPIN MINI" : "T-SPIN";
          this.tspin((o.tspin === 2 || o.cleared < 3) ? mini + names[Math.min(o.cleared, 3)] : mini, cell, th);
        }
      } else if (o.cleared === 4 && this.combo_on) {
        this.tetris(cell, th);
      }
      if (o.b2b && this.combo_on) this.banner("BACK-TO-BACK", th.C_PINK, cell * 0.6, 1.0, 0.55, false);
      if (o.combo >= 1) this.combo(o.combo, cell, th);
      if (o.pc) this.perfect(cell, th);
    } else if (o.tspin && this.combo_on) {
      this.tspin(o.tspin === 2 ? "T-SPIN" : "T-SPIN MINI", cell, th);
    }
  };

  // ---------------- update / draw ----------------
  EP.tick = function (dt) {
    dt = Math.min(dt, 0.1);
    var ps = this.particles, j = 0, i, p;
    for (i = 0; i < ps.length; i++) {
      p = ps[i];
      p[4] -= dt;
      if (p[4] > 0) {
        p[3] += p[8] * dt;
        p[0] += p[2] * dt;
        p[1] += p[3] * dt;
        ps[j++] = p;
      }
    }
    ps.length = j;
    this.texts.forEach(function (t) { t.age += dt; });
    this.texts = this.texts.filter(function (t) { return t.age < t.dur; });
    this.rings.forEach(function (r) { r[4] -= dt; r[2] += r[3] * dt; });
    this.rings = this.rings.filter(function (r) { return r[4] > 0; });
    this.flash = Math.max(0, this.flash - dt);
    if (this.toast_cur === null && this.toasts.length) {
      var t = this.toasts.shift();
      this.toast_cur = [t[0], t[1], 0];
    }
    if (this.toast_cur !== null) {
      this.toast_cur[2] += dt;
      if (this.toast_cur[2] > 3.2) this.toast_cur = null;
    }
  };

  /** draw the effect layer onto g (already cleared and scaled by the caller) */
  EP.draw = function (g, cell, th, font) {
    var w = W * cell, h = H * cell, k = cell / BASE_CELL, i;
    font = font || "sans-serif";
    g.lineWidth = 1;
    for (i = 0; i < this.rings.length; i++) {
      var r = this.rings[i], frac = Math.max(0, r[4] / r[5]);
      g.strokeStyle = r[6];
      g.lineWidth = Math.max(1, Math.trunc(r[7] * frac));
      g.beginPath();
      g.arc(r[0], r[1], Math.max(0, r[2]), 0, Math.PI * 2);
      g.stroke();
    }
    // particles: batched by colour
    var byColor = {};
    for (i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      (byColor[p[6]] || (byColor[p[6]] = [])).push(p);
    }
    Object.keys(byColor).forEach(function (col) {
      var list = byColor[col];
      g.fillStyle = col;
      g.beginPath();
      for (var n = 0; n < list.length; n++) {
        var q = list[n], s = q[7] * Math.min(1, q[4] / q[5] * 1.5);
        if (s <= 0.2) continue;
        g.moveTo(q[0] + s, q[1]);
        g.arc(q[0], q[1], s, 0, Math.PI * 2);
      }
      g.fill();
    });
    if (this.flash > 0) {
      var lw = Math.max(2, Math.trunc(6 * Math.min(1, this.flash * 2)) * Math.max(0.6, k));
      g.strokeStyle = this.flash_color;
      g.lineWidth = lw;
      g.strokeRect(2 + lw / 2, 2 + lw / 2, w - 4 - lw, h - 4 - lw);
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (i = 0; i < this.texts.length; i++) {
      var t = this.texts[i], age = t.age, size = t.size;
      if (t.pulse) size *= 1 + 0.35 * Math.max(0, 1 - age / 0.25);
      var color = t.rainbow ? RAINBOW[Math.trunc(age * 12) % 7] : t.color;
      var fade = t.dur - age;
      if (fade < 0.25) color = mix(color, th.C_BG, 1 - fade / 0.25);
      var y = h * t.y - Math.min(age, 1.0) * cell * 0.4;
      var px = Math.max(8, Math.trunc(size));
      g.font = "bold " + px + "px Arial, sans-serif";
      // keep wide banners inside the board on narrow phones
      var tw = g.measureText(t.text).width;
      if (tw > w - 8) { px = Math.max(8, Math.floor(px * (w - 8) / tw)); g.font = "bold " + px + "px Arial, sans-serif"; }
      g.fillStyle = th.C_BG;
      g.fillText(t.text, w / 2 + 2, y + 2);
      g.fillStyle = color;
      g.fillText(t.text, w / 2, y);
    }
    if (this.toast_cur !== null) {
      var text = this.toast_cur[0], sub = this.toast_cur[1], a = this.toast_cur[2];
      var slide = Math.min(1, a / 0.25) * Math.min(1, (3.2 - a) / 0.25);
      var th46 = Math.max(46, Math.round(cell * 1.55));
      var y0 = -th46 - 4 + (th46 + 10) * Math.max(0, slide);
      g.fillStyle = th.C_PANEL;
      g.fillRect(8, y0, w - 16, th46);
      g.strokeStyle = th.C_PINK;
      g.lineWidth = 2;
      g.strokeRect(9, y0 + 1, w - 18, th46 - 2);
      g.fillStyle = th.C_CYAN;
      g.font = "bold " + Math.max(11, Math.trunc(cell * 0.45)) + "px " + font;
      g.fillText("🏆 " + text, w / 2, y0 + th46 * 0.33, w - 24);
      g.fillStyle = th.C_TEXT;
      g.font = Math.max(10, Math.trunc(cell * 0.34)) + "px " + font;
      g.fillText(sub, w / 2, y0 + th46 * 0.72, w - 24);
    }
  };

  NT.EffectsManager = EffectsManager;
  NT.Effects = { VERSION: "5.4-mobile", RAINBOW: RAINBOW, MAX_PARTICLES: MAX_PARTICLES, EffectsManager: EffectsManager };
})(typeof window !== "undefined" ? window : globalThis);
