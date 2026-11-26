/* NEON TETRIS v5.4-mobile - audio module (audio_v5.4.js)
 * Port of the v5.3 Python audio system (synth_tones / combo_tone / vol_gain /
 * _add_note / synth_bgm / AudioManager) to the Web Audio API.
 * - Sounds are generated sample-by-sample exactly like the Python and cached as AudioBuffers.
 * - SFX: one voice at a time with the same priority rule as Python (a more important sound
 *   that is still playing is not cut by a less important one).
 * - BGM: looping buffers "game" / "menu".
 * - Unlocks on first user gesture; suspends on page hide, resumes on show.
 * Plain script, no libraries. Every public call is a no-op (never throws) when audio is unavailable.
 * API: window.NT.Audio = { init, play, playCombo, startBgm, stopBgm, pauseBgm, resumeBgm,
 *        setSfxVolume, setBgmVolume, setSfxOn, setBgmOn, SOUND_KEYS, TRACKS }
 */
(function () {
  "use strict";
  var NT = (window.NT = window.NT || {});

  var SR_SFX = 22050;
  var SR_BGM = 16000;

  // (freq Hz, duration ms) - same table as Python SOUNDS
  var SOUNDS = {
    rotate: [[900, 25]],
    lock: [[180, 55]],
    hold: [[600, 40], [800, 40]],
    clear: [[700, 60], [900, 60]],
    tetris: [[600, 70], [800, 70], [1000, 70], [1300, 120]],
    levelup: [[800, 80], [1000, 80], [1200, 130]],
    gameover: [[400, 150], [300, 150], [200, 300]],
    tspin: [[1000, 60], [1250, 60], [1500, 110]],
    pc: [[523, 90], [659, 90], [784, 90], [1047, 90], [1319, 90], [1568, 260]],
    record: [[784, 90], [988, 90], [1175, 90], [1568, 140], [1319, 90], [1568, 300]],
    achieve: [[1319, 70], [1568, 70], [2093, 160]],
    attack: [[900, 40], [1200, 70]],
    garbage: [[220, 70], [160, 110]]
  };
  var SOUND_PRIO = {
    rotate: 1, lock: 1, hold: 1, combo: 2, clear: 3, achieve: 3,
    tspin: 4, tetris: 4, levelup: 4, pc: 5, record: 5, gameover: 5,
    attack: 2, garbage: 3
  };
  var SOUND_KEYS = Object.keys(SOUNDS);
  var TRACKS = [{ id: "game", name: "Game (chiptune)" }, { id: "menu", name: "Menu (arpeggio)" }];

  // ---------------- synthesis (1:1 with Python) ----------------
  function synthTones(seq, sr, amp) {
    var total = 0, k;
    for (k = 0; k < seq.length; k++) total += Math.floor(sr * seq[k][1] / 1000);
    var out = new Float32Array(total), p = 0;
    for (k = 0; k < seq.length; k++) {
      var freq = seq[k][0], n = Math.floor(sr * seq[k][1] / 1000);
      if (freq <= 0) { p += n; continue; }
      var w = 2 * Math.PI * freq / sr;
      var atk = Math.max(1, Math.min(Math.floor(n / 4), Math.floor(sr * 0.004)));
      var rel = Math.max(1, Math.min(Math.floor(n / 3), Math.floor(sr * 0.012)));
      for (var i = 0; i < n; i++) {
        var env = 1.0;
        if (i < atk) env = i / atk;
        else if (i > n - rel) env = (n - i) / rel;
        var s = Math.sin(w * i) + 0.35 * Math.sin(3 * w * i);
        out[p++] = (Math.trunc(amp * env * s * 32767 / 1.35)) / 32768;
      }
    }
    return out;
  }

  function comboTone(n) {
    var f = 523.25 * Math.pow(2, Math.min(n, 14) / 12.0);
    return [[f, 45], [f * 1.26, 80]];
  }

  function volGain(vol) {
    vol = Number(vol);
    if (!isFinite(vol)) vol = 0;
    return Math.pow(Math.max(0, Math.min(100, vol)) / 100.0, 1.6);
  }

  function midi(n) { return 440.0 * Math.pow(2, (n - 69) / 12.0); }

  function addNote(buf, sr, start, dur, freq, amp, kind, duty) {
    if (duty === undefined) duty = 0.5;
    var i0 = Math.floor(start * sr), n = Math.floor(dur * sr);
    if (n <= 0 || i0 >= buf.length) return;
    n = Math.min(n, buf.length - i0);
    var atk = Math.max(1, Math.min(Math.floor(n / 3), Math.floor(sr * 0.006)));
    var rel = Math.max(1, Math.min(Math.floor(n / 2), Math.floor(sr * 0.05)));
    var step = freq / sr, ph = 0.0, tau = 2 * Math.PI;
    for (var i = 0; i < n; i++) {
      var env = 1.0;
      if (i < atk) env = i / atk;
      else if (i > n - rel) env = (n - i) / rel;
      var v;
      if (kind === "square") v = ph < duty ? 1.0 : -1.0;
      else if (kind === "tri") v = 4.0 * Math.abs(ph - 0.5) - 1.0;
      else v = Math.sin(tau * ph);
      buf[i0 + i] += amp * env * v;
      ph += step;
      if (ph >= 1.0) ph -= 1.0;
    }
  }

  function synthBgm(track) {
    var sr = SR_BGM, buf, beat, ci, k, b;
    if (track === "game") {
      var chords = [[45, [57, 60, 64, 69]], [41, [53, 57, 60, 65]],
                    [48, [55, 60, 64, 67]], [43, [55, 59, 62, 67]]];
      beat = 60.0 / 150;
      var bpc = 2;
      buf = new Float64Array(Math.floor(chords.length * bpc * 4 * beat * sr));
      var leadA = [3, 2, 1, 2, 3, 3, 2, 0, 1, 2, 3, 2, 1, 0, 1, null];
      var leadB = [2, 3, 2, 1, 0, 1, 2, 3, 3, 2, 1, 2, 3, null, 2, 1];
      for (ci = 0; ci < chords.length; ci++) {
        var root = chords[ci][0], tones = chords[ci][1];
        var t0 = ci * bpc * 4 * beat;
        for (b = 0; b < bpc * 4; b++) {
          addNote(buf, sr, t0 + b * beat, beat * 0.45, midi(root), 0.30, "tri");
          addNote(buf, sr, t0 + b * beat + beat * 0.5, beat * 0.45, midi(root + 12), 0.22, "tri");
        }
        for (k = 0; k < bpc * 16; k++) {
          var tn = tones[(Math.floor(k / 4) % 2 === 0) ? (k % 4) : (3 - k % 4)];
          addNote(buf, sr, t0 + k * beat / 4, beat / 4 * 0.8, midi(tn), 0.09, "square", 0.25);
        }
        var pat = ci % 2 === 0 ? leadA : leadB;
        for (k = 0; k < pat.length; k++) {
          if (pat[k] !== null)
            addNote(buf, sr, t0 + k * beat / 2, beat / 2 * 0.85, midi(tones[pat[k]] + 12), 0.17, "square", 0.5);
        }
      }
    } else {
      var ch = [[48, [60, 64, 67, 71]], [45, [57, 60, 64, 67]],
                [41, [53, 57, 60, 64]], [43, [55, 59, 62, 64]]];
      beat = 60.0 / 80;
      buf = new Float64Array(Math.floor(ch.length * 4 * beat * sr));
      var seq = [0, 1, 2, 3, 2, 1, 2, 3];
      for (ci = 0; ci < ch.length; ci++) {
        var r = ch[ci][0], ts = ch[ci][1], s0 = ci * 4 * beat;
        for (k = 0; k < 3; k++) addNote(buf, sr, s0, 4 * beat * 0.98, midi(ts[k] - 12), 0.06, "sine");
        addNote(buf, sr, s0, 2 * beat, midi(r), 0.22, "sine");
        addNote(buf, sr, s0 + 2 * beat, 2 * beat, midi(r + 7), 0.18, "sine");
        for (k = 0; k < seq.length; k++)
          addNote(buf, sr, s0 + k * beat / 2, beat / 2 * 0.9, midi(ts[seq[k]] + 12), 0.14, "tri");
      }
    }
    var peak = 1e-9, i;
    for (i = 0; i < buf.length; i++) { var a = Math.abs(buf[i]); if (a > peak) peak = a; }
    var scale = peak > 0.85 ? 0.85 / peak : 1.0;
    var out = new Float32Array(buf.length);
    for (i = 0; i < buf.length; i++) out[i] = Math.trunc(buf[i] * scale * 32767) / 32768;
    return out;
  }

  // ---------------- state ----------------
  var ctx = null, sfxGain = null, bgmGain = null, unavailable = false;
  var sfxOn = true, bgmOn = true, sfxVol = 70, bgmVol = 50;
  var sfxBufs = {}, comboBufs = {}, bgmBufs = {};
  var curSfx = [], until = 0, curPrio = 0;
  var track = null;          // requested track id (null = none)
  var bgmSrc = null, bgmPlaying = null, bgmStartAt = 0, bgmOffset = 0, bgmPaused = false;
  var hidden = false;

  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { /* audio must never break the game */ }
    };
  }

  function makeBuffer(data, sr) {
    var b = ctx.createBuffer(1, Math.max(1, data.length), sr);
    if (b.copyToChannel) b.copyToChannel(data, 0); else b.getChannelData(0).set(data);
    return b;
  }

  function getSfx(name) {
    if (!sfxBufs[name] && SOUNDS[name]) sfxBufs[name] = makeBuffer(synthTones(SOUNDS[name], SR_SFX, 0.8), SR_SFX);
    return sfxBufs[name];
  }
  function getCombo(n) {
    var c = Math.min(Math.max(1, Math.floor(n)), 14);
    if (!comboBufs[c]) comboBufs[c] = makeBuffer(synthTones(comboTone(c), SR_SFX, 0.8), SR_SFX);
    return comboBufs[c];
  }
  function getBgm(id) {
    if (!bgmBufs[id]) bgmBufs[id] = makeBuffer(synthBgm(id), SR_BGM);
    return bgmBufs[id];
  }

  function renderAll() {
    if (!ctx) return 0;
    var cnt = 0, i;
    for (i = 0; i < SOUND_KEYS.length; i++) if (getSfx(SOUND_KEYS[i])) cnt++;
    for (i = 1; i <= 14; i++) if (getCombo(i)) cnt++;
    for (i = 0; i < TRACKS.length; i++) if (getBgm(TRACKS[i].id)) cnt++;
    return cnt;
  }

  function unlockSilent() {
    // iOS: playing a buffer inside a gesture unlocks output
    var s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  }

  function init() {
    if (unavailable) return false;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { unavailable = true; return false; }
      ctx = new AC();
      sfxGain = ctx.createGain();
      bgmGain = ctx.createGain();
      sfxGain.connect(ctx.destination);
      bgmGain.connect(ctx.destination);
      sfxGain.gain.value = volGain(sfxVol);
      bgmGain.gain.value = volGain(bgmVol);
      // pre-render SFX now (small); BGM rendered after a tick so the first touch stays snappy
      for (var i = 0; i < SOUND_KEYS.length; i++) getSfx(SOUND_KEYS[i]);
      setTimeout(safe(function () {
        for (var j = 0; j < TRACKS.length; j++) getBgm(TRACKS[j].id);
        for (var c = 1; c <= 14; c++) getCombo(c);
        syncBgm(false);
      }), 0);
    }
    try { unlockSilent(); } catch (e) {}
    if (ctx.state !== "running" && !hidden && ctx.resume) {
      var p = ctx.resume();
      if (p && p.then) p.then(safe(function () { syncBgm(false); }), function () {});
    }
    return true;
  }

  // ---------------- SFX ----------------
  function stopCurrentSfx() {
    for (var i = 0; i < curSfx.length; i++) { try { curSfx[i].stop(); } catch (e) {} }
    curSfx = [];
  }

  function startSources(bufs) {
    var t = ctx.currentTime, total = 0;
    stopCurrentSfx();
    for (var i = 0; i < bufs.length; i++) {
      var s = ctx.createBufferSource();
      s.buffer = bufs[i];
      s.connect(sfxGain);
      s.start(t + total);
      total += bufs[i].duration;
      curSfx.push(s);
    }
    return total;
  }

  // play(name[, combo]) - combo>=1 appends the combo tone like Python's play(name, combo)
  function play(name, combo) {
    if (!ctx || !sfxOn || sfxVol <= 0) return;
    combo = combo >= 1 ? Math.floor(combo) : 0;
    var base = SOUNDS[name] ? getSfx(name) : null;
    if (!base && !combo) return;
    var prio = SOUND_PRIO[name] || 1;
    if (combo >= 1) prio = Math.max(prio, SOUND_PRIO.combo);
    var now = ctx.currentTime;
    if (now < until && prio < curPrio) return;   // more important sound still playing
    var bufs = [];
    if (base) bufs.push(base);
    if (combo >= 1) bufs.push(getCombo(combo));
    until = now + startSources(bufs);
    curPrio = prio;
  }

  function playCombo(n) {
    if (!(n >= 1)) return;
    play(null, n);
  }

  function setSfxVolume(v) {
    v = Math.round(Number(v));
    sfxVol = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    if (sfxGain) sfxGain.gain.value = volGain(sfxVol);
  }
  function setSfxOn(on) {
    sfxOn = !!on;
    if (!sfxOn && ctx) { stopCurrentSfx(); until = 0; }
  }

  // ---------------- BGM ----------------
  function killBgmSource() {
    if (bgmSrc) {
      try { bgmSrc.onended = null; bgmSrc.stop(); } catch (e) {}
      try { bgmSrc.disconnect(); } catch (e) {}
    }
    bgmSrc = null;
  }

  function startBgmSource(id, offset) {
    killBgmSource();
    var buf = getBgm(id);
    var s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(bgmGain);
    offset = offset % buf.duration || 0;
    s.start(0, offset);
    bgmSrc = s;
    bgmPlaying = id;
    bgmStartAt = ctx.currentTime - offset;
  }

  // make the actual output match (track, bgmOn, bgmVol, bgmPaused). force = restart from 0
  function syncBgm(force) {
    if (!ctx) return;
    var want = bgmOn && track && bgmVol > 0 && !bgmPaused;
    if (!want) {
      if (bgmSrc && bgmPaused && bgmPlaying === track) {
        bgmOffset = (ctx.currentTime - bgmStartAt) % bgmSrc.buffer.duration;
      }
      killBgmSource();
      if (!track || !bgmOn || bgmVol <= 0) { bgmPlaying = null; bgmOffset = 0; }
      return;
    }
    if (bgmSrc && bgmPlaying === track && !force) return;
    var off = (!force && bgmPlaying === track) ? bgmOffset : 0;
    startBgmSource(track, off);
    bgmOffset = 0;
  }

  function startBgm(id) {
    if (id === null || id === undefined || id === "") { stopBgm(); return; }
    id = String(id);
    var known = false;
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) known = true;
    if (!known) return;
    if (bgmPlaying !== id) { killBgmSource(); bgmPlaying = null; bgmOffset = 0; }
    track = id;
    bgmPaused = false;
    syncBgm(false);
  }
  function stopBgm() {
    track = null;
    bgmPaused = false;
    if (ctx) syncBgm(false);
  }
  function pauseBgm() {
    if (bgmPaused) return;
    bgmPaused = true;
    if (ctx) syncBgm(false);
  }
  function resumeBgm() {
    if (!bgmPaused) return;
    bgmPaused = false;
    if (ctx) syncBgm(false);
  }
  function setBgmVolume(v) {
    v = Math.round(Number(v));
    bgmVol = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    if (bgmGain) bgmGain.gain.value = volGain(bgmVol);
    if (ctx) syncBgm(false);
  }
  function setBgmOn(on) {
    bgmOn = !!on;
    if (ctx) syncBgm(false);
  }

  // ---------------- lifecycle: unlock + visibility ----------------
  function onGesture() {
    init();
    if (ctx && ctx.state === "running") {
      ["touchstart", "touchend", "pointerdown", "mousedown", "keydown", "click"].forEach(function (ev) {
        window.removeEventListener(ev, gestureHandler, true);
      });
    }
  }
  var gestureHandler = safe(onGesture);
  try {
    ["touchstart", "touchend", "pointerdown", "mousedown", "keydown", "click"].forEach(function (ev) {
      window.addEventListener(ev, gestureHandler, true);
    });
    document.addEventListener("visibilitychange", safe(function () {
      hidden = document.hidden;
      if (!ctx) return;
      if (hidden) {
        if (ctx.suspend) ctx.suspend().catch(function () {});
      } else if (ctx.resume) {
        ctx.resume().catch(function () {});
      }
    }));
  } catch (e) {}

  NT.Audio = {
    VERSION: "v5.4-mobile",
    SOUND_KEYS: SOUND_KEYS.slice(),
    TRACKS: TRACKS.map(function (t) { return { id: t.id, name: t.name }; }),
    SOUND_PRIO: SOUND_PRIO,
    init: safe(init),
    play: safe(play),
    playCombo: safe(playCombo),
    startBgm: safe(startBgm),
    stopBgm: safe(stopBgm),
    pauseBgm: safe(pauseBgm),
    resumeBgm: safe(resumeBgm),
    setSfxVolume: safe(setSfxVolume),
    setBgmVolume: safe(setBgmVolume),
    setSfxOn: safe(setSfxOn),
    setBgmOn: safe(setBgmOn),
    renderAll: safe(renderAll),                    // test/debug helper: number of buffers rendered
    volGain: volGain,
    isAvailable: function () { return !!ctx && !unavailable; },
    getState: function () { return { ctx: ctx ? ctx.state : "none", track: track, playing: bgmPlaying, paused: bgmPaused, sfxOn: sfxOn, bgmOn: bgmOn, sfxVol: sfxVol, bgmVol: bgmVol }; }
  };
})();
