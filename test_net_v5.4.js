/*
 * NEON TETRIS v5.4-mobile — test_net_v5.4.js
 * Headless checks for net_v5.4.js (run: node test_net_v5.4.js)
 *   - MQTT 3.1.1 codec (CONNECT/SUBSCRIBE/PUBLISH bytes, split + concatenated frames)
 *   - host + 2 clients through the whole protocol over an in-memory mock broker
 *     (join, duplicate nick, version mismatch, retry watchdog, ready, start, rules,
 *      attack routing, watch/board routing, dead -> RESULT ranking, will/LEAVE, reconnect, close)
 * Optional live test against the real broker (needs Node >= 22 global WebSocket + network):
 *   node test_net_v5.4.js --live [wss://broker.hivemq.com:8884/mqtt]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const LIVE = process.argv.includes("--live");
const LIVE_URL = process.argv.find(a => /^wss?:\/\//.test(a));

function loadNT(extra) {
  const ctx = Object.assign({ console, setTimeout, clearTimeout, setInterval, clearInterval,
                              TextEncoder, TextDecoder, crypto: globalThis.crypto }, extra || {});
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const f = "net_v5.4.js";
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  return ctx.NT;
}
const NT = loadNT();
const CFG = NT.NetConfig;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   - " + name); }
  catch (e) { console.log("FAIL - " + name + "\n       " + (e && e.stack || e)); process.exitCode = 1; }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
function drain(net) { const out = []; let e; while ((e = net.poll())) out.push(e); return out; }
const J = (x) => JSON.stringify(x);
// values from the vm realm have other Array/Object prototypes -> compare as JSON
function eq(a, b, msg) { assert.strictEqual(J(a), J(b), msg); }
function ofType(evs, t) { return evs.filter(e => e.type === t); }
const ROWS = "0".repeat(190) + "8888888880";

// ----------------------------------------------------------
// in-memory MQTT broker (exact-topic subscriptions, QoS0, last will, async ordered delivery)
// ----------------------------------------------------------
class MockBroker {
  constructor() { this.clients = new Set(); this.log = []; this.queue = Promise.resolve(); }
  transport() { return o => new MockClient(this, o); }
  route(topic, payload) {
    this.log.push({ topic, payload });
    for (const c of this.clients) {
      if (c.up && c.subs.has(topic)) {
        this.queue = this.queue.then(() => { if (c.up) c.o.onMessage(topic, payload); });
      }
    }
  }
  published(topicEnd) {
    const out = [];
    for (const l of this.log) if (l.topic.endsWith(topicEnd)) { try { out.push(JSON.parse(l.payload)); } catch (e) { /* junk */ } }
    return out;
  }
}
class MockClient {
  constructor(broker, o) { this.b = broker; this.o = o; this.up = false; this.subs = new Set(); this.ended = false; }
  start() { setTimeout(() => this._connect(), 1); }
  _connect() {
    if (this.ended) return;
    this.up = true; this.subs.clear(); this.b.clients.add(this);
    this.o.onLink(true, ""); this.o.onConnect();
  }
  publish(t, p) { if (!this.up) return false; assert.strictEqual(typeof p, "string"); this.b.route(t, p); return true; }
  subscribe(t) { if (!this.up) return false; this.subs.add(t); return true; }
  end() { this.ended = true; this.up = false; this.b.clients.delete(this); }
  kick() {}
  // abnormal network loss: broker publishes the will; optionally reconnect later
  drop(reconnectMs) {
    this.up = false; this.b.clients.delete(this);
    this.o.onLink(false, "lost");
    if (this.o.will) this.b.route(this.o.will.topic, this.o.will.payload);
    if (reconnectMs) setTimeout(() => this._connect(), reconnectMs);
  }
}
// raw participant that speaks the protocol by hand (e.g. a desktop v5.3 client)
function rawClient(broker, code, cid) {
  const got = [];
  const c = new MockClient(broker, { onLink() {}, onConnect() {}, onMessage(t, p) { got.push(JSON.parse(p)); } });
  c._connect();
  c.subscribe(`${CFG.MQTT_ROOT}/${code}/c/${cid}`);
  return { c, got, send: (o) => c.publish(`${CFG.MQTT_ROOT}/${code}/h`, typeof o === "string" ? o : JSON.stringify(Object.assign({ cid }, o))) };
}

(async () => {
  // ---------------- codec ----------------
  await test("MQTT codec: CONNECT with will / SUBSCRIBE / PUBLISH bytes", () => {
    const C = NT.NetUtil.Codec;
    const con = Array.from(C.connect("ab", 60, { topic: "t", payload: "x" }));
    eq(con, [0x10, 20, 0, 4, 77, 81, 84, 84, 4, 0x06, 0, 60, 0, 2, 97, 98, 0, 1, 116, 0, 1, 120]);
    eq(Array.from(C.connect("ab", 30, null)).slice(9, 12), [0x02, 0, 30]);
    eq(Array.from(C.subscribe(7, "a/b")), [0x82, 8, 0, 7, 0, 3, 97, 47, 98, 0]);
    const pub = Array.from(C.publish("t", "한"));
    eq(pub, [0x30, 6, 0, 1, 116, 0xED, 0x95, 0x9C]);
  });

  await test("MQTT parser: varint > 127, split and concatenated frames, oversize", () => {
    const C = NT.NetUtil.Codec;
    const big = C.publish("x/y", "z".repeat(300));                 // remaining length 305 -> 2 bytes
    eq(Array.from(big.subarray(0, 3)), [0x30, 0xB1, 0x02]);
    const stream = new Uint8Array([...big, 0xD0, 0x00, 0x20, 0x02, 0x00, 0x00]);
    const p = new C.Parser(); const got = [];
    for (let i = 0; i < stream.length; i += 7) got.push(...p.push(stream.subarray(i, i + 7)));
    eq(got.map(g => g.type), [3, 13, 2]);
    const m = C.parsePublish(got[0].flags, got[0].body);
    assert.strictEqual(m.topic, "x/y"); assert.strictEqual(m.payload.length, 300);
    const q1 = C.parsePublish(0x02, new Uint8Array([0, 1, 97, 0x12, 0x34, 104, 105]));
    eq([q1.qos, q1.pid, q1.payload], [1, 0x1234, "hi"]);
    assert.throws(() => new C.Parser().push(new Uint8Array([0x30, 0xFF, 0xFF, 0x7F])), /too large/);
  });

  await test("MiniMqtt over fake WebSocket: CONNECT/CONNACK, subscribe, publish, ping, reconnect", async () => {
    const sockets = [];
    class FakeWS {
      constructor(url, protos) { this.url = url; this.protos = protos; this.readyState = 0; this.sent = []; sockets.push(this);
        setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); }
      send(b) { this.sent.push(Array.from(b)); }
      close() { this.readyState = 3; }
      recv(arr) { this.onmessage && this.onmessage({ data: new Uint8Array(arr).buffer }); }
    }
    const msgs = [], links = []; let connects = 0;
    const m = new NT.MiniMqtt({ url: CFG.url, clientId: "c1", keepalive: 60, will: null, WebSocket: FakeWS,
      onConnect: () => { connects++; m.subscribe("a/b"); }, onMessage: (t, p) => msgs.push([t, p]), onLink: (u) => links.push(u) });
    assert.strictEqual(CFG.url, "wss://broker.hivemq.com:8884/mqtt");
    m.start(); await tick(5);
    const ws = sockets[0];
    eq(ws.protos, ["mqtt"]);
    assert.strictEqual(ws.sent[0][0], 0x10);
    assert.strictEqual(m.publish("a/b", "x"), false, "no publish before CONNACK");
    ws.recv([0x20, 2, 0, 0]);
    assert.ok(m.isUp()); assert.strictEqual(connects, 1);
    assert.strictEqual(ws.sent[1][0], 0x82);
    ws.recv([0x30, 6, 0, 3, 97, 47, 98, 104]);       // PUBLISH topic "a/b" payload "h"
    eq(msgs[0], ["a/b", "h"]);
    assert.ok(m.publish("a/b", "y")); assert.strictEqual(ws.sent[2][0], 0x30);
    m.kick(); eq(ws.sent[3], [0xC0, 0]);
    ws.recv([0xD0, 0]);
    ws.onclose();                                    // network loss -> backoff reconnect (1 s)
    eq(links, [true, false]);
    m.kick();                                        // page visible again -> reconnect now
    await tick(5);
    assert.strictEqual(sockets.length, 2);
    sockets[1].recv([0x20, 2, 0, 0]);
    assert.strictEqual(connects, 2, "onConnect again -> resubscribe");
    assert.strictEqual(sockets[1].sent[1][0], 0x82);
    m.end(true);
    eq(sockets[1].sent[sockets[1].sent.length - 1], [0xE0, 0]);
    sockets[1].recv([0x20, 2, 0, 0]);               // ignored after end
    assert.strictEqual(connects, 2);
  });

  // ---------------- protocol over mock broker ----------------
  const broker = new MockBroker();
  const mk = (nick) => { const n = new NT.NetworkManager({ transport: broker.transport(), watchdogStepMs: 5 }); n.nickname = nick; return n; };
  const host = mk("Host"), A = mk("Alice"), B = mk("Bob");
  let code;

  await test("host creates room: 6-char code, topics, player list", async () => {
    const r = host.startOnlineHost("Host의 방");
    eq(Object.assign({}, r), { ok: true, err: "" });
    code = host.code;
    assert.ok(new RegExp(`^[${CFG.CODE_CHARS}]{6}$`).test(code));
    assert.strictEqual(host.topicRoot, `neontetris_online_v1/${code}`);
    assert.ok(host.isHost && host.connected && host.isReady && host.online);
    await tick();
    assert.ok(host.linkUp);
    const pl = ofType(drain(host), "PLAYER_LIST");
    eq(JSON.parse(JSON.stringify(pl[0].list)), [{ id: "Host", ready: true, is_host: true }]);
  });

  await test("client joins (JOIN id+ver on {root}/h, CONNECTED, PLAYER_LIST)", async () => {
    A.connectOnline(" " + code.toLowerCase() + " ");
    await tick(20);
    const j = broker.published("/h").find(m => m.type === "JOIN" && m.id === "Alice");
    assert.ok(j && j.ver === "5.4-mobile" && /^[0-9a-f]{12}$/.test(j.cid));
    assert.strictEqual(A.cid, j.cid);
    const ev = drain(A);
    eq(ev.map(e => e.type), ["CONNECTED", "PLAYER_LIST"]);
    assert.strictEqual(ev[0].ip, code);
    eq(A.players.map(p => p.id), ["Host", "Alice"]);
    eq(Array.from(host.clients.keys()), ["Alice"]);
    drain(host);
  });

  await test("duplicate nickname -> JOIN_FAIL (Korean reason), then join with new nick", async () => {
    B.nickname = "Alice";
    B.connectOnline(code);
    await tick(20);
    const ev = drain(B);
    eq(ev.map(e => e.type), ["JOIN_FAIL"]);
    assert.strictEqual(ev[0].reason, "이미 같은 닉네임이 있어요");
    B.leave();
    B.nickname = "Bob";
    B.connectOnline(code);
    await tick(20);
    eq(drain(B).map(e => e.type), ["CONNECTED", "PLAYER_LIST"]);
    eq(host.players.map(p => p.id), ["Host", "Alice", "Bob"]);
    const hostNick = mk("Host"); hostNick.connectOnline(code); await tick(20);
    assert.strictEqual(drain(hostNick)[0].reason, "이미 같은 닉네임이 있어요");
    hostNick.leave();
  });

  await test("version mismatch (desktop v5.3) and empty nick -> JOIN_FAIL", async () => {
    const raw = rawClient(broker, code, "0123456789ab");
    raw.send({ type: "JOIN", id: "Old", ver: "5.3" });
    raw.send({ type: "JOIN", id: "   ", ver: "5.4-mobile" });
    await tick();
    eq(raw.got.map(m => m.type), ["JOIN_FAIL", "JOIN_FAIL"]);
    assert.strictEqual(raw.got[0].reason, "버전이 달라요 (방장 v5.4-mobile). 같은 버전으로 맞춰 주세요");
    assert.strictEqual(raw.got[1].reason, "닉네임이 비어 있어요");
    assert.strictEqual(host.clients.size, 2);
    raw.c.end();
  });

  await test("untrusted input: junk JSON, bad cid (topic chars), __proto__ nick, oversize, unknown cid", async () => {
    const raw = rawClient(broker, code, "bad#cid");
    raw.send("not json"); raw.send("[1,2]"); raw.send(JSON.stringify({ type: "JOIN", id: "X", ver: "5.4-mobile", cid: "a/+/#" }));
    raw.send({ type: "READY", ready: true, cid: "ffffffffffff" });             // unknown cid -> ignored
    raw.send(JSON.stringify({ type: "JOIN", id: "Y".repeat(9000), ver: "5.4-mobile", cid: "abcabcabcabc" }));
    await tick();
    assert.ok(!broker.log.some(l => /[#+]/.test(l.topic)), "never publish to wildcard topic");
    assert.strictEqual(host.clients.size, 2);
    const p = rawClient(broker, code, "aaaaaaaaaaaa");
    p.send({ type: "JOIN", id: "__proto__\u0000", ver: "5.4-mobile" });
    await tick();
    assert.strictEqual(host.clients.size, 3);
    assert.ok(host.clients.has("__proto__"));
    p.send({ type: "LEAVE" });
    await tick();
    assert.strictEqual(host.clients.size, 2);
    p.c.end(); raw.c.end();
    drain(host); drain(A); drain(B);
  });

  await test("JOIN retry watchdog: resend every ~3 s, give up after ~12 s (scaled)", async () => {
    const lonely = mk("Lonely");
    lonely.connectOnline("ZZZZZZ");
    await tick(250);
    const joins = broker.published("ZZZZZZ/h").filter(m => m.type === "JOIN");
    assert.strictEqual(joins.length, 5, "1 + 4 retries");
    const ev = drain(lonely);
    eq(ev.map(e => e.type), ["STATUS", "DISCONNECTED"]);
    assert.ok(/ZZZZZZ/.test(ev[0].text)); assert.strictEqual(ev[1].reason, "connect");
    assert.ok(!lonely.connected);
    lonely.connectOnline("  "); assert.strictEqual(drain(lonely)[0].text, "방 코드를 입력해 주세요.");
  });

  await test("rules info shared live; ready gating; START with same seed to all", async () => {
    host.setRulesInfo({ preset: "표준" }, { Alice: { speed: 2 } });
    await tick();
    const r = ofType(drain(A), "RULES")[0];
    eq(JSON.parse(JSON.stringify(r)), { rules: { preset: "표준" }, limits: { Alice: { speed: 2 } }, type: "RULES" });
    let s = host.startGame({}, {});
    assert.strictEqual(s.ok, false); assert.strictEqual(s.err, "아직 준비하지 않은 사람: Alice, Bob");
    assert.strictEqual(A.toggleReady(), true);
    B.toggleReady(); B.toggleReady(); B.toggleReady();
    await tick();
    eq(host.players.map(p => p.ready), [true, true, true]);
    assert.ok(ofType(drain(B), "RULES").length >= 1, "PLAYER_LIST update re-sends RULES");
    assert.strictEqual(A.startGame().ok, false);
    s = host.startGame({ preset: "표준" }, { Alice: { speed: 2 } });
    assert.ok(s.ok);
    await tick();
    const hs = ofType(drain(host), "START")[0], as = ofType(drain(A), "START")[0], bs = ofType(drain(B), "START")[0];
    assert.ok(Number.isInteger(hs.seed) && hs.seed >= 0 && hs.seed < 2 ** 32);
    assert.strictEqual(as.seed, hs.seed); assert.strictEqual(bs.seed, hs.seed);
    eq(Array.from(bs.players), ["Host", "Alice", "Bob"]);
    eq(JSON.parse(JSON.stringify(as.limits)), { Alice: { speed: 2 } });
    assert.ok(host.inGame && A.inGame && B.inGame);
    eq(host.aliveList(), ["Host", "Alice", "Bob"]);
    const late = mk("Late"); late.connectOnline(code); await tick(20);
    assert.strictEqual(drain(late)[0].reason, "이미 게임이 진행 중이에요"); late.leave();
  });

  await test("attack routing: explicit target, host target, invalid -> random valid, clamp", async () => {
    A.sendAttack("Bob", 3);
    await tick();
    eq(ofType(drain(B), "ATTACK").map(e => [e.from, e.lines]), [["Alice", 3]]);
    const wire = broker.published("/h").filter(m => m.type === "ATTACK").pop();
    eq(Object.keys(wire).sort(), ["cid", "lines", "target", "type"]);
    host.sendAttack("Alice", 2);
    await tick();
    eq(ofType(drain(A), "ATTACK").map(e => [e.from, e.lines]), [["Host", 2]]);
    B.sendAttack("Host", 999); B.sendAttack(null, 0); B.sendAttack("Bob", -4);
    await tick();
    eq(ofType(drain(host), "ATTACK").map(e => [e.from, e.lines]), [["Bob", 20]]);
    const seen = new Set();
    for (let i = 0; i < 40; i++) A.sendAttack("RANDOM", 1);
    await tick(10);
    if (ofType(drain(host), "ATTACK").length) seen.add("Host");
    if (ofType(drain(B), "ATTACK").length) seen.add("Bob");
    eq([...seen].sort(), ["Bob", "Host"], "random over alive players except sender");
    assert.strictEqual(ofType(drain(A), "ATTACK").length, 0, "never to self");
    const raw = rawClient(broker, code, A.cid);                  // spoofed / garbage lines
    raw.send({ type: "ATTACK", target: "Bob", lines: "abc" }); raw.send({ type: "ATTACK", target: { x: 1 }, lines: "4" });
    await tick();
    assert.strictEqual(ofType(drain(B), "ATTACK").length + ofType(drain(host), "ATTACK").length, 1);
    raw.c.end();
  });

  await test("watch / board routing: only to watchers, cache sent on WATCH, invalid dropped", async () => {
    const snap = [ROWS, 5, 1, 3, 2, 1200, 4, 2];
    A.sendBoard(snap);
    await tick();
    assert.strictEqual(ofType(drain(B), "BOARD").length, 0, "Bob is not watching yet");
    assert.strictEqual(ofType(drain(host), "BOARD").length, 0, "host not watching");
    const w = broker.published("/h").filter(m => m.type === "BOARD").pop();
    eq(Object.keys(w).sort(), ["b", "cid", "inc", "ln", "pi", "r", "sc", "type", "x", "y"]);
    B.setWatch("Alice");
    await tick();
    const cached = ofType(drain(B), "BOARD");
    assert.strictEqual(cached.length, 1); assert.strictEqual(cached[0].id, "Alice"); assert.strictEqual(cached[0].sc, 1200);
    A.sendBoard([ROWS, 6, 0, 4, 5, 1300, 4, 0]);
    await tick();
    const live = ofType(drain(B), "BOARD");
    eq([live[0].id, live[0].pi, live[0].sc], ["Alice", 6, 1300]);
    host.setWatch("Alice");
    assert.strictEqual(ofType(drain(host), "BOARD")[0].sc, 1300, "host gets cached board immediately");
    A.sendBoard(["123", 1, 1, 1, 1, 1, 1, 1]); A.sendBoard([ROWS.replace(/0$/, "9"), 1]);
    A.sendBoard([ROWS, "x", true, 1.5, 999, -5, 1, 1]);
    await tick();
    const v = ofType(drain(B), "BOARD");
    assert.strictEqual(v.length, 1, "bad boards dropped");
    eq([v[0].pi, v[0].r, v[0].x, v[0].y, v[0].sc], [undefined, undefined, undefined, 24, 0]);
    host.sendBoard([ROWS, 0, 0, 0, 0, 77, 0, 0]);               // host's own board -> Alice watching? no
    A.setWatch("Host"); await tick();
    assert.strictEqual(ofType(drain(A), "BOARD")[0].sc, 77);
    drain(host);
  });

  await test("dead -> ELIMINATED left, last one -> RESULT winner + ranking, ready reset", async () => {
    A.reportDead();
    await tick();
    for (const n of [host, A, B]) {
      const el = ofType(drain(n), "ELIMINATED");
      eq(el.map(e => [e.id, e.left]), [["Alice", 2]]);
    }
    A.sendAttack("Host", 2); await tick();                     // like tetris_net.py: target must be alive
    eq(ofType(drain(host), "ATTACK").map(e => e.from), ["Alice"]);
    B.reportDead();
    await tick();
    for (const n of [host, A, B]) {
      const ev = drain(n);
      eq(ofType(ev, "ELIMINATED").map(e => [e.id, e.left]), [["Bob", 1]]);
      const res = ofType(ev, "RESULT")[0];
      assert.strictEqual(res.winner, "Host");
      eq(Array.from(res.ranking), ["Host", "Bob", "Alice"]);
      assert.strictEqual(n.inGame, false);
    }
    assert.strictEqual(A.isReady, false);
    eq(host.players.map(p => p.ready), [true, false, false]);
    host.reportDead(); await tick();
    assert.strictEqual(ofType(drain(host), "RESULT").length, 0, "no double result");
  });

  await test("client network loss: last-will LEAVE, reconnect -> resubscribe + re-JOIN", async () => {
    const mc = A.mq;
    mc.drop(30);
    await tick(10);
    eq(host.players.map(p => p.id), ["Host", "Bob"], "will LEAVE removed Alice");
    assert.ok(ofType(drain(A), "STATUS").length === 1);
    await tick(40);
    assert.ok(A.linkUp);
    eq(host.players.map(p => p.id), ["Host", "Bob", "Alice"], "rejoined after reconnect");
    assert.ok(ofType(drain(A), "PLAYER_LIST").length >= 1, "receives on resubscribed topic");
    assert.ok(broker.published("/h").some(m => m.type === "LEAVE" && m.cid === A.cid));
    drain(host); drain(B);
  });

  await test("in-game leave counts as death; leave -> LEAVE; host leave -> ROOM_CLOSED", async () => {
    A.toggleReady(); B.toggleReady(); await tick();
    assert.ok(host.startGame(null, null).ok); await tick();
    drain(host); drain(A); drain(B);
    B.leave();
    await tick();
    const ev = drain(host);
    eq(ofType(ev, "ELIMINATED").map(e => e.id), ["Bob"]);
    eq(ofType(ev, "PLAYER_LIST").pop().list.map(p => p.id), ["Host", "Alice"]);
    assert.ok(!B.connected && !B.online && B.mq === null);
    assert.ok(broker.published("/h").filter(m => m.type === "LEAVE").length >= 2);
    eq(ofType(drain(A), "ELIMINATED").map(e => e.id), ["Bob"]);
    host.leave();
    await tick();
    eq(drain(A).map(e => e.type), ["ROOM_CLOSED"]);
    assert.ok(!host.connected && !host.isHost && host.clients.size === 0);
    A.leave();
    assert.strictEqual(broker.clients.size, 0, "all transports closed");
  });

  await test("aliases + misc API", () => {
    const n = new NT.NetworkManager({ transport: broker.transport() });
    assert.ok(/^Player_\d{3}$/.test(n.nickname));
    n.searchRooms(); eq(Array.from(n.poll().rooms), []);
    assert.strictEqual(n.localIp(), "");
    assert.strictEqual(n.startHost, n.startOnlineHost); assert.strictEqual(n.connect, n.connectOnline);
    let got = null; const fn = n.on(e => { got = e; }); n.emit("STATUS", { text: "x" }); n.off(fn);
    assert.strictEqual(got.text, "x"); n.flush(); assert.strictEqual(n.poll(), null);
    assert.strictEqual(NT.Net instanceof NT.NetworkManager, true);
    assert.strictEqual(CFG.VERSION, "5.4-mobile"); assert.strictEqual(CFG.MAX_PLAYERS, 40);
  });

  // ---------------- optional: real broker ----------------
  if (LIVE) {
    await test("LIVE: host + client over " + (LIVE_URL || CFG.url), async () => {
      assert.ok(typeof WebSocket === "function", "needs global WebSocket (Node >= 22)");
      const L = loadNT({ WebSocket });
      const url = LIVE_URL;
      const tr = url ? (o) => new L.MiniMqtt(Object.assign({}, o, { url })) : undefined;
      const h = new L.NetworkManager({ transport: tr }); h.nickname = "LiveHost";
      const c = new L.NetworkManager({ transport: tr }); c.nickname = "LiveGuest";
      assert.ok(h.startOnlineHost("live").ok);
      const wait = async (cond, ms) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await tick(50); } };
      await wait(() => h.linkUp, 10000);
      c.connectOnline(h.code);
      const cev = []; c.on(e => cev.push(e));
      await wait(() => cev.some(e => e.type === "CONNECTED"), 12000);
      c.toggleReady();
      await wait(() => h.players.length === 2 && h.players[1].ready, 8000);
      assert.ok(h.startGame({}, {}).ok);
      await wait(() => cev.some(e => e.type === "START"), 8000);
      h.sendAttack("LiveGuest", 2);
      await wait(() => cev.some(e => e.type === "ATTACK" && e.lines === 2), 8000);
      c.reportDead();
      await wait(() => cev.some(e => e.type === "RESULT"), 8000);
      assert.strictEqual(cev.find(e => e.type === "RESULT").winner, "LiveHost");
      h.leave();
      await wait(() => cev.some(e => e.type === "ROOM_CLOSED"), 8000);
      c.leave();
    });
  }

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})();
