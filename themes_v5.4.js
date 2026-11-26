/*
 * NEON TETRIS v5.4-mobile — themes_v5.4.js
 * ---------------------------------------------------------------
 * Port of tetris.py (v5.3) sections 3-5:
 *   6 themes + custom theme (sanitize_custom / build_theme / norm_color)
 *   draw_cell for every block style (neon / arcade / minimal / crystal / metal / pastel)
 *   theme preview board (PREVIEW_ROWS)
 * Canvas drawing; cells are cached as small offscreen sprites per (style, colour, size)
 * so redraws stay cheap on phones. Exposed as window.NT.Themes.
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});

  var THEMES = {
    "네온 사이버펑크": {
      style: "neon", glow: 1.0, gloss: 0.55,
      C_BG: "#0F1016", C_PANEL: "#14151F", C_BTN: "#1C1E2E",
      C_GRID: "#1E2030", C_GRID_IMG: "#4A4F73", C_TEXT: "#E6E6FF",
      C_CYAN: "#00F5FF", C_PINK: "#FF2E97",
      COLORS: ["#00F5FF", "#4D7CFF", "#FF9100", "#FFEA00", "#39FF14", "#BF5FFF", "#FF2E63"]
    },
    "클래식 아케이드": {
      style: "arcade", glow: 0.0, gloss: 0.5,
      C_BG: "#000000", C_PANEL: "#101010", C_BTN: "#222222",
      C_GRID: "#2A2A2A", C_GRID_IMG: "#666666", C_TEXT: "#FFFFFF",
      C_CYAN: "#FFD400", C_PINK: "#FF3B30",
      COLORS: ["#00E5FF", "#2F4BFF", "#FF9F0A", "#FFE600", "#2EDB2E", "#B14AED", "#FF3030"]
    },
    "미니멀 다크": {
      style: "minimal", glow: 0.0, gloss: 0.0,
      C_BG: "#141414", C_PANEL: "#1C1C1C", C_BTN: "#272727",
      C_GRID: "#202020", C_GRID_IMG: "#555555", C_TEXT: "#D0D0D0",
      C_CYAN: "#8AA4B8", C_PINK: "#B89A8A",
      COLORS: ["#6FA8B5", "#6B7FA3", "#B58E6B", "#BDB07A", "#7FA67F", "#9A80AD", "#B27273"]
    },
    "크리스털": {
      style: "crystal", glow: 0.45, gloss: 0.9,
      C_BG: "#0A1628", C_PANEL: "#102340", C_BTN: "#173258",
      C_GRID: "#17294A", C_GRID_IMG: "#4D6A99", C_TEXT: "#E8F4FF",
      C_CYAN: "#8EF3FF", C_PINK: "#FF9ECF",
      COLORS: ["#7DF9FF", "#6C8BFF", "#FFC46B", "#FFF59A", "#8DFFB0", "#D6A6FF", "#FF8FA8"]
    },
    "메탈릭": {
      style: "metal", glow: 0.0, gloss: 0.8,
      C_BG: "#1F2229", C_PANEL: "#2A2E38", C_BTN: "#383D4A",
      C_GRID: "#2F3440", C_GRID_IMG: "#69708A", C_TEXT: "#E6EAF0",
      C_CYAN: "#B8C4D6", C_PINK: "#E8A24A",
      COLORS: ["#9FB4C7", "#6F8FB8", "#C98B4A", "#D9C27A", "#7FA58C", "#9C86B5", "#B85C5C"]
    },
    "파스텔": {
      style: "pastel", glow: 0.0, gloss: 0.6,
      C_BG: "#FFF8F3", C_PANEL: "#F3E6EC", C_BTN: "#FBDDE8",
      C_GRID: "#EADCD6", C_GRID_IMG: "#B8A9B0", C_TEXT: "#5B4B5E",
      C_CYAN: "#2F9C86", C_PINK: "#D6477F",
      COLORS: ["#9ADCF5", "#A9B7F5", "#F7C6A3", "#FBE8A0", "#B5EAC0", "#D4B5F0", "#F5A9B8"]
    }
  };
  var THEME_ORDER = Object.keys(THEMES);
  var CUSTOM_NAME = "커스텀";
  var DEFAULT_THEME = "네온 사이버펑크";
  var GARBAGE_COLOR = "#777777";
  var PIECE_NAMES = ["I", "J", "L", "O", "S", "T", "Z"];

  // ---------------- colour helpers ----------------
  var mixCache = {}, mixCount = 0;
  function mix(c1, c2, t) {
    var key = c1 + c2 + t;
    var hit = mixCache[key];
    if (hit) return hit;
    var a = c1.replace("#", ""), b = c2.replace("#", ""), out = "#";
    for (var i = 0; i < 6; i += 2) {
      var v = Math.trunc(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t);
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    if (++mixCount > 8192) { mixCache = {}; mixCount = 0; }
    return (mixCache[key] = out);
  }
  function lighten(c, a) { return mix(c, "#FFFFFF", a === undefined ? 0.45 : a); }
  function darken(c, a) { return mix(c, "#000000", a === undefined ? 0.4 : a); }

  /** '#rrggbb' only (else default) */
  function normColor(c, def) {
    if (def === undefined) def = "#FFFFFF";
    if (typeof c === "string" && c.length === 7 && c[0] === "#" && /^[0-9a-fA-F]{6}$/.test(c.slice(1))) {
      return c.toUpperCase();
    }
    return def;
  }

  function defaultCustomTheme() {
    return { base: DEFAULT_THEME, colors: THEMES[DEFAULT_THEME].COLORS.slice() };
  }

  function sanitizeCustom(data) {
    var base = defaultCustomTheme();
    if (!data || typeof data !== "object" || Array.isArray(data)) return base;
    if (typeof data.base === "string" && Object.prototype.hasOwnProperty.call(THEMES, data.base)) base.base = data.base;
    var cols = data.colors;
    if (Array.isArray(cols) && cols.length === 7) {
      var defs = THEMES[base.base].COLORS;
      base.colors = cols.map(function (c, i) { return normColor(c, defs[i]); });
    }
    return base;
  }

  function isThemeName(n) {
    return n === CUSTOM_NAME || (typeof n === "string" && Object.prototype.hasOwnProperty.call(THEMES, n));
  }

  function buildTheme(name, custom) {
    var th;
    if (name === CUSTOM_NAME) {
      var c = sanitizeCustom(custom);
      th = Object.assign({}, THEMES[c.base]);
      th.COLORS = c.colors.slice();
      return th;
    }
    th = Object.assign({}, THEMES[name] || THEMES[DEFAULT_THEME]);
    th.COLORS = th.COLORS.slice();
    return th;
  }

  function cellColor(th, v) { return v === 8 ? GARBAGE_COLOR : th.COLORS[(v - 1) % 7]; }

  // ==========================================================
  // draw_cell (Tk rectangles -> canvas)
  // ==========================================================
  function rect(g, x1, y1, x2, y2, fill, outline) {
    if (fill) { g.fillStyle = fill; g.fillRect(x1, y1, x2 - x1, y2 - y1); }
    if (outline) {
      g.strokeStyle = outline; g.lineWidth = 1;
      g.strokeRect(x1 + 0.5, y1 + 0.5, Math.max(0, x2 - x1 - 1), Math.max(0, y2 - y1 - 1));
    }
  }
  function poly(g, pts, fill) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  }
  function line(g, x1, y1, x2, y2, color) {
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x1 + 0.5, y1 + 0.5); g.lineTo(x2 + 0.5, y2 + 0.5); g.stroke();
  }

  /** draw one cell in the theme's block style (uncached) */
  function drawCellRaw(g, x1, y1, x2, y2, color, th) {
    var style = th.style || "neon";
    var c = x2 - x1;
    var bg = th.C_BG;
    var glow = th.glow || 0;
    var gloss = th.gloss === undefined ? 0.5 : th.gloss;

    if (glow > 0) {
      g.strokeStyle = mix(color, bg, 1 - 0.35 * glow);
      g.lineWidth = 2;
      g.strokeRect(x1 - 1, y1 - 1, c + 2, (y2 - y1) + 2);
      g.lineWidth = 1;
    }

    if (style === "arcade") {
      var b = Math.max(2, Math.trunc(c * 0.14));
      rect(g, x1, y1, x2, y2, darken(color, 0.5), "#000000");
      rect(g, x1 + 1, y1 + 1, x2 - 1, y1 + b, lighten(color, 0.55));
      rect(g, x1 + 1, y1 + 1, x1 + b, y2 - 1, lighten(color, 0.35));
      rect(g, x1 + 1, y2 - b, x2 - 1, y2 - 1, darken(color, 0.45));
      rect(g, x2 - b, y1 + 1, x2 - 1, y2 - 1, darken(color, 0.3));
      rect(g, x1 + b, y1 + b, x2 - b, y2 - b, color);
    } else if (style === "minimal") {
      rect(g, x1 + 1, y1 + 1, x2 - 1, y2 - 1, color, mix(color, bg, 0.35));
    } else if (style === "crystal") {
      var cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      rect(g, x1, y1, x2, y2, color);
      poly(g, [x1, y1, x2, y1, cx, cy], lighten(color, 0.30 + 0.30 * gloss));
      poly(g, [x1, y1, cx, cy, x1, y2], lighten(color, 0.12 + 0.18 * gloss));
      poly(g, [x2, y1, x2, y2, cx, cy], darken(color, 0.15));
      poly(g, [x1, y2, x2, y2, cx, cy], darken(color, 0.30));
      rect(g, x1, y1, x2, y2, null, lighten(color, 0.6));
      var r = Math.max(2, c * 0.12);
      poly(g, [cx, cy - r * 1.6, cx + r, cy, cx, cy + r * 1.6, cx - r, cy], lighten(color, 0.8));
    } else if (style === "metal") {
      var h = y2 - y1;
      rect(g, x1, y1, x2, y2, darken(color, 0.35), darken(color, 0.5));
      rect(g, x1 + 1, y1 + 1, x2 - 1, y1 + h * 0.33, lighten(color, 0.1 + 0.4 * gloss));
      rect(g, x1 + 1, y1 + h * 0.33, x2 - 1, y1 + h * 0.66, color);
      rect(g, x1 + 1, y1 + h * 0.66, x2 - 1, y2 - 1, darken(color, 0.2));
      line(g, x1 + 2, y1 + 2, x2 - 2, y1 + 2, lighten(color, 0.85));
      line(g, x1 + 2, y1 + 2, x1 + 2, y2 - 2, lighten(color, 0.6));
    } else if (style === "pastel") {
      var rr = Math.max(3, c * 0.28) / 2;          // Tk smooth polygon -> corner radius ~ r/2
      g.beginPath();
      g.moveTo(x1 + rr, y1);
      g.lineTo(x2 - rr, y1); g.quadraticCurveTo(x2, y1, x2, y1 + rr);
      g.lineTo(x2, y2 - rr); g.quadraticCurveTo(x2, y2, x2 - rr, y2);
      g.lineTo(x1 + rr, y2); g.quadraticCurveTo(x1, y2, x1, y2 - rr);
      g.lineTo(x1, y1 + rr); g.quadraticCurveTo(x1, y1, x1 + rr, y1);
      g.closePath();
      g.fillStyle = color; g.fill();
      g.strokeStyle = darken(color, 0.12); g.lineWidth = 1; g.stroke();
      g.beginPath();
      g.ellipse(x1 + c * 0.325, y1 + c * 0.25, c * 0.125, c * 0.1, 0, 0, Math.PI * 2);
      g.fillStyle = lighten(color, 0.4 + 0.3 * gloss); g.fill();
    } else {   // neon
      var inset = Math.max(3, Math.floor(c / 8));
      if (c < 10) inset = Math.max(2, Math.floor(c / 4));
      g.fillStyle = color;
      g.fillRect(x1, y1, c, y2 - y1);
      g.strokeStyle = lighten(color, 0.55);
      g.lineWidth = 1;
      g.strokeRect(x1 + 0.5, y1 + 0.5, c - 1, (y2 - y1) - 1);
      if (c >= 7) {
        g.strokeStyle = lighten(color, 0.3);
        g.strokeRect(x1 + inset + 0.5, y1 + inset + 0.5, c - 2 * inset - 1, (y2 - y1) - 2 * inset - 1);
      }
    }
  }

  // ---------------- sprite cache ----------------
  var PAD = 2;
  var sprites = {}, spriteCount = 0;
  var canMake = typeof global.document !== "undefined";
  function clearCache() { sprites = {}; spriteCount = 0; }

  /** cached draw_cell. g must be scaled by `dpr` (setTransform(dpr,...)) */
  function drawCell(g, x1, y1, x2, y2, color, th, dpr) {
    var w = x2 - x1, h = y2 - y1;
    if (!canMake || w <= 0 || h <= 0 || x1 !== Math.round(x1) || y1 !== Math.round(y1)) {
      drawCellRaw(g, x1, y1, x2, y2, color, th);
      return;
    }
    dpr = dpr || 1;
    var key = (th.style || "neon") + "|" + th.glow + "|" + th.gloss + "|" + th.C_BG + "|" + color + "|" + w + "x" + h + "@" + dpr;
    var sp = sprites[key];
    if (!sp) {
      if (spriteCount > 600) clearCache();
      sp = global.document.createElement("canvas");
      sp.width = Math.ceil((w + PAD * 2) * dpr);
      sp.height = Math.ceil((h + PAD * 2) * dpr);
      var sg = sp.getContext("2d");
      sg.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCellRaw(sg, PAD, PAD, PAD + w, PAD + h, color, th);
      sprites[key] = sp;
      spriteCount++;
    }
    g.drawImage(sp, x1 - PAD, y1 - PAD, sp.width / dpr, sp.height / dpr);
  }

  // ==========================================================
  // theme preview (draw_theme_preview)
  // ==========================================================
  var PREVIEW_ROWS = ["..........", "...JJJ....", ".....J.ZZ.", "TT..OOSSZZ",
                      "TTTLOOSS.I", "ZZTLLLJJJI", "OOZZLIJSSI", "OOIIIISSTI"];

  function drawPreview(g, th, cell, dpr) {
    var W = 10;
    g.setTransform(dpr || 1, 0, 0, dpr || 1, 0, 0);
    g.fillStyle = th.C_BG;
    g.fillRect(0, 0, W * cell, 10 * cell);
    g.strokeStyle = th.C_GRID;
    g.lineWidth = 1;
    g.beginPath();
    for (var i = 1; i < W; i++) { g.moveTo(i * cell + 0.5, 0); g.lineTo(i * cell + 0.5, 10 * cell); }
    for (var j = 1; j < 10; j++) { g.moveTo(0, j * cell + 0.5); g.lineTo(W * cell, j * cell + 0.5); }
    g.stroke();
    PREVIEW_ROWS.forEach(function (row, r) {
      var y = r + 2;
      for (var x = 0; x < row.length; x++) {
        var ch = row[x];
        var idx = PIECE_NAMES.indexOf(ch);
        if (ch !== "." && idx >= 0) {
          drawCell(g, x * cell + 1, y * cell + 1, (x + 1) * cell - 1, (y + 1) * cell - 1, cellColor(th, idx + 1), th, dpr);
        }
      }
    });
    var tcolor = th.COLORS[5];
    [[4, 0], [3, 1], [4, 1], [5, 1]].forEach(function (p) {
      drawCell(g, p[0] * cell + 1, p[1] * cell + 1, (p[0] + 1) * cell - 1, (p[1] + 1) * cell - 1, tcolor, th, dpr);
    });
    g.save();
    g.strokeStyle = tcolor;
    g.lineWidth = 2;
    g.setLineDash([3, 3]);
    [[4, 8], [3, 9], [4, 9], [5, 9]].forEach(function (p) {
      g.strokeRect(p[0] * cell + 3, p[1] * cell + 3, cell - 6, cell - 6);
    });
    g.restore();
  }

  NT.Themes = {
    VERSION: "5.4-mobile",
    THEMES: THEMES, THEME_ORDER: THEME_ORDER, CUSTOM_NAME: CUSTOM_NAME,
    DEFAULT_THEME: DEFAULT_THEME, GARBAGE_COLOR: GARBAGE_COLOR, PREVIEW_ROWS: PREVIEW_ROWS,
    mix: mix, lighten: lighten, darken: darken, normColor: normColor,
    defaultCustomTheme: defaultCustomTheme, sanitizeCustom: sanitizeCustom,
    buildTheme: buildTheme, isThemeName: isThemeName, cellColor: cellColor,
    drawCellRaw: drawCellRaw, drawCell: drawCell, clearCache: clearCache, drawPreview: drawPreview
  };
})(typeof window !== "undefined" ? window : globalThis);
