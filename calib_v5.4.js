/*
 * NEON TETRIS v5.4-mobile — calib_v5.4.js
 * ---------------------------------------------------------------
 * "🎯 감도 찾기" — port of tetris.py (v5.3) CalibView.
 * Stop a block exactly on 12 random target cells using the hold-to-repeat ◀ / ▶
 * buttons (touch) or the left/right keys / arrow keys (keyboard). Movement uses the
 * tested DAS / ARR exactly like the game. Average overshoot decides the suggestion:
 *   >= 1.0 cell  -> slower (DAS +25, ARR +10)
 *   <= 0.3 cell  -> faster (DAS -20, ARR -8)
 *   else         -> keep
 * "추천값으로 재테스트" re-runs with the suggestion, "💾 이 값 저장" applies it to settings.
 * Uses NT.UI.openView / NT.UI.setSens / NT.UI.play / NT.UI.theme. Exposed as NT.Calib.open().
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});
  var doc = global.document;
  var W = 10, TARGETS = 12;

  function mk(tag, cls, txt, parent) {
    var d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined && txt !== null) d.textContent = txt;
    if (parent) parent.appendChild(d);
    return d;
  }

  var view = null;      // the one open calibration view

  function CalibView() {
    var UI = NT.UI, self = this;
    var sens = UI.settings.sensitivity;
    this.alive = true;
    this.phase = "idle";                       // idle / run / done
    this.cur = { das: sens.das, arr: sens.arr };
    this.rec = null;
    this.held = {};                            // source id -> direction
    this.repTimer = null;
    this.resetRun();

    var body = UI.openView("calib", "감도 찾기", "← 설정", function () { self.close(); UI.openSettings(); });
    mk("div", "note calibHelp",
       "목표 칸(분홍 테두리)에 블록을 정확히 멈춰 보세요. ◀ ▶ 버튼(또는 좌우 이동키·방향키)을 " +
       "길게 누르거나 톡톡 눌러 이동해요.\n목표에 맞춰 멈추고 손(키)을 떼면 다음 목표가 나와요. 총 " +
       TARGETS + "번.", body);
    var wrap = mk("div", "pvWrap", null, body);
    this.cv = mk("canvas", "pvCv calibCv", null, wrap);
    this.info = mk("div", "plain cyan b", "", body);
    this.result = mk("div", "plain calibRes", "", body);

    var pad = mk("div", "calibPad", null, body);
    this.bL = mk("button", "bigbtn", "◀", pad);
    this.bR = mk("button", "bigbtn", "▶", pad);
    this.bL.setAttribute("aria-label", "왼쪽 이동");
    this.bR.setAttribute("aria-label", "오른쪽 이동");
    this.bindHold(this.bL, "t:left", -1);
    this.bindHold(this.bR, "t:right", 1);

    var bar = mk("div", "bbar", null, body);
    this.btnStart = mk("button", "btn", "", bar);
    this.btnRec = mk("button", "btn", "추천값으로 재테스트", bar);
    this.btnSave = mk("button", "btn pink", "💾 이 값 저장", bar);
    this.btnStart.addEventListener("click", function () { self.start(); });
    this.btnRec.addEventListener("click", function () { self.retestRec(); });
    this.btnSave.addEventListener("click", function () { self.save(); });

    var avail = Math.min(body.clientWidth || 320, 480);
    this.cell = Math.max(24, Math.min(34, Math.floor((avail - 8) / W)));
    this.dpr = Math.min(3, global.devicePixelRatio || 1);
    var c = this.cell;
    this.cv.style.width = W * c + "px";
    this.cv.style.height = 3 * c + "px";
    this.cv.width = Math.round(W * c * this.dpr);
    this.cv.height = Math.round(3 * c * this.dpr);
    this.g = this.cv.getContext("2d");

    this.onKeyDown = function (e) { self.keyDown(e); };
    this.onKeyUp = function (e) { self.keyUp(e); };
    this.onBlur = function () { self.held = {}; self.stopRep(); };
    global.addEventListener("keydown", this.onKeyDown);
    global.addEventListener("keyup", this.onKeyUp);
    global.addEventListener("blur", this.onBlur);

    this.paintButtons();
    this.draw();
    this.loop = function () { self.step(); };
    global.requestAnimationFrame(this.loop);
  }
  var CP = CalibView.prototype;

  // ---------------- state ----------------
  CP.close = function () {
    if (!this.alive) return;
    this.alive = false;
    this.stopRep();
    global.removeEventListener("keydown", this.onKeyDown);
    global.removeEventListener("keyup", this.onKeyUp);
    global.removeEventListener("blur", this.onBlur);
    if (view === this) view = null;
  };

  CP.resetRun = function () {
    this.x = Math.floor(W / 2);
    this.target = null;
    this.nDone = 0;
    this.times = [];
    this.depths = [];
    this.dir0 = 1;
    this.depth = 0;
    this.t0 = 0;
  };

  CP.paintButtons = function () {
    this.btnRec.disabled = !this.rec;
    this.btnSave.disabled = this.phase === "run";
    this.btnStart.textContent = this.phase === "done" ? "▶ 다시 테스트" : "▶ 테스트 시작";
  };

  // ---------------- test ----------------
  CP.start = function () {
    this.stopRep();
    this.resetRun();
    this.rec = null;
    this.phase = "run";
    this.result.textContent = "";
    this.nextTarget();
    this.paintButtons();
  };

  CP.retestRec = function () {
    if (this.rec) {
      this.cur = { das: this.rec.das, arr: this.rec.arr };
      this.start();
    }
  };

  CP.save = function () {
    NT.UI.setSens("das", this.cur.das);
    NT.UI.setSens("arr", this.cur.arr);
    this.result.textContent = "저장했어요!  DAS " + this.cur.das + "ms / ARR " + this.cur.arr + "ms\n" +
      "(설정 화면의 슬라이더에서 더 세밀하게 바꿀 수 있어요)";
  };

  CP.nextTarget = function () {
    var t;
    do { t = Math.floor(Math.random() * W); } while (Math.abs(t - this.x) < 3);
    this.target = t;
    this.dir0 = t > this.x ? 1 : -1;
    this.depth = 0;
    this.t0 = global.performance.now();
  };

  CP.move = function (d) {
    var nx = this.x + d;
    if (nx >= 0 && nx < W) {
      this.x = nx;
      var past = -(this.target - this.x) * this.dir0;      // cells past the target
      this.depth = Math.max(this.depth, past);
    }
  };

  CP.stopRep = function () {
    if (this.repTimer !== null) clearTimeout(this.repTimer);
    this.repTimer = null;
  };

  /** on_key: press of a move source (key or button) */
  CP.press = function (id, d) {
    if (this.held[id] !== undefined) return;         // auto-repeat
    this.held[id] = d;
    if (this.phase !== "run") return;
    this.move(d);
    this.stopRep();
    var self = this;
    this.repTimer = setTimeout(function () { self.repeat(id, d); }, this.cur.das);
  };

  CP.release = function (id) { delete this.held[id]; };

  CP.repeat = function (id, d) {
    this.repTimer = null;
    if (!this.alive || this.phase !== "run" || this.held[id] === undefined) return;
    this.move(d);
    var self = this;
    this.repTimer = setTimeout(function () { self.repeat(id, d); }, this.cur.arr);
  };

  CP.finish = function () {
    this.phase = "done";
    this.stopRep();
    var n = this.times.length;
    var avgT = this.times.reduce(function (a, b) { return a + b; }, 0) / n;
    var avgO = this.depths.reduce(function (a, b) { return a + b; }, 0) / n;
    var das = this.cur.das, arr = this.cur.arr;
    var RD = NT.SENS_RANGE.das, RA = NT.SENS_RANGE.arr;
    var verdict, rd, ra;
    if (avgO >= 1.0) { verdict = "너무 민감해서 목표를 자꾸 지나쳐요 → 조금 느리게 추천"; rd = das + 25; ra = arr + 10; }
    else if (avgO <= 0.3) { verdict = "정확하게 잘 멈춰요 → 조금 더 빠르게 추천"; rd = das - 20; ra = arr - 8; }
    else { verdict = "지금 감도가 잘 맞아요!"; rd = das; ra = arr; }
    rd = Math.max(RD[0], Math.min(RD[1], rd));
    ra = Math.max(RA[0], Math.min(RA[1], ra));
    this.rec = (rd !== das || ra !== arr) ? { das: rd, arr: ra } : null;
    var txt = "테스트 값: DAS " + das + "ms / ARR " + arr + "ms\n" +
      "평균 " + (avgT / 1000).toFixed(2) + "초/목표  ·  평균 지나침 " + avgO.toFixed(2) + "칸\n" +
      "→ " + verdict + "\n";
    txt += this.rec ? "추천: DAS " + rd + "ms / ARR " + ra + "ms  (재테스트로 확인해 보세요)" : "이 값을 저장하면 돼요.";
    this.result.textContent = txt;
    this.paintButtons();
    NT.UI.play("levelup");
  };

  // ---------------- input ----------------
  CP.keyId = function (e) {
    var code = e.code || "", k = e.key || "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (code === "Space" || k === " ") return "space";
    if (k === "ArrowLeft") return "left";
    if (k === "ArrowRight") return "right";
    return k.toLowerCase();
  };
  CP.moveKeys = function () {
    var keys = NT.UI.settings.keys, m = { left: -1, right: 1 };
    m[keys[NT.ACT.LEFT]] = -1;
    m[keys[NT.ACT.RIGHT]] = 1;
    return m;
  };
  CP.keyDown = function (e) {
    if (!this.alive) return;
    if (NT.UI.screen !== "calib") { this.close(); return; }
    var key = this.keyId(e);
    if (key === "space") {
      e.preventDefault();
      if (!e.repeat && this.phase !== "run") this.start();
      return;
    }
    var d = this.moveKeys()[key];
    if (!d) return;
    e.preventDefault();
    if (e.repeat) return;
    this.press("k:" + key, d);
  };
  CP.keyUp = function (e) { if (this.alive) this.release("k:" + this.keyId(e)); };

  CP.bindHold = function (b, id, d) {
    var self = this, pid = null;
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      try { b.setPointerCapture(pid); } catch (err) { /* ignore */ }
      b.classList.add("on");
      self.press(id, d);
    });
    function up(e) {
      if (pid === null || (e && e.pointerId !== pid)) return;
      pid = null;
      b.classList.remove("on");
      self.release(id);
    }
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("lostpointercapture", up);
  };

  // ---------------- loop / draw ----------------
  CP.step = function () {
    if (!this.alive) return;
    if (NT.UI.screen !== "calib" || !doc.body.contains(this.cv)) { this.close(); return; }
    if (this.phase === "run" && this.x === this.target) {
      if (!Object.keys(this.held).length) {          // released on the target -> success
        this.times.push(global.performance.now() - this.t0);
        this.depths.push(this.depth);
        this.nDone += 1;
        NT.UI.play("rotate");
        if (this.nDone >= TARGETS) { this.target = null; this.finish(); }
        else this.nextTarget();
      }
    }
    this.draw();
    global.requestAnimationFrame(this.loop);
  };

  CP.draw = function () {
    var th = NT.UI.theme, c = this.cell, g = this.g, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = th.C_BG;
    g.fillRect(0, 0, W * c, 3 * c);
    g.strokeStyle = th.C_GRID;
    g.lineWidth = 1;
    g.beginPath();
    for (var i = 1; i < W; i++) { g.moveTo(i * c + 0.5, 0); g.lineTo(i * c + 0.5, 3 * c); }
    g.stroke();
    if (this.target !== null) {
      g.strokeStyle = th.C_PINK;
      g.lineWidth = 3;
      g.strokeRect(this.target * c + 3.5, c + 3.5, c - 7, c - 7);
    }
    if (this.phase !== "idle") {
      NT.Themes.drawCell(g, this.x * c + 1, c + 1, (this.x + 1) * c - 1, 2 * c - 1, th.COLORS[5], th, dpr);
    } else {
      g.fillStyle = th.C_CYAN;
      g.font = "bold " + Math.max(12, Math.round(c * 0.42)) + "px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("[테스트 시작] 또는 스페이스", W * c / 2, 1.5 * c, W * c - 8);
    }
    var info = this.phase === "run"
      ? this.nDone + " / " + TARGETS + "   (DAS " + this.cur.das + " · ARR " + this.cur.arr + ")"
      : this.phase === "idle" ? "현재 DAS " + this.cur.das + " · ARR " + this.cur.arr : this.info.textContent;
    if (this.info.textContent !== info) this.info.textContent = info;
  };

  NT.Calib = {
    VERSION: "5.4-mobile",
    TARGETS: TARGETS,
    open: function () {
      if (view) view.close();
      view = new CalibView();
      return view;
    },
    get view() { return view; }
  };
})(window);
