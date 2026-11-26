/*
 * NEON TETRIS v5.4-mobile — multi_v5.4.js
 * ---------------------------------------------------------------
 * Stage 4: multiplayer UI, a port of the Tetris class multiplayer parts of tetris.py (v5.3):
 *   lobby (build_lobby: nickname, 방 만들기, 방 코드로 참가) · waiting room (build_waiting:
 *   up to 40 players, ready toggle, host rules presets / entries / 내 프리셋, per-player limits,
 *   live RULES sharing, start) · versus (begin_multiplayer, after_lock_multi attack + target,
 *   ATTACK -> incoming garbage (offset / rise are in GameCore), ELIMINATED, RESULT ranking,
 *   finish_multi_win, on_net_lost, leave_match, play_again -> waiting room) · spectate panel
 *   (spec_ensure / set_spec / cycle_spec, BOARD snapshots, board_loop 0.2 s + only-if-changed).
 * Network: window.NT.Net (net_v5.4.js), events polled every 50 ms like net_tick().
 * Mobile differences (no behaviour change in the match itself):
 *   - no LAN mode (browsers cannot open UDP/TCP sockets) - one-line note in the lobby
 *   - Tab / V also work, plus a 🎯 button (target) and the spectate panel's ◀ ▶ / tap (next)
 *   - the opponent's score is never shown in the spectate panel
 *   - Ⅱ in a match shows a "VERSUS" card (☰ 나가기 = eliminated) instead of a yes/no box
 *   - ?broker=ws(s)://host:port/path overrides the MQTT broker (tests / self-hosting);
 *     ?join=CODE opens the lobby with the room code filled in (share link)
 * Exposed as window.NT.Multi.
 */
(function (global) {
  "use strict";

  var NT = global.NT, doc = global.document;
  if (!NT || !NT.UI || !NT.NetworkManager || !doc) return;
  var UI = NT.UI, H = NT.HEIGHT;
  var CFG = NT.NetConfig, MAX_PLAYERS = CFG.MAX_PLAYERS;
  var LIMIT_KEYS = NT.LIMIT_KEYS;
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // ---------------- broker override (?broker=ws://localhost:PORT/mqtt) ----------------
  var brokerOverride = null;
  (function () {
    var m = /[?&]broker=([^&#]*)/.exec(global.location.search || "");
    if (!m) return;
    var url;
    try { url = decodeURIComponent(m[1]); } catch (e) { return; }
    if (!/^wss?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url)) return;
    brokerOverride = url;
    var old = NT.Net;
    NT.Net = new NT.NetworkManager({ transport: function (o) { o.url = url; return new NT.MiniMqtt(o); } });
    NT.Net.nickname = old.nickname;
    NT.Net.installLifecycle(global, doc);
  })();
  var net = NT.Net;

  // ---------------- state (tetris.py Tetris.__init__ multiplayer fields) ----------------
  var settings = UI.settings;
  if (settings.nickname) net.nickname = settings.nickname;
  settings.nickname = net.nickname;

  var st = {
    limits: new Map(),            // 방장이 설정한 개별 제약 nick -> {제약: true}
    roomRules: NT.sanitizeRules(null),
    roomLimits: {},
    roomRulesSet: false,
    matchLimits: {},
    matchRules: NT.sanitizeRules(null),
    netInMatch: false,            // 대전 진행 중 (결과 신호를 받기 전까지)
    targetMode: "RANDOM",
    lastAttacker: null,
    matchIds: [],
    deadIds: new Set(),
    aliveNow: 0,
    matchResult: null,
    players: [],
    specTarget: null,             // 지금 보고 있는 상대
    specData: null,
    lastSnap: null,
    boardTimer: null
  };
  var refs = {};

  function runner() { return UI.runner; }
  function isMulti() { var r = runner(); return !!(r && r.mode === "multi"); }
  function me() { return net.nickname; }
  function dirty() { UI.markDirty(); }
  function setStatus(text) { var r = runner(); if (r) { r.status = text; dirty(); } }
  function cleanNick(v) { return NT.NetUtil.cleanNick(v); }
  function limitsObj() {             // Map -> plain object (own keys only, any nickname)
    var o = {};
    st.limits.forEach(function (d, n) {
      Object.defineProperty(o, n, { value: d, enumerable: true, writable: true, configurable: true });
    });
    return o;
  }
  function getLim(obj, nick) { return obj && nick !== null && nick !== undefined && hasOwn(obj, nick) ? obj[nick] : null; }
  function limitLabels(lim) {
    return LIMIT_KEYS.filter(function (k) { return lim && lim[k[0]]; }).map(function (k) { return k[1]; }).join(", ");
  }
  function saveSettings() { settings.nickname = net.nickname; UI.saveSettings(); }

  // ---------------- small DOM helpers ----------------
  function mk(tag, cls, txt, parent) {
    var d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined && txt !== null) d.textContent = txt;
    if (parent) parent.appendChild(d);
    return d;
  }
  function btn(parent, label, fn, cls) {
    var b = mk("button", "btn" + (cls ? " " + cls : ""), label, parent);
    b.addEventListener("click", fn);
    return b;
  }
  function entry(parent, value, cls, attrs) {
    var e = mk("input", "inp" + (cls ? " " + cls : ""), null, parent);
    e.type = "text";
    e.value = value;
    e.autocomplete = "off";
    e.spellcheck = false;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    e.addEventListener("keydown", function (ev) { ev.stopPropagation(); if (ev.key === "Escape") e.blur(); });
    return e;
  }
  function section(parent, t) { return mk("div", "sec", t, parent); }
  function note(parent, t, cls) { return mk("div", "note" + (cls ? " " + cls : ""), t, parent); }

  // ==========================================================
  // net_tick: poll the network events every 50 ms (handled on the UI side, never re-entrant)
  // ==========================================================
  setInterval(function () {
    for (var i = 0; i < 400; i++) {
      var ev = net.poll();
      if (!ev) break;
      try { onNetEvent(ev); } catch (e) { console.error("[multi] event error", ev && ev.type, e); }
    }
  }, 50);

  function onNetEvent(ev) {
    var k = ev.type;
    if (k === "STATUS") {
      setNetStatus(ev.text || "");
    } else if (k === "CONNECTED") {
      if (UI.screen === "lobby") openWaiting();
    } else if (k === "JOIN_FAIL") {
      setNetStatus("입장 실패: " + (ev.reason || ""));
      net.leave();
    } else if (k === "PLAYER_LIST") {
      st.players = ev.list || [];
      if (UI.screen === "waiting") refreshWaiting();
    } else if (k === "RULES") {
      st.roomRules = NT.sanitizeRules(ev.rules);
      st.roomLimits = NT.sanitizeLimits(ev.limits);
      st.roomRulesSet = true;
      if (UI.screen === "waiting") refreshWaiting();
    } else if (k === "START") {
      beginMultiplayer(ev.seed, ev.players || [], ev.rules, ev.limits);
    } else if (k === "ATTACK") {
      if (inMatch()) {
        var r = runner(), n = Math.max(0, Math.trunc(ev.lines) || 0);
        var add = Math.min(H, r.core.incoming + n) - r.core.incoming;    // incoming = min(HEIGHT, incoming + n)
        if (add > 0) r.receive_garbage(add);                               // (recorded for the replay)
        st.lastAttacker = ev.from;
        setStatus("⚠️ " + st.lastAttacker + " 에게 " + n + "줄 공격 받음!");
      }
    } else if (k === "ELIMINATED") {
      var pid = ev.id;
      st.deadIds.add(pid);
      st.aliveNow = Math.trunc(ev.left);
      if (isNaN(st.aliveNow)) st.aliveNow = 0;
      if (st.targetMode === pid) {
        st.targetMode = "RANDOM";
        updateTargetButton();
      }
      updateAlive();
      specEnsure();
      if (UI.screen === "game" && isMulti() && pid !== me()) {
        setStatus("💀 " + pid + " 탈락! (남은 " + st.aliveNow + "명)");
      }
    } else if (k === "BOARD") {
      if (isMulti() && ev.id === st.specTarget) {
        var d = NT.parseBoard(ev);
        if (d) {
          st.specData = d;
          drawSpec();
        }
      }
    } else if (k === "RESULT") {
      handleMatchResult(ev);
    } else if (k === "ROOM_CLOSED" || k === "DISCONNECTED") {
      onNetLost(k);
    }
  }

  /** 방이 닫혔거나 연결이 끊김 */
  function onNetLost(kind) {
    // v5.4: a closed room is left right away (tetris.py kept the dead link "connected",
    // so "다시 시작" opened an empty waiting room)
    if (kind === "ROOM_CLOSED" && !net.isHost) net.leave();
    var r = runner();
    if (isMulti() && st.netInMatch) {
      st.netInMatch = false;
      if (!r.game_over) r.end_game();
      setStatus("연결이 끊어졌어요. 대전이 종료됐어요.");
      if (UI.screen === "game") UI.scheduleResults(1500);
      return;
    }
    if (UI.screen === "waiting") openLobby("방이 닫혔거나 연결이 끊어졌어요.");
  }

  function setNetStatus(text) {
    var lab = refs.status;
    if (lab && (UI.screen === "lobby" || UI.screen === "waiting")) lab.textContent = text;
  }

  // ==========================================================
  // 로비 (build_lobby)
  // ==========================================================
  function openLobby(notice, code) {
    net.flush();
    var body = UI.openView("lobby", "멀티플레이 로비");
    refs = {};
    body.classList.add("mp");
    note(body, "🌐 온라인 대전: 방장이 방을 만들고 6자리 방 코드를 알려 주면, 와이파이가 달라도 코드로 참가할 수 있어요. (최대 " +
         MAX_PLAYERS + "명)");
    note(body, "브라우저는 보안상 UDP/TCP 소켓을 열 수 없어, 같은 와이파이에서도 방 코드(온라인) 방식으로 대전해요.", "cyant");
    note(body, "v" + CFG.VERSION + " 끼리만 같은 방에서 대전할 수 있어요. (PC v5.3 과는 접속 안 됨)");
    if (brokerOverride) note(body, "서버: " + brokerOverride, "pinkt");

    section(body, "내 닉네임");
    var row = mk("div", "mrow", null, body);
    refs.nick = entry(row, net.nickname, "", { maxlength: "20", enterkeyhint: "done" });
    btn(row, "저장", saveNickname, "small");

    section(body, "방 만들기 (방장)");
    row = mk("div", "mrow", null, body);
    refs.rname = entry(row, net.nickname + "의 방", "", { maxlength: "30" });
    refs.nick.addEventListener("input", function () {        // the default room name follows the nickname
      if (refs.rname.dataset.edited) return;
      refs.rname.value = (cleanNick(refs.nick.value) || net.nickname) + "의 방";
    });
    refs.rname.addEventListener("input", function () { refs.rname.dataset.edited = "1"; });
    btn(row, "방 만들기", makeOnlineRoom, "small");

    section(body, "방 코드로 참가");
    row = mk("div", "mrow", null, body);
    refs.code = entry(row, code || "", "code", { maxlength: "6", placeholder: "ABC234", autocapitalize: "characters",
                                                 enterkeyhint: "go" });
    refs.code.addEventListener("input", function () {
      var v = refs.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      if (v !== refs.code.value) refs.code.value = v;
    });
    refs.code.addEventListener("keydown", function (e) { if (e.key === "Enter") joinOnline(); });
    btn(row, "참가", joinOnline, "small");

    refs.status = mk("div", "mstatus", "", body);
    if (notice) setNetStatus(notice);
  }

  /** 닉네임 칸의 값을 저장하고 돌려줌 (비어 있으면 null) */
  function readNickname() {
    var e = refs.nick;
    var nick = e ? cleanNick(e.value) : net.nickname;
    if (!nick) {
      setNetStatus("닉네임을 입력해 주세요.");
      return null;
    }
    if (e) e.value = nick;
    if (nick !== net.nickname) {
      net.nickname = nick;
      saveSettings();
    }
    return nick;
  }

  function saveNickname() {
    if (readNickname()) setNetStatus("닉네임: " + net.nickname);
  }

  function makeOnlineRoom() {
    var nick = readNickname();
    if (!nick) return;
    var name = Array.from((refs.rname.value || "").trim()).slice(0, 30).join("") || nick + "의 방";
    var res = net.startOnlineHost(name);
    if (!res.ok) {
      setNetStatus(res.err);
      return;
    }
    openWaiting();
  }

  function joinOnline() {
    var code = (refs.code.value || "").trim();
    if (!code) {
      setNetStatus("방장이 알려준 방 코드를 입력해 주세요.");
      return;
    }
    if (!readNickname()) return;
    st.roomRulesSet = false;
    setNetStatus("방 " + code.toUpperCase() + " 접속 중...");
    net.connectOnline(code);
  }

  // ==========================================================
  // 대기실 (build_waiting / refresh_waiting)
  // ==========================================================
  var RULE_FIELDS = [["싱글", "a1"], ["더블", "a2"], ["트리플", "a3"], ["테트리스", "a4"],
                     ["T-스핀 ×줄", "tspin_mult"], ["B2B +", "b2b"], ["콤보 %", "combo_pct"],
                     ["퍼펙트 +", "pc"], ["방해줄 상한", "max_garbage"]];

  function openWaiting() {
    var host = net.isHost;
    var body = UI.openView("waiting", host ? "대기실 - " + net.roomName : "대기실", "← 나가기", leaveWaiting);
    refs = {};
    body.classList.add("mp");
    if (host) {
      var box = mk("div", "codeBox", null, body);
      mk("div", "codeLbl", "방 코드", box);
      refs.codeText = mk("div", "codeTxt", net.code, box);
      var cb = mk("div", "codeBtns", null, box);
      btn(cb, "📋 복사", copyCode, "small");
      if (global.navigator && global.navigator.share) btn(cb, "📤 공유", shareCode, "small");
      note(body, "친구에게 방 코드를 알려 주세요 · 와이파이가 달라도 접속 가능", "cyant");
    } else {
      note(body, "방 코드 " + net.code + " · 방장이 시작할 때까지 '준비 완료'를 눌러 주세요.", "cyant");
    }
    refs.count = mk("div", "mcount", "", body);
    if (host) {
      buildRulesPanel(body);
      buildLimitsPanel(body);
      pushRulesInfo();
    } else {
      refs.rulesSum = mk("div", "rulesSum", "", body);
    }
    refs.players = mk("div", "plist", null, body);
    refs.status = mk("div", "mstatus", "", body);
    var bar = mk("div", "bbar", null, body);
    refs.btn = host ? btn(bar, "▶ 게임 시작", hostStart) : btn(bar, "준비 완료", toggleReady);
    refreshWaiting();
  }

  function refreshWaiting() {
    var lb = refs.players;
    if (!lb || UI.screen !== "waiting") return;
    var plist = st.players.length ? st.players : net.players;
    var host = net.isHost;
    var limits = host ? limitsObj() : st.roomLimits;
    refs.plistIds = plist.map(function (p) { return p.id; });
    lb.innerHTML = "";
    plist.forEach(function (p) {
      var mine = p.id === me() ? "  (나)" : "";
      var lim = getLim(limits, p.id);
      var tags = lim ? "   🚫 " + limitLabels(lim) : "";
      var txt = p.is_host ? "👑 " + p.id + "  - 방장" + mine + tags
        : (p.ready ? "✅ " : "⏳ ") + p.id + "  - " + (p.ready ? "준비 완료" : "대기 중") + mine + tags;
      var row = mk(host ? "button" : "div", "pitem" + (p.ready || p.is_host ? " ready" : ""), txt, lb);
      if (host) {
        if (p.id === refs.selNick) row.classList.add("sel");
        row.addEventListener("click", function () { refs.selNick = p.id; refreshWaiting(); });
      }
    });
    if (refs.limitBtns && refs.plistIds.indexOf(refs.selNick) < 0) refs.selNick = null;
    syncLimitVars();
    if (refs.rulesSum) {
      var txt;
      if (st.roomRulesSet) {
        var mineLim = getLim(st.roomLimits, me());
        txt = "⚔ 방장 규칙: " + NT.rulesText(st.roomRules);
        if (mineLim) txt += "\n🚫 내 제약: " + limitLabels(mineLim);
      } else {
        txt = "⚔ 공격 규칙은 방장이 정해요 (설정하면 여기에 바로 표시돼요)";
      }
      refs.rulesSum.textContent = txt;
    }
    refs.count.textContent = "참가자 " + plist.length + " / " + MAX_PLAYERS + "명";
    if (!host) {
      var mineP = null;
      plist.forEach(function (p) { if (p.id === me()) mineP = p; });
      var ready = !!(mineP && mineP.ready);
      net.isReady = ready;
      refs.btn.textContent = ready ? "준비 취소" : "준비 완료";
      refs.btn.classList.toggle("pink", ready);
    }
  }

  function toggleReady() {
    net.toggleReady();
    refreshWaiting();
  }

  // ---------------- 공격 규칙 (방장 전용) ----------------
  function buildRulesPanel(parent) {
    var box = mk("div", "mbox", null, parent);
    mk("div", "mboxT", "⚔ 공격 규칙 (방장 설정 · 모두에게 똑같이 적용)", box);
    var pr = mk("div", "presets", null, box);
    Object.keys(NT.RULE_PRESETS).forEach(function (name) {
      btn(pr, name, function () { applyRulePreset(name); }, "small");
    });
    btn(pr, "⭐ 내 프리셋", applyCustomPreset, "small");
    var grid = mk("div", "rgrid", null, box);
    var ents = {};
    RULE_FIELDS.forEach(function (f) {
      var c = mk("label", "rcell", null, grid);
      mk("span", null, f[0], c);
      ents[f[1]] = entry(c, "", "num", { inputmode: "numeric", maxlength: "4" });
    });
    refs.ruleEntries = ents;
    var brow = mk("div", "mrow end", null, box);
    btn(brow, "💾 내 프리셋으로 저장", saveCustomPreset, "small");
    btn(brow, "적용", applyRulesEntries, "small");
    fillRuleEntries();
  }

  function fillRuleEntries() {
    var ents = refs.ruleEntries;
    if (!ents) return;
    var r = settings.multi_rules;
    var vals = { a1: r.attack[0], a2: r.attack[1], a3: r.attack[2], a4: r.attack[3] };
    ["tspin_mult", "b2b", "combo_pct", "pc", "max_garbage"].forEach(function (k) { vals[k] = r[k]; });
    Object.keys(ents).forEach(function (k) { ents[k].value = String(vals[k]); });
  }

  function applyRulePreset(name) {
    settings.multi_rules = NT.sanitizeRules(NT.RULE_PRESETS[name]);
    saveSettings();
    pushRulesInfo();
    fillRuleEntries();
    setNetStatus("공격 규칙: " + name);
  }

  function pushRulesInfo() {
    if (net.isHost && net.connected) net.setRulesInfo(settings.multi_rules, limitsObj());
  }

  function applyCustomPreset() {
    if (!settings.custom_rules) {
      setNetStatus("저장된 내 프리셋이 없어요. 값을 입력하고 '내 프리셋으로 저장'을 눌러 주세요.");
      return;
    }
    settings.multi_rules = NT.sanitizeRules(settings.custom_rules);
    saveSettings();
    pushRulesInfo();
    fillRuleEntries();
    setNetStatus("공격 규칙: 내 프리셋");
  }

  function saveCustomPreset() {
    if (!applyRulesEntries()) return;
    settings.custom_rules = NT.sanitizeRules(settings.multi_rules);
    saveSettings();
    setNetStatus("현재 값을 내 프리셋으로 저장했어요.");
  }

  /** 입력칸 값을 읽어 공격 규칙으로 적용. 숫자가 아니면 false */
  function applyRulesEntries() {
    var ents = refs.ruleEntries;
    if (!ents) return true;
    var v = {}, bad = false;
    Object.keys(ents).forEach(function (k) {
      var s = ents[k].value.trim();
      if (!/^[+-]?\d{1,9}$/.test(s)) bad = true;
      else v[k] = parseInt(s, 10);
    });
    if (bad) {
      setNetStatus("공격 규칙에는 숫자만 입력해 주세요.");
      return false;
    }
    settings.multi_rules = NT.sanitizeRules({
      attack: [v.a1, v.a2, v.a3, v.a4], tspin_mult: v.tspin_mult, b2b: v.b2b,
      combo_pct: v.combo_pct, pc: v.pc, max_garbage: v.max_garbage });
    saveSettings();
    pushRulesInfo();
    fillRuleEntries();                 // 범위를 벗어난 값은 보정돼서 표시됨
    setNetStatus("공격 규칙을 적용했어요.");
    return true;
  }

  // ---------------- 개별 제약 (방장 전용) ----------------
  function buildLimitsPanel(parent) {
    var box = mk("div", "mbox", null, parent);
    mk("div", "mboxT", "🚫 개별 제약 — 아래 목록에서 플레이어를 선택하고 체크", box);
    refs.selLbl = mk("div", "note", "", box);
    var row = mk("div", "limRow", null, box);
    refs.limitBtns = {};
    LIMIT_KEYS.forEach(function (k) {
      var b = mk("button", "limTog", "☐ " + k[1], row);
      b.addEventListener("click", function () { toggleLimit(k[0]); });
      refs.limitBtns[k[0]] = b;
    });
  }

  function toggleLimit(key) {
    var nick = refs.selNick;
    if (!nick) {
      syncLimitVars();
      setNetStatus("아래 목록에서 제약을 걸 플레이어를 먼저 선택해 주세요.");
      return;
    }
    var d = st.limits.get(nick) || {};
    if (!d[key]) d[key] = true;
    else delete d[key];
    if (Object.keys(d).length) st.limits.set(nick, d);
    else st.limits.delete(nick);
    pushRulesInfo();
    refreshWaiting();
  }

  function syncLimitVars() {
    var bs = refs.limitBtns;
    if (!bs) return;
    var cur = refs.selNick ? st.limits.get(refs.selNick) || {} : {};
    LIMIT_KEYS.forEach(function (k) {
      var on = !!cur[k[0]];
      bs[k[0]].textContent = (on ? "☑ " : "☐ ") + k[1];
      bs[k[0]].classList.toggle("on", on);
    });
    if (refs.selLbl) refs.selLbl.textContent = refs.selNick ? "선택: " + refs.selNick : "선택한 플레이어 없음";
  }

  function hostStart() {
    if (!applyRulesEntries()) return;
    var ids = new Set((st.players.length ? st.players : net.players).map(function (p) { return p.id; }));
    var lim = {};
    st.limits.forEach(function (d, n) {
      if (ids.has(n)) Object.defineProperty(lim, n, { value: d, enumerable: true, writable: true, configurable: true });
    });
    var res = net.startGame(settings.multi_rules, lim);
    if (!res.ok) {
      setNetStatus("⚠ 시작할 수 없어요: " + res.err);
      if (refs.status) { refs.status.classList.remove("flash"); void refs.status.offsetWidth; refs.status.classList.add("flash"); }
    }
  }

  function leaveWaiting() {
    st.roomRulesSet = false;
    net.leave();
    openLobby();
  }

  // ---------------- room code copy / share ----------------
  function shareLink() {
    var loc = global.location;
    return loc.origin + loc.pathname + "?join=" + net.code +
      (brokerOverride ? "&broker=" + encodeURIComponent(brokerOverride) : "");
  }
  function copyText(text, done) {
    var fallback = function () {
      var ta = mk("textarea", null, null, doc.body);
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      ta.select();
      var ok = false;
      try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      done(ok);
    };
    var nav = global.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }
  function copyCode() {
    var code = net.code;
    copyText("NEON TETRIS 방 코드: " + code + "\n" + shareLink(), function (ok) {
      setNetStatus(ok ? "방 코드를 복사했어요: " + code : "복사하지 못했어요. 방 코드 " + code + " 를 직접 알려 주세요.");
    });
  }
  function shareCode() {
    var nav = global.navigator;
    try {
      nav.share({ title: "NEON TETRIS 대전", text: "NEON TETRIS 방 코드: " + net.code, url: shareLink() })
        .catch(function () { /* cancelled */ });
    } catch (e) { copyCode(); }
  }

  // ==========================================================
  // 대전 진행 (begin_multiplayer ...)
  // ==========================================================
  /** 내가 아직 살아서 대전 중인가 */
  function inMatch() {
    var r = runner();
    return !!(r && r.mode === "multi" && st.netInMatch && !r.game_over);
  }

  function idleText() {
    var t = "게임 진행 중", l = limitLabels(st.matchLimits);
    return l ? t + " · 🚫 " + l : t;
  }

  /** 모두가 같은 시드 + 같은 공격 규칙으로 동시에 시작 (공정함) */
  function beginMultiplayer(seed, ids, rules, limits) {
    st.matchRules = NT.sanitizeRules(rules);
    st.matchLimits = getLim(NT.sanitizeLimits(limits), me()) || {};
    st.matchIds = ids.slice();
    st.deadIds = new Set();
    st.aliveNow = ids.length;
    st.targetMode = "RANDOM";
    st.lastAttacker = null;
    st.matchResult = null;
    st.netInMatch = true;
    st.specTarget = null;
    st.specData = null;
    st.lastSnap = null;
    var r = UI.startGame({ mode: "multi", seed: seed, rules: st.matchRules, limits: st.matchLimits });
    r.idle_text = idleText();
    r.match_result = null;
    updateAlive();
    updateModeWidgets();
    specEnsure();
    clearTimeout(st.boardTimer);
    st.boardTimer = setTimeout(boardLoop, 200);
  }

  function updateAlive() {
    var r = runner();
    if (r && r.mode === "multi") { r.alive_text = st.aliveNow + "/" + st.matchIds.length; dirty(); }
  }

  function aliveOthers() {
    var mine = me();
    return st.matchIds.filter(function (p) { return p !== mine && !st.deadIds.has(p); });
  }

  function resolveTarget() {
    var others = aliveOthers();
    if (st.targetMode === "COUNTER") return others.indexOf(st.lastAttacker) >= 0 ? st.lastAttacker : "RANDOM";
    return others.indexOf(st.targetMode) >= 0 ? st.targetMode : "RANDOM";
  }

  function cycleTarget() {
    if (!isMulti()) return;
    var options = ["RANDOM", "COUNTER"].concat(aliveOthers());
    var cur = options.indexOf(st.targetMode) >= 0 ? st.targetMode : "RANDOM";
    st.targetMode = options[(options.indexOf(cur) + 1) % options.length];
    updateTargetButton();
    setStatus("🎯 공격 대상: " + st.targetMode);
  }

  var TARGET_NAMES = { RANDOM: "무작위", COUNTER: "반격" };
  function updateTargetButton() {
    var b = doc.getElementById("bTarget");
    if (!b) return;
    b.textContent = "🎯 " + (hasOwn(TARGET_NAMES, st.targetMode) ? TARGET_NAMES[st.targetMode] : st.targetMode);
    mk("small", null, st.targetMode === "COUNTER" ? "나를 공격한 사람" : "공격 대상 (Tab)", b);
  }

  /** update_mode_widgets: the spectate panel + 🎯 button only in versus */
  function updateModeWidgets() {
    var m = isMulti();
    doc.getElementById("app").classList.toggle("multi-on", m);
    var p = doc.getElementById("bPause");
    if (p) p.innerHTML = m ? "☰<small>메뉴 · 나가기</small>" : "Ⅱ<small>일시정지</small>";
    if (UI.spec.visible !== m) UI.spec.show(m);
    if (m) { updateTargetButton(); drawSpec(); }
  }

  /** 공격 전송 / 알림 (after_lock_multi; 상쇄 / 방해줄 메시지와 garbage 소리는 GameRunner.after_lock) */
  function afterLockMulti(o, r) {
    if (o.attack > 0 && st.netInMatch) {
      var target = resolveTarget();
      net.sendAttack(target, o.attack);
      o.msgs.push("💥 " + o.attack + "줄 공격 → " + (target !== "RANDOM" ? target : "무작위"));
      UI.play("attack");
      r.status = o.msgs.join(" · ");
      dirty();
    }
  }

  // ---------------- 상대 화면 보기 (spectate panel) ----------------
  /** 보고 있는 상대가 없거나 탈락했으면 살아 있는 다른 사람으로 자동 변경 */
  function specEnsure() {
    if (!isMulti()) return;
    var others = aliveOthers();
    if (others.length && others.indexOf(st.specTarget) < 0) setSpec(others[0]);
    else drawSpec();
  }

  function setSpec(nick) {
    st.specTarget = nick;
    st.specData = null;
    net.setWatch(nick);
    drawSpec();
  }

  function cycleSpec(step) {
    if (!isMulti()) return;
    var others = aliveOthers();
    if (!others.length) return;
    var i = others.indexOf(st.specTarget);
    if (i < 0) i = -step;
    var n = others.length;
    setSpec(others[(((i + step) % n) + n) % n]);
  }

  /** draw_spec: board + falling piece + incoming gauge (the opponent's score is not shown) */
  function drawSpec() {
    if (!isMulti()) return;
    var others = aliveOthers(), i = others.indexOf(st.specTarget);
    UI.spec.set(st.specData, st.specTarget || "", i + 1, i >= 0 ? others.length : 0);
  }

  // ---------------- 내 화면 전송 (board_loop / send_board_now) ----------------
  function snapshot() {
    var r = runner();
    return r ? r.core.board_snapshot() : null;
  }
  function sendBoardNow() {
    var snap = snapshot();
    if (snap && net.connected) {
      st.lastSnap = JSON.stringify(snap);
      net.sendBoard(snap);
    }
  }
  /** 내 화면을 0.2초마다 (바뀐 경우에만) 방장에게 전송 → 방장이 나를 보는 사람에게 전달 */
  function boardLoop() {
    st.boardTimer = null;
    if (!isMulti() || !net.connected) return;
    var snap = snapshot(), key = JSON.stringify(snap);
    if (key !== st.lastSnap) {
      st.lastSnap = key;
      net.sendBoard(snap);
    }
    if (st.netInMatch) st.boardTimer = setTimeout(boardLoop, 200);
  }

  // ---------------- 탈락 / 승리 / 결과 ----------------
  /** end_game (multi part): 마지막 화면 전송 + 탈락 보고 */
  function onEliminatedSelf(r) {
    sendBoardNow();
    net.reportDead();
    r.status = "💀 탈락! (남은 " + Math.max(0, st.aliveNow - 1) + "명 / 결과를 기다리는 중)";
    dirty();
  }

  function resultFor(ev) {
    var rank = ev.ranking || [], pos = rank.indexOf(me());
    return { won: ev.winner === me(), text: (pos >= 0 ? pos + 1 : "-") + "위 / " + rank.length + "명" };
  }

  /** 마지막 생존자: 승리 처리 */
  function finishMultiWin(ranking) {
    var r = runner();
    r.game_over = true;
    r.core.active = false;
    r.cancel_timers();
    r.stop_repeat();
    r.animating = false;
    r.clearing = [];
    r.clock.stop();
    r.clock_locked = true;
    r.match_result = resultFor(st.matchResult);
    var summary = UI.finalizeGame("win");
    if (summary) {
      summary.ranking = ranking;
      summary.rank = 1;
    }
    r.status = "🏆 승리! 마지막 생존자예요!";
    UI.play("record");
    UI.fx.record(UI.cell, UI.theme);
    UI.setTrack(null);
    dirty();
    UI.scheduleResults(3000);
  }

  function handleMatchResult(ev) {
    st.netInMatch = false;
    st.matchResult = ev;
    var ranking = ev.ranking || [];
    var r = runner();
    if (ev.winner === me() && r && !r.game_over) {
      finishMultiWin(ranking);
      return;
    }
    var s = UI.lastSummary;
    if (s && s.mode === "multi") {
      s.ranking = ranking;
      var pos = ranking.indexOf(me());
      s.rank = pos >= 0 ? pos + 1 : null;
    }
    if (r && r.mode === "multi") r.match_result = resultFor(ev);
    setStatus("대전 종료! 우승: " + (ev.winner === null || ev.winner === undefined ? "없음" : ev.winner));
    if (UI.screen === "game") UI.scheduleResults(1200);
  }

  /** 대전/방 나가기. 아직 살아 있으면 탈락 처리 후 연결 종료 */
  function leaveMatch() {
    var r = runner();
    if (isMulti() && st.netInMatch && !r.game_over) r.end_game();
    st.netInMatch = false;
    clearTimeout(st.boardTimer);
    st.boardTimer = null;
    net.leave();
  }

  // ==========================================================
  // hooks into ui_v5.4.js / core runner events
  // ==========================================================
  UI.on("newgame", function () { updateModeWidgets(); });
  UI.on("outcome", function (o, r) { if (r === runner() && r.mode === "multi") afterLockMulti(o, r); });
  UI.on("gameover", function (r) { if (r === runner() && r.mode === "multi") onEliminatedSelf(r); });

  UI.openMulti = function () { openLobby(); };
  /** go_menu: leaving the game screen with ☰ leaves the match / room */
  UI.onGameMenu = function () {
    if (isMulti() && (net.connected || st.netInMatch)) leaveMatch();
  };
  /** play_again: 대전은 대기실로 돌아가 다시 준비 */
  UI.onMultiAgain = function () {
    if (net.connected) openWaiting();
    else openLobby();
  };
  UI.onTarget = cycleTarget;
  UI.onGameKey = function (key) {
    if (!isMulti()) return false;
    var r = runner();
    if (key === "tab") { if (!r.counting) cycleTarget(); return true; }
    if (key === "v" && Object.keys(settings.keys).every(function (a) { return settings.keys[a] !== "v"; })) {
      if (!r.counting) cycleSpec(1);
      return true;
    }
    return false;
  };
  UI.spec.onPrev = function () { cycleSpec(-1); };
  UI.spec.onNext = function () { cycleSpec(1); };
  doc.getElementById("specCv").addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (UI.screen === "game") cycleSpec(1);          // 상대 보드 탭 = 다음 상대
  });

  function start() {
    var m = /[?&]join=([A-Za-z0-9]{1,12})/.exec(global.location.search || "");
    if (m) openLobby("", m[1].toUpperCase().slice(0, 6));
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();

  NT.Multi = {
    get net() { return net; },
    state: st,
    brokerOverride: brokerOverride,
    openLobby: openLobby,
    openWaiting: openWaiting,
    refreshWaiting: refreshWaiting,
    applyRulePreset: applyRulePreset,
    toggleLimit: toggleLimit,
    selectPlayer: function (nick) { refs.selNick = nick; refreshWaiting(); },
    hostStart: hostStart,
    toggleReady: toggleReady,
    cycleTarget: cycleTarget,
    cycleSpec: cycleSpec,
    resolveTarget: resolveTarget,
    aliveOthers: aliveOthers,
    inMatch: inMatch,
    leaveMatch: leaveMatch,
    get refs() { return refs; }
  };
})(window);
