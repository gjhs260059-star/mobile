/*
 * NEON TETRIS v5.4-mobile — net_v5.4.js
 * ---------------------------------------------------------------
 * Browser port of tetris_net.py (v5.3) — multiplayer networking.
 *
 *  - Browsers cannot do UDP broadcast / raw TCP, so the desktop "로컬 대전"
 *    (UDP 9998 discovery + TCP 9999) is merged into the online room-code mode.
 *    startHost()/connect()/searchRooms()/localIp() remain as thin aliases.
 *  - Online protocol is byte-for-byte the same JSON as tetris_net.py:
 *      broker topics  {MQTT_ROOT}/{code}/h          (everyone -> host, every msg has "cid")
 *                     {MQTT_ROOT}/{code}/c/{cid}    (host -> one participant)
 *      client last-will on {root}/h = {"type":"LEAVE","cid":cid}
 *    NOTE: VERSION is "5.4-mobile", so desktop v5.3 clients/hosts are rejected by
 *    the JOIN version check ("버전이 달라요 ...") — intended.
 *  - Transport: built-in minimal MQTT 3.1.1 client over WebSocket (wss, subprotocol
 *    "mqtt"): CONNECT (+will, clean session, keepalive), SUBSCRIBE QoS0, PUBLISH QoS0,
 *    PINGREQ/PINGRESP, DISCONNECT, auto-reconnect with backoff (+ resubscribe / re-JOIN
 *    through onConnect). No external dependency.
 *  - Mobile: visibilitychange(visible) / pageshow / resume / online  -> immediate liveness
 *    check (PINGREQ, 6 s deadline) or immediate reconnect; keepalive 60 s so throttled
 *    background timers still keep the session; pagehide (real unload) -> leave().
 *  - All received JSON is untrusted: size caps, type checks, string caps, Map-based
 *    tables (no prototype keys), cid/topic charset check, attack lines clamped 0..20,
 *    boards must be 200 chars of 0-8 with integer fields.
 *
 * API:  window.NT.Net (singleton)  /  new NT.NetworkManager({transport, watchdogStepMs})
 *  Python (tetris_net.NetworkManager)         ->  JS (camelCase)
 *    net.events.get_nowait() / emit / flush   ->  net.poll() (null if empty) / net.emit(type, obj)
 *                                                 / net.flush() / net.events (array) / net.on(fn) / net.off(fn)
 *    nickname, session                        ->  nickname, session
 *    is_host, connected, is_ready, in_game    ->  isHost, connected, isReady, inGame
 *    room_name, online, code, cid, topic_root ->  roomName, online, code, cid, topicRoot
 *    players [{id,ready,is_host}], alive(set) ->  players (same objects), alive (Set), aliveList()
 *    dead_order, rules_info, watch, host_watch, last_board, clients, cids
 *                                             ->  deadOrder, rulesInfo, watch(Map), hostWatch, lastBoard(Map),
 *                                                 clients(Map nick->{cid,ready}), cids(Map cid->nick)
 *    start_online_host(name) -> (ok, msg)     ->  startOnlineHost(name) -> {ok, err}   (code in net.code)
 *    connect_online(code)                     ->  connectOnline(code)  (events: CONNECTED/JOIN_FAIL/STATUS/DISCONNECTED)
 *    start_host(name) / connect(ip)           ->  startHost(name) / connect(code)   (aliases of the online ones)
 *    search_rooms() / local_ip()              ->  searchRooms() (emits ROOMS {rooms: []}) / localIp() ("")
 *    toggle_ready() -> bool                   ->  toggleReady() -> bool
 *    check_all_ready() -> [names]             ->  checkAllReady() -> [names]
 *    start_game(rules, limits) -> (ok, msg)   ->  startGame(rules, limits) -> {ok, err}
 *    set_rules_info(rules, limits)            ->  setRulesInfo(rules, limits)
 *    send_attack(target, lines)               ->  sendAttack(target, lines)
 *    report_dead()                            ->  reportDead()
 *    send_board(snap tuple)                   ->  sendBoard([b, pi, r, x, y, sc, ln, inc])  (or object with those keys)
 *    set_watch(target)                        ->  setWatch(target)
 *    leave()                                  ->  leave()
 *    route_attack / mark_dead / route_board / set_client_watch / broadcast / send_client
 *                                             ->  routeAttack / markDead / routeBoard / setClientWatch / broadcast / sendClient
 *    (new) linkUp — true while the MQTT link to the broker is up.
 *  Events (objects with .type, same fields as Python):
 *    STATUS{text} CONNECTED{ip(=code)} DISCONNECTED{reason} JOIN_FAIL{reason} PLAYER_LIST{list}
 *    RULES{rules,limits} START{seed,players,rules,limits} ATTACK{from,lines} ELIMINATED{id,left}
 *    RESULT{winner,ranking} BOARD{id,b,pi,r,x,y,sc,ln,inc} ROOM_CLOSED{} ROOMS{rooms}
 */
(function (global) {
  "use strict";

  var NT = global.NT || (global.NT = {});

  // ----- [설정] ---------------------------------------------------------
  var MQTT_BROKER = "broker.hivemq.com";
  var MQTT_WS_PORT = 8884;          // 8884 = WebSocket + TLS (wss). 8000 = 암호화 없는 ws
  var MQTT_WS_PATH = "/mqtt";
  var MQTT_TLS = true;              // true -> wss://, false -> ws://
  var MQTT_KEEPALIVE = 60;          // 초. 모바일 백그라운드 타이머 지연을 견디도록 데스크톱(30)보다 길게
  var MQTT_ROOT = "neontetris_online_v1";
  // ---------------------------------------------------------------------
  var VERSION = "5.4-mobile";       // 방장/참가자 버전이 다르면 입장 거절 (데스크톱 v5.3 과는 접속 안 됨)

  var MAX_PLAYERS = 40;
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var BOARD_KEYS = ["b", "pi", "r", "x", "y", "sc", "ln", "inc"];
  var BOARD_W = 10, BOARD_H = 20;
  var MAX_ATTACK_LINES = 20;        // 한 번에 받을 수 있는 공격 줄 수 상한 (= 보드 높이)
  var NICK_MAX = 20;
  var HOST_IN_MAX = 8 * 1024;       // 방장이 받는 메시지 최대 크기 (바이트, 대략)
  var CLIENT_IN_MAX = 128 * 1024;   // 참가자가 받는 메시지 최대 크기 (START/RULES 에 limits 포함)
  var EVENT_QUEUE_MAX = 2000;
  var JOIN_WAIT_STEPS = 24;         // 0.5초 x 24 = 약 12초
  var CID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  var BOARD_RE = new RegExp("^[0-8]{" + (BOARD_W * BOARD_H) + "}$");
  // 보드 숫자 필드 범위 (정수만, 벗어나면 잘라냄)
  var BOARD_RANGES = { pi: [-1, 6], r: [0, 3], x: [-4, BOARD_W + 4], y: [-4, BOARD_H + 4],
                       sc: [0, 1e12], ln: [0, 1e9], inc: [0, 999] };

  function brokerUrl() {
    return (MQTT_TLS ? "wss://" : "ws://") + MQTT_BROKER + ":" + MQTT_WS_PORT + MQTT_WS_PATH;
  }

  // ==========================================================
  // small helpers
  // ==========================================================
  function rand01() { return Math.random(); }
  function randHex(n) {
    var s = "", hex = "abcdef0123456789";
    var c = global.crypto;
    if (c && c.getRandomValues) {
      var a = new Uint8Array(n);
      c.getRandomValues(a);
      for (var i = 0; i < n; i++) s += hex.charAt(a[i] & 15);
      return s;
    }
    for (var j = 0; j < n; j++) s += hex.charAt(Math.floor(rand01() * 16));
    return s;
  }
  function randU32() {
    var c = global.crypto;
    if (c && c.getRandomValues) { var a = new Uint32Array(1); c.getRandomValues(a); return a[0] >>> 0; }
    return Math.floor(rand01() * 4294967296) >>> 0;
  }
  function choice(arr) { return arr[Math.floor(rand01() * arr.length) % arr.length]; }
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Python str(x).strip()[:n] for untrusted strings: only strings / finite numbers accepted. */
  function cleanStr(v, n) {
    if (typeof v === "number" && isFinite(v)) v = String(v);
    if (typeof v !== "string") return "";
    v = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
    var cps = Array.from(v);
    return cps.length > n ? cps.slice(0, n).join("") : v;
  }
  function cleanNick(v) { return cleanStr(v, NICK_MAX); }
  /** a target / id field: string nick or null */
  function cleanTarget(v) {
    var s = cleanNick(v);
    return s ? s : null;
  }
  /** Python int(x): numbers truncate, numeric strings parse; otherwise NaN */
  function toInt(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && /^\s*[-+]?\d{1,12}\s*$/.test(v)) return parseInt(v, 10);
    if (typeof v === "number" && isFinite(v)) return Math.trunc(v);
    return NaN;
  }
  function clampLines(v) {
    var n = toInt(v);
    return isNaN(n) ? 0 : clamp(n, 0, MAX_ATTACK_LINES);
  }
  function parseJson(payload, maxLen) {
    if (typeof payload !== "string" || payload.length > maxLen) return null;
    try {
      var m = JSON.parse(payload);
      return isObj(m) ? m : null;
    } catch (e) { return null; }
  }
  /** BOARD snapshot: "b" must be 200 chars of 0-8, other keys integers (clamped). null if invalid */
  function sanitizeBoard(msg) {
    if (!isObj(msg) || typeof msg.b !== "string" || !BOARD_RE.test(msg.b)) return null;
    var d = { b: msg.b };
    for (var i = 1; i < BOARD_KEYS.length; i++) {
      var k = BOARD_KEYS[i];
      if (!hasOwn(msg, k)) continue;
      var v = msg[k];
      if (typeof v === "number" && Number.isInteger(v)) d[k] = clamp(v, BOARD_RANGES[k][0], BOARD_RANGES[k][1]);
    }
    return d;
  }
  function sanitizeNameList(v, max) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length && out.length < max; i++) {
      var s = cleanNick(v[i]);
      if (s) out.push(s);
    }
    return out;
  }
  function sanitizePlayerList(v) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length && out.length < MAX_PLAYERS; i++) {
      var p = v[i];
      if (!isObj(p)) continue;
      var id = cleanNick(p.id);
      if (!id) continue;
      out.push({ id: id, ready: p.ready === true, is_host: p.is_host === true });
    }
    return out;
  }
  /** rules / limits are JSON objects; the UI sanitizes their contents (sanitize_rules / sanitize_limits) */
  function plainOrNull(v) { return isObj(v) ? v : null; }

  // ==========================================================
  // Minimal MQTT 3.1.1 over WebSocket
  // ==========================================================
  var MQTT_MAX_PACKET = 256 * 1024;
  var BACKOFF = [1000, 2000, 4000, 8000, 15000];
  var CONNACK_TIMEOUT = 10000;
  var CHECK_TIMEOUT = 6000;

  var te = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var td = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
  function utf8(s) {
    if (te) return Array.prototype.slice.call(te.encode(s));
    var out = [], str = unescape(encodeURIComponent(s));
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
    return out;
  }
  function fromUtf8(bytes) {
    if (td) return td.decode(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return ""; }
  }
  function mqStr(s) {
    var b = utf8(s);
    return [(b.length >> 8) & 255, b.length & 255].concat(b);
  }
  function varLen(n) {
    var out = [];
    do {
      var d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 128;
      out.push(d);
    } while (n > 0);
    return out;
  }
  function packet(first, body) {
    return new Uint8Array([first].concat(varLen(body.length), body));
  }
  var Codec = {
    connect: function (clientId, keepalive, will) {
      var flags = 0x02;                                   // clean session
      if (will) flags |= 0x04;                            // will flag, will QoS 0, no retain
      var body = mqStr("MQTT").concat([4, flags, (keepalive >> 8) & 255, keepalive & 255], mqStr(clientId));
      if (will) body = body.concat(mqStr(will.topic), mqStr(will.payload));
      return packet(0x10, body);
    },
    subscribe: function (pid, topic) {
      return packet(0x82, [(pid >> 8) & 255, pid & 255].concat(mqStr(topic), [0]));
    },
    publish: function (topic, payload) {
      return packet(0x30, mqStr(topic).concat(utf8(payload)));
    },
    ack: function (first, pid) { return new Uint8Array([first, 2, (pid >> 8) & 255, pid & 255]); },
    pingreq: function () { return new Uint8Array([0xC0, 0]); },
    disconnect: function () { return new Uint8Array([0xE0, 0]); },
    /** incremental parser: push(bytes) -> array of {type, flags, body} ; throws on oversize */
    Parser: function () {
      var buf = new Uint8Array(0);
      this.push = function (chunk) {
        var nb = new Uint8Array(buf.length + chunk.length);
        nb.set(buf, 0); nb.set(chunk, buf.length);
        buf = nb;
        var out = [];
        for (;;) {
          if (buf.length < 2) break;
          var len = 0, mul = 1, i = 1, done = false;
          while (i < buf.length && i <= 4) {
            var d = buf[i++];
            len += (d & 127) * mul;
            mul *= 128;
            if (!(d & 128)) { done = true; break; }
          }
          if (!done) {
            if (i > 4) throw new Error("bad remaining length");
            break;
          }
          if (len > MQTT_MAX_PACKET) throw new Error("packet too large");
          if (buf.length < i + len) break;
          out.push({ type: buf[0] >> 4, flags: buf[0] & 15, body: buf.subarray(i, i + len) });
          buf = buf.slice(i + len);
        }
        return out;
      };
    },
    parsePublish: function (flags, body) {
      var tl = (body[0] << 8) | body[1];
      var topic = fromUtf8(body.subarray(2, 2 + tl));
      var p = 2 + tl, qos = (flags >> 1) & 3, pid = 0;
      if (qos > 0) { pid = (body[p] << 8) | body[p + 1]; p += 2; }
      return { topic: topic, qos: qos, pid: pid, payload: fromUtf8(body.subarray(p)) };
    }
  };

  /**
   * opts: { url, clientId, keepalive, will:{topic,payload}|null,
   *         onConnect(), onMessage(topic, payloadStr), onLink(up, reason), WebSocket? }
   * Methods: start(), publish(topic, str)->bool, subscribe(topic)->bool, end(), kick(), isUp()
   */
  function MiniMqtt(opts) {
    this.o = opts;
    this.WS = opts.WebSocket || global.WebSocket;
    if (!this.WS) throw new Error("이 브라우저는 WebSocket 을 지원하지 않아요");
    this.state = "idle";       // idle | opening | waitack | up | closed
    this.ws = null;
    this.tries = 0;
    this.pid = 0;
    this.timers = {};
    this.lastSent = 0;
    this.pingAt = 0;
  }
  var MP = MiniMqtt.prototype;
  MP._call = function (name) {
    var f = this.o[name];
    if (typeof f !== "function") return;
    try { f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) {
      if (global.console) global.console.error("[net] " + name + " handler error", e);
    }
  };
  MP._clear = function (name) {
    var t = this.timers[name];
    if (t) { clearTimeout(t); clearInterval(t); }
    this.timers[name] = null;
  };
  MP.isUp = function () { return this.state === "up"; };
  MP.start = function () {
    if (this.state === "closed" || this.ws) return;
    this._clear("retry");
    var self = this, ws;
    try {
      ws = new this.WS(this.o.url, ["mqtt"]);
    } catch (e) {
      this._drop("ws: " + (e && e.message || e));
      return;
    }
    this.ws = ws;
    this.state = "opening";
    this.parser = new Codec.Parser();
    try { ws.binaryType = "arraybuffer"; } catch (e) { /* ignore */ }
    ws.onopen = function () {
      if (self.ws !== ws) return;
      self.state = "waitack";
      self._send(Codec.connect(self.o.clientId, self.o.keepalive || MQTT_KEEPALIVE, self.o.will || null));
    };
    ws.onmessage = function (ev) {
      if (self.ws !== ws) return;
      var d = ev.data;
      var tag = Object.prototype.toString.call(d);          // realm-safe type checks
      if (tag === "[object ArrayBuffer]") self._feed(new Uint8Array(d));
      else if (d && ArrayBuffer.isView(d)) self._feed(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      else if (d && typeof d.arrayBuffer === "function") {           // Blob fallback
        d.arrayBuffer().then(function (ab) { if (self.ws === ws) self._feed(new Uint8Array(ab)); });
      }
    };
    ws.onerror = function () { if (self.ws === ws) self._drop("error"); };
    ws.onclose = function () { if (self.ws === ws) self._drop("closed"); };
    this.timers.connack = setTimeout(function () { if (self.ws === ws) self._drop("timeout"); }, CONNACK_TIMEOUT);
  };
  MP._send = function (bytes) {
    var ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(bytes); this.lastSent = Date.now(); return true; } catch (e) { return false; }
  };
  MP._feed = function (chunk) {
    var pkts;
    try { pkts = this.parser.push(chunk); } catch (e) { this._drop("protocol"); return; }
    for (var i = 0; i < pkts.length && this.ws; i++) this._handle(pkts[i]);
  };
  MP._handle = function (p) {
    var self = this;
    if (p.type === 2) {                                   // CONNACK
      this._clear("connack");
      if (p.body.length < 2 || p.body[1] !== 0) { this._drop("refused " + (p.body[1] | 0)); return; }
      this.state = "up";
      this.tries = 0;
      this.pingAt = 0;
      var ka = (this.o.keepalive || MQTT_KEEPALIVE) * 1000;
      this._clear("ka");
      this.timers.ka = setInterval(function () { self._keepalive(ka); }, Math.min(ka / 4, 15000));
      this._call("onLink", true, "");
      this._call("onConnect");
    } else if (p.type === 3) {                            // PUBLISH
      if (this.state !== "up" || p.body.length < 2) return;
      var m;
      try { m = Codec.parsePublish(p.flags, p.body); } catch (e) { return; }
      if (m.qos === 1) this._send(Codec.ack(0x40, m.pid));          // PUBACK
      else if (m.qos === 2) this._send(Codec.ack(0x50, m.pid));     // PUBREC
      this._call("onMessage", m.topic, m.payload);
    } else if (p.type === 6 && p.body.length >= 2) {      // PUBREL -> PUBCOMP
      this._send(Codec.ack(0x70, (p.body[0] << 8) | p.body[1]));
    } else if (p.type === 13) {                           // PINGRESP
      this.pingAt = 0;
      this._clear("check");
    }
    // SUBACK(9) and others: nothing to do
  };
  MP._keepalive = function (ka) {
    if (this.state !== "up") return;
    var now = Date.now();
    if (this.pingAt && now - this.pingAt > ka) { this._drop("ping timeout"); return; }
    if (!this.pingAt && now - this.lastSent >= ka / 2) {
      if (this._send(Codec.pingreq())) this.pingAt = now;
    }
  };
  MP.publish = function (topic, payload) {
    if (this.state !== "up") return false;
    return this._send(Codec.publish(topic, payload));
  };
  MP.subscribe = function (topic) {
    if (this.state !== "up") return false;
    this.pid = this.pid % 65535 + 1;
    return this._send(Codec.subscribe(this.pid, topic));
  };
  /** mobile: page came back / network changed -> verify the link now or reconnect now */
  MP.kick = function () {
    var self = this;
    if (this.state === "closed") return;
    if (this.state === "idle") { this.tries = 0; this.start(); return; }
    if (this.state !== "up" || this.timers.check) return;
    if (!this._send(Codec.pingreq())) { this._drop("send"); return; }
    this.pingAt = Date.now();
    this.timers.check = setTimeout(function () {
      self.timers.check = null;
      if (self.pingAt) self._drop("stale");
    }, CHECK_TIMEOUT);
  };
  MP._drop = function (reason) {
    var ws = this.ws, wasUp = this.state === "up";
    this.ws = null;
    this._clear("connack"); this._clear("ka"); this._clear("check");
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    if (this.state === "closed") return;
    this.state = "idle";
    if (wasUp) this._call("onLink", false, reason);
    var self = this, delay = BACKOFF[Math.min(this.tries, BACKOFF.length - 1)];
    this.tries++;
    this._clear("retry");
    this.timers.retry = setTimeout(function () { self.timers.retry = null; self.start(); }, delay);
  };
  /** graceful close: DISCONNECT (no will) after already-queued publishes, then close */
  MP.end = function (immediate) {
    var ws = this.ws;
    this.state = "closed";
    this.ws = null;
    for (var k in this.timers) if (hasOwn(this.timers, k)) this._clear(k);
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState === 1) {
      try { ws.send(Codec.disconnect()); } catch (e) { /* ignore */ }
    }
    var fin = function () { try { ws.close(); } catch (e) { /* ignore */ } };
    if (immediate) fin(); else setTimeout(fin, 150);
  };

  function defaultTransport(opts) { return new MiniMqtt(opts); }

  // ==========================================================
  // NetworkManager (tetris_net.py NetworkManager, online mode)
  // ==========================================================
  function NetworkManager(opts) {
    opts = opts || {};
    this._transport = opts.transport || defaultTransport;
    this._stepMs = opts.watchdogStepMs || 500;
    this._listeners = [];
    this.events = [];
    this.nickname = "Player_" + (100 + Math.floor(rand01() * 900));
    this.session = 0;
    this.reset();
  }
  var NP = NetworkManager.prototype;

  NP.reset = function () {
    this.isHost = false;
    this.connected = false;
    this.isReady = false;
    this.inGame = false;
    this.roomName = "";
    this.clients = new Map();       // 방장 전용 nick -> {cid, ready}
    this.players = [];              // [{id, ready, is_host}]
    this.alive = new Set();
    this.deadOrder = [];
    this.online = false;
    this.mq = null;
    this.code = "";
    this.cid = "";
    this.topicRoot = "";
    this.cids = new Map();          // 방장 전용 cid -> nick
    this.rulesInfo = null;          // 방장 전용 {rules, limits}
    this.watch = new Map();         // 방장 전용 관전자 -> 보고 있는 사람
    this.hostWatch = null;
    this.lastBoard = new Map();     // 방장 전용 nick -> 마지막 보드
    this.linkUp = false;
  };

  // ---------------- events ----------------
  NP.emit = function (kind, kw) {
    var ev = {};
    if (kw) for (var k in kw) if (hasOwn(kw, k)) ev[k] = kw[k];
    ev.type = kind;
    this.events.push(ev);
    if (this.events.length > EVENT_QUEUE_MAX) this.events.splice(0, this.events.length - EVENT_QUEUE_MAX);
    for (var i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](ev); } catch (e) {
        if (global.console) global.console.error("[net] listener error", e);
      }
    }
  };
  NP.poll = function () { return this.events.length ? this.events.shift() : null; };
  NP.flush = function () { this.events.length = 0; };
  NP.on = function (fn) { if (typeof fn === "function") this._listeners.push(fn); return fn; };
  NP.off = function (fn) { this._listeners = this._listeners.filter(function (f) { return f !== fn; }); };
  NP.aliveList = function () { return Array.from(this.alive); };

  // ---------------- transport glue ----------------
  NP._mqPublish = function (topic, data) {
    var mq = this.mq;
    if (!mq) return;
    try { mq.publish(topic, typeof data === "string" ? data : JSON.stringify(data)); } catch (e) { /* ignore */ }
  };
  NP._send = function (peer, data) {
    if (peer && peer.cid) this._mqPublish(this.topicRoot + "/c/" + peer.cid, data);
  };
  NP.broadcast = function (data) {
    var s = JSON.stringify(data), self = this;
    this.clients.forEach(function (info) { self._mqPublish(self.topicRoot + "/c/" + info.cid, s); });
  };
  NP._linkHandler = function (sid) {
    var self = this;
    return function (up) {
      if (sid !== self.session) return;
      var was = self.linkUp;
      self.linkUp = !!up;
      if (was && !up) self.emit("STATUS", { text: "온라인 서버 연결이 끊겨 다시 연결하는 중..." });
    };
  };

  // ---------------- 방장(Host) ----------------
  NP.newCode = function () {
    var s = "";
    for (var i = 0; i < 6; i++) s += choice(CODE_CHARS);
    return s;
  };

  NP.startOnlineHost = function (roomName) {
    this.leave();
    var code = this.newCode();
    this.session++;
    var sid = this.session;
    this.reset();
    var root = MQTT_ROOT + "/" + code, self = this, c;
    try {
      c = this._transport({
        url: brokerUrl(), clientId: "nth" + randHex(16), keepalive: MQTT_KEEPALIVE, will: null,
        onConnect: function () { if (sid === self.session && self.mq === c) c.subscribe(root + "/h"); },
        onMessage: function (topic, payload) { self._hostOnlineMsg(sid, topic, payload); },
        onLink: this._linkHandler(sid)
      });
    } catch (e) {
      return { ok: false, err: "온라인 서버 연결 실패: " + (e && e.message || e) };
    }
    this.isHost = true;
    this.connected = true;
    this.isReady = true;
    this.online = true;
    this.roomName = cleanStr(roomName, 40);
    this.code = code;
    this.topicRoot = root;
    this.mq = c;
    try { c.start(); } catch (e) {
      this.leave();
      return { ok: false, err: "온라인 서버 연결 실패: " + (e && e.message || e) };
    }
    this._updatePlayers();
    return { ok: true, err: "" };
  };
  NP.startHost = NP.startOnlineHost;

  NP._updatePlayers = function () {
    var list = [{ id: this.nickname, ready: true, is_host: true }];
    this.clients.forEach(function (info, nick) { list.push({ id: nick, ready: info.ready, is_host: false }); });
    this.players = list;
    var plist = list.map(function (p) { return { id: p.id, ready: p.ready, is_host: p.is_host }; });
    this.broadcast({ type: "PLAYER_LIST", list: plist });
    if (this.rulesInfo) this.broadcast({ rules: this.rulesInfo.rules, limits: this.rulesInfo.limits, type: "RULES" });
    this.emit("PLAYER_LIST", { list: plist });
  };

  NP.setRulesInfo = function (rules, limits) {
    if (!this.isHost) return;
    this.rulesInfo = { rules: rules, limits: limits };
    this.broadcast({ rules: rules, limits: limits, type: "RULES" });
  };

  NP._joinError = function (nick, ver) {
    return ver !== VERSION ? "버전이 달라요 (방장 v" + VERSION + "). 같은 버전으로 맞춰 주세요" :
      !nick ? "닉네임이 비어 있어요" :
      (this.clients.has(nick) || nick === this.nickname) ? "이미 같은 닉네임이 있어요" :
      this.inGame ? "이미 게임이 진행 중이에요" :
      this.clients.size + 1 >= MAX_PLAYERS ? "방이 가득 찼어요" : "";
  };

  NP._hostOnlineMsg = function (sid, topic, payload) {
    if (!(this.connected && this.isHost && this.online && sid === this.session)) return;
    if (topic !== this.topicRoot + "/h") return;
    var msg = parseJson(payload, HOST_IN_MAX);
    if (!msg) return;
    var kind = msg.type;
    var cid = (typeof msg.cid === "string" || typeof msg.cid === "number") ? String(msg.cid).slice(0, 32) : "";
    if (!cid || !CID_RE.test(cid) || typeof kind !== "string") return;   // cid goes into a topic name
    if (kind === "JOIN") {
      var nick = cleanNick(msg.id), bad;
      if (this.cids.get(cid) === nick && this.clients.has(nick)) {
        bad = "";                                   // 재전송된 JOIN
      } else {
        bad = this._joinError(nick, msg.ver);
        if (!bad) {
          var old = this.cids.get(cid);             // 같은 cid 가 닉네임을 바꿔 다시 JOIN
          if (old !== undefined && this.clients.has(old) && this.clients.get(old).cid === cid) this.clients.delete(old);
          this.clients.set(nick, { cid: cid, ready: false });
          this.cids.set(cid, nick);
        }
      }
      if (bad) {
        this._mqPublish(this.topicRoot + "/c/" + cid, { type: "JOIN_FAIL", reason: bad });
        return;
      }
      this._updatePlayers();
      return;
    }
    var pid = this.cids.get(cid);
    if (pid === undefined) return;
    if (kind === "READY") {
      if (this.clients.has(pid)) this.clients.get(pid).ready = msg.ready === true;
      this._updatePlayers();
    } else if (kind === "ATTACK") {
      this.routeAttack(pid, cleanTarget(msg.target), clampLines(msg.lines));
    } else if (kind === "DEAD") {
      this.markDead(pid);
    } else if (kind === "BOARD") {
      this.routeBoard(pid, msg);
    } else if (kind === "WATCH") {
      this.setClientWatch(pid, cleanTarget(msg.target));
    } else if (kind === "LEAVE") {
      this.cids.delete(cid);
      var gone = this.clients.delete(pid);
      if (gone) {
        this.watch.delete(pid);
        if (this.inGame) this.markDead(pid);
        this._updatePlayers();
      }
    }
  };

  NP.checkAllReady = function () {
    var out = [];
    this.clients.forEach(function (info, nick) { if (!info.ready) out.push(nick); });
    return out;
  };

  NP.startGame = function (rules, limits) {
    if (!this.isHost) return { ok: false, err: "방장만 시작할 수 있어요" };
    if (!this.clients.size) return { ok: false, err: "상대가 한 명 이상 있어야 시작할 수 있어요" };
    var waiting = this.checkAllReady();
    if (waiting.length) return { ok: false, err: "아직 준비하지 않은 사람: " + waiting.join(", ") };
    if (rules === undefined) rules = null;
    if (limits === undefined) limits = null;
    var seed = randU32();
    var ids = [this.nickname].concat(Array.from(this.clients.keys()));
    this.alive = new Set(ids);
    this.deadOrder = [];
    this.inGame = true;
    this.watch.clear();
    this.hostWatch = null;
    this.lastBoard.clear();
    this.broadcast({ type: "START", seed: seed, players: ids, rules: rules, limits: limits });
    this.emit("START", { seed: seed, players: ids.slice(), rules: rules, limits: limits });
    return { ok: true, err: "" };
  };

  // ---------------- 공격 / 탈락 ----------------
  NP.routeAttack = function (sender, target, lines) {
    lines = clampLines(lines);
    if (lines <= 0 || !this.inGame) return;
    var valid = [];
    this.alive.forEach(function (p) { if (p !== sender) valid.push(p); });
    if (!valid.length) return;
    var dest = valid.indexOf(target) >= 0 ? target : choice(valid);
    if (dest === this.nickname) {
      this.emit("ATTACK", { from: sender, lines: lines });
    } else if (this.clients.has(dest)) {
      this._send(this.clients.get(dest), { type: "ATTACK", from: sender, lines: lines });
    }
  };

  NP.markDead = function (pid) {
    if (!this.inGame || !this.alive.has(pid)) return;
    this.alive.delete(pid);
    this.deadOrder.push(pid);
    var left = this.alive.size, finished = left <= 1;
    var winner = left ? this.alive.values().next().value : null;
    var ranking = (winner ? [winner] : []).concat(this.deadOrder.slice().reverse());
    if (finished) {
      this.inGame = false;
      this.clients.forEach(function (info) { info.ready = false; });   // 다음 판을 위해 준비 초기화
    }
    this.broadcast({ type: "ELIMINATED", id: pid, left: left });
    this.emit("ELIMINATED", { id: pid, left: left });
    if (finished) {
      this.broadcast({ winner: winner, ranking: ranking, type: "RESULT" });
      this.emit("RESULT", { winner: winner, ranking: ranking.slice() });
      this._updatePlayers();
    }
  };

  // ---------------- 관전 (상대 화면 보기) ----------------
  NP.routeBoard = function (sender, msg) {
    var data = sanitizeBoard(msg);
    if (!data || !this.inGame) return;
    this.lastBoard.set(sender, data);
    var self = this, payload = null;
    this.watch.forEach(function (t, n) {
      if (t !== sender || !self.clients.has(n)) return;
      if (!payload) {
        var o = {};
        for (var k in data) o[k] = data[k];
        o.type = "BOARD"; o.id = sender;
        payload = JSON.stringify(o);
      }
      self._send(self.clients.get(n), payload);
    });
    if (this.hostWatch === sender) this.emit("BOARD", Object.assign({ id: sender }, data));
  };

  NP.setClientWatch = function (pid, target) {
    this.watch.set(pid, target);
    var cached = target !== null ? this.lastBoard.get(target) : undefined;
    var peer = this.clients.get(pid);
    if (cached && peer) this._send(peer, Object.assign({}, cached, { type: "BOARD", id: target }));
  };

  NP.setWatch = function (target) {
    target = cleanTarget(target);
    if (this.isHost) {
      this.hostWatch = target;
      var cached = target !== null ? this.lastBoard.get(target) : undefined;
      if (cached) this.emit("BOARD", Object.assign({ id: target }, cached));
    } else {
      this.sendClient({ type: "WATCH", target: target });
    }
  };

  NP.sendBoard = function (snap) {
    var data = {};
    if (Array.isArray(snap)) {
      for (var i = 0; i < BOARD_KEYS.length && i < snap.length; i++) data[BOARD_KEYS[i]] = snap[i];
    } else if (isObj(snap)) {
      BOARD_KEYS.forEach(function (k) { if (hasOwn(snap, k)) data[k] = snap[k]; });
    } else return;
    if (this.isHost) this.routeBoard(this.nickname, data);
    else this.sendClient(Object.assign(data, { type: "BOARD" }));
  };

  NP.sendAttack = function (target, lines) {
    lines = clampLines(lines);
    if (this.isHost) this.routeAttack(this.nickname, target, lines);
    else this.sendClient({ type: "ATTACK", target: target === undefined ? null : target, lines: lines });
  };

  NP.reportDead = function () {
    if (this.isHost) this.markDead(this.nickname);
    else this.sendClient({ type: "DEAD" });
  };

  // ---------------- 참가자(Client) ----------------
  NP.sendClient = function (data) {
    if (!this.online || this.isHost) return;
    var d = {};
    for (var k in data) if (hasOwn(data, k)) d[k] = data[k];
    d.cid = this.cid;
    this._mqPublish(this.topicRoot + "/h", JSON.stringify(d));
  };

  NP.toggleReady = function () {
    this.isReady = !this.isReady;
    this.sendClient({ type: "READY", ready: this.isReady });
    return this.isReady;
  };

  NP.connectOnline = function (code) {
    this.leave();
    code = String(code == null ? "" : code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!code) {
      this.emit("STATUS", { text: "방 코드를 입력해 주세요." });
      return;
    }
    var cid = randHex(12);
    var root = MQTT_ROOT + "/" + code;
    this.session++;
    var sid = this.session, self = this, state = { joined: false }, c;
    this.reset();
    var join = function () { self.sendClient({ type: "JOIN", id: self.nickname, ver: VERSION }); };
    try {
      c = this._transport({
        url: brokerUrl(), clientId: "ntc" + cid + randHex(4), keepalive: MQTT_KEEPALIVE,
        will: { topic: root + "/h", payload: JSON.stringify({ type: "LEAVE", cid: cid }) },
        onConnect: function () {
          if (sid !== self.session || self.mq !== c) return;
          c.subscribe(root + "/c/" + cid);            // 재접속 때도 다시 구독 + JOIN 재전송
          join();
        },
        onMessage: function (topic, payload) {
          if (topic === root + "/c/" + cid) self._clientOnlineMsg(sid, state, code, payload);
        },
        onLink: this._linkHandler(sid)
      });
    } catch (e) {
      this.emit("STATUS", { text: "온라인 서버 연결 실패: " + (e && e.message || e) });
      this.emit("DISCONNECTED", { reason: "connect" });
      return;
    }
    this.online = true;
    this.connected = true;
    this.isHost = false;
    this.isReady = false;
    this.code = code;
    this.cid = cid;
    this.topicRoot = root;
    this.mq = c;
    try { c.start(); } catch (e) {
      this.emit("STATUS", { text: "온라인 서버 연결 실패: " + (e && e.message || e) });
      this.leave();
      this.emit("DISCONNECTED", { reason: "connect" });
      return;
    }
    // watchdog: 최대 약 12초 기다리며 3초마다 JOIN 재시도
    var step = 0, timer = setInterval(function () {
      if (sid !== self.session || state.joined) { clearInterval(timer); return; }
      if (step % 6 === 5 && self.connected) join();
      step++;
      if (step >= JOIN_WAIT_STEPS) {
        clearInterval(timer);
        if (sid === self.session && !state.joined) {
          self.emit("STATUS", { text: "방 " + code + " 을(를) 찾지 못했어요. 코드를 확인하거나 방장이 방을 만들었는지 확인해 주세요." });
          self.leave();
          self.emit("DISCONNECTED", { reason: "connect" });
        }
      }
    }, this._stepMs);
  };
  NP.connect = NP.connectOnline;

  NP._clientOnlineMsg = function (sid, state, code, payload) {
    if (sid !== this.session || !this.connected) return;
    var msg = parseJson(payload, CLIENT_IN_MAX);
    if (!msg) return;
    var kind = msg.type, me = this.nickname;
    if (kind === "PLAYER_LIST") {
      this.players = sanitizePlayerList(msg.list);
      if (!this.players.some(function (p) { return p.id === me; })) return;
      if (!state.joined) {
        state.joined = true;
        this.emit("CONNECTED", { ip: code });
      }
      this.emit("PLAYER_LIST", { list: this.players.map(function (p) { return { id: p.id, ready: p.ready, is_host: p.is_host }; }) });
    } else if (kind === "START") {
      var seed = msg.seed;
      if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 9007199254740991) return;
      this.inGame = true;
      this.emit("START", { seed: seed, players: sanitizeNameList(msg.players, MAX_PLAYERS),
                           rules: plainOrNull(msg.rules), limits: plainOrNull(msg.limits) });
    } else if (kind === "ATTACK") {
      var n = clampLines(msg.lines);
      if (n > 0) this.emit("ATTACK", { from: cleanNick(msg.from), lines: n });
    } else if (kind === "ELIMINATED") {
      var id = cleanNick(msg.id), left = toInt(msg.left);
      if (id) this.emit("ELIMINATED", { id: id, left: isNaN(left) ? 0 : clamp(left, 0, MAX_PLAYERS) });
    } else if (kind === "RESULT") {
      this.inGame = false;
      this.isReady = false;
      this.emit("RESULT", { winner: cleanTarget(msg.winner), ranking: sanitizeNameList(msg.ranking, MAX_PLAYERS) });
    } else if (kind === "ROOM_CLOSED") {
      this.emit("ROOM_CLOSED", {});
    } else if (kind === "JOIN_FAIL") {
      this.emit("JOIN_FAIL", { reason: cleanStr(msg.reason, 120) });
    } else if (kind === "RULES") {
      this.emit("RULES", { rules: plainOrNull(msg.rules), limits: plainOrNull(msg.limits) });
    } else if (kind === "BOARD") {
      var bid = cleanNick(msg.id), d = sanitizeBoard(msg);
      if (bid && d) this.emit("BOARD", Object.assign({ id: bid }, d));
    }
  };

  // ---------------- 방 탐색 (모바일: 없음) / 나가기 ----------------
  NP.searchRooms = function () { this.emit("ROOMS", { rooms: [] }); };
  NP.localIp = function () { return ""; };

  NP._onlineLeave = function (wasHost, immediate) {
    var mq = this.mq;
    if (!mq) return;
    try {
      if (wasHost) this.broadcast({ type: "ROOM_CLOSED" });
      else mq.publish(this.topicRoot + "/h", JSON.stringify({ type: "LEAVE", cid: this.cid }));
      mq.end(immediate);
    } catch (e) { /* ignore */ }
    this.mq = null;
  };

  NP.leave = function (immediate) {
    var wasHost = this.isHost && this.connected;
    this.session++;
    this.connected = false;
    this.inGame = false;
    if (this.online) this._onlineLeave(wasHost, immediate === true);
    this.clients = new Map();
    this.players = [];
    this.alive = new Set();
    this.isHost = false;
    this.isReady = false;
    this.online = false;
    this.cids = new Map();
    this.linkUp = false;
    this.mq = null;
  };

  /** mobile lifecycle: page visible again / network back -> check or reconnect right away */
  NP.wake = function () {
    var mq = this.mq;
    if (mq && typeof mq.kick === "function") { try { mq.kick(); } catch (e) { /* ignore */ } }
  };

  NP.installLifecycle = function (win, doc) {
    var self = this;
    if (!win || !win.addEventListener || this._lifecycle) return;
    this._lifecycle = true;
    var wake = function () { if (!doc || doc.visibilityState !== "hidden") self.wake(); };
    if (doc && doc.addEventListener) {
      doc.addEventListener("visibilitychange", wake);
      doc.addEventListener("resume", wake);
    }
    win.addEventListener("online", wake);
    win.addEventListener("pageshow", wake);
    win.addEventListener("focus", wake);
    // 실제로 페이지가 닫힐 때만 (bfcache 저장이면 persisted=true) 방 나가기 → LEAVE / ROOM_CLOSED
    win.addEventListener("pagehide", function (e) { if (!e || !e.persisted) self.leave(true); });
  };

  // ==========================================================
  // exports
  // ==========================================================
  NT.NetConfig = {
    MQTT_BROKER: MQTT_BROKER, MQTT_WS_PORT: MQTT_WS_PORT, MQTT_WS_PATH: MQTT_WS_PATH, MQTT_TLS: MQTT_TLS,
    MQTT_KEEPALIVE: MQTT_KEEPALIVE, MQTT_ROOT: MQTT_ROOT, VERSION: VERSION, MAX_PLAYERS: MAX_PLAYERS,
    CODE_CHARS: CODE_CHARS, BOARD_KEYS: BOARD_KEYS.slice(), MAX_ATTACK_LINES: MAX_ATTACK_LINES, url: brokerUrl()
  };
  NT.NET_VERSION = VERSION;
  NT.MAX_PLAYERS = NT.MAX_PLAYERS || MAX_PLAYERS;
  NT.NetworkManager = NetworkManager;
  NT.MiniMqtt = MiniMqtt;
  NT.NetUtil = { Codec: Codec, sanitizeBoard: sanitizeBoard, sanitizePlayerList: sanitizePlayerList,
                 cleanNick: cleanNick, clampLines: clampLines, brokerUrl: brokerUrl };
  NT.Net = new NetworkManager();
  if (global.document && global.addEventListener) NT.Net.installLifecycle(global, global.document);
})(typeof window !== "undefined" ? window : globalThis);
