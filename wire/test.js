// End-to-end smoke test. Boots the real server (server.js) on an ephemeral
// port and drives it with real WebSocket clients (Node's built-in
// `WebSocket` global) to exercise: static file serving, room create/join,
// chat relay, typing indicators, chunked file transfer + reassembly,
// room capacity, bad room codes, and cleanup on disconnect.
//
// Run with: node test.js

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');

process.env.PORT = 0; // let the OS pick a free port

let passed = 0;
let failed = 0;

function ok(desc) {
  passed++;
  console.log(`  \u2713 ${desc}`);
}

function fail(desc, err) {
  failed++;
  console.error(`  \u2717 ${desc}`);
  if (err) console.error(`    ${err.stack || err}`);
}

async function test(desc, fn) {
  try {
    await fn();
    ok(desc);
  } catch (err) {
    fail(desc, err);
  }
}

function waitFor(target, type, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener('message', onMsg);
      reject(new Error(`Timed out waiting for ${type} matching predicate`));
    }, timeoutMs);
    function onMsg(event) {
      const msg = JSON.parse(event.data);
      if (msg.type === type && (!predicate || predicate(msg))) {
        clearTimeout(timer);
        target.removeEventListener('message', onMsg);
        resolve(msg);
      }
    }
    target.addEventListener('message', onMsg);
  });
}

function request(ws, type, payload = {}) {
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    function onMsg(event) {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ack' && msg.reqId === reqId) {
        ws.removeEventListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ type, reqId, ...payload }));
  });
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function main() {
  const { server } = require('./server.js');
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const wsBase = `ws://localhost:${port}`;
  console.log(`Server up on port ${port}\n`);

  // ---------- Static file serving ----------
  await test('serves index.html at /', async () => {
    const res = await httpGet(base + '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Wire/);
  });

  await test('serves style.css with correct content-type', async () => {
    const res = await httpGet(base + '/style.css');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/css/);
  });

  await test('serves app.js with correct content-type', async () => {
    const res = await httpGet(base + '/app.js');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
  });

  await test('404s on an unknown path', async () => {
    const res = await httpGet(base + '/nope-does-not-exist');
    assert.strictEqual(res.status, 404);
  });

  await test('blocks path traversal outside the public dir', async () => {
    const res = await httpGet(base + '/../server.js');
    assert.notStrictEqual(res.status, 200);
  });

  // ---------- Room lifecycle ----------
  let aliceCode;
  await test('create-room returns a 5-character code and acks ok', async () => {
    const alice = await wsOpen(wsBase);
    const res = await request(alice, 'create-room', { name: 'Alice' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.code.length, 5);
    assert.strictEqual(res.name, 'Alice');
    assert.deepStrictEqual(res.members, ['Alice']);
    aliceCode = res.code;
    alice.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('join-room with a bogus code fails cleanly', async () => {
    const ws = await wsOpen(wsBase);
    const res = await request(ws, 'join-room', { code: 'ZZZZZ', name: 'Nobody' });
    assert.strictEqual(res.ok, false);
    assert.ok(res.error);
    ws.close();
  });

  await test('two clients can join the same room and see each other', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    assert.strictEqual(created.ok, true);

    const bob = await wsOpen(wsBase);
    const systemPromise = waitFor(alice, 'system', (m) => m.text.includes('Bob joined'));
    const joined = await request(bob, 'join-room', { code: created.code, name: 'Bob' });
    assert.strictEqual(joined.ok, true);
    assert.deepStrictEqual(joined.members.sort(), ['Alice', 'Bob']);

    const sys = await systemPromise;
    assert.deepStrictEqual(sys.members.sort(), ['Alice', 'Bob']);

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('chat messages relay to the other member only, not the sender', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    let aliceGotEcho = false;
    alice.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'chat-message') aliceGotEcho = true;
    });

    const bobHears = waitFor(bob, 'chat-message', (m) => m.text === 'hello from alice');
    alice.send(JSON.stringify({ type: 'chat-message', text: 'hello from alice' }));
    const heard = await bobHears;
    assert.strictEqual(heard.name, 'Alice');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(aliceGotEcho, false, 'sender should not receive their own message back');

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('typing indicator relays to the other member', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    const bobSeesTyping = waitFor(bob, 'typing', (m) => m.name === 'Alice' && m.isTyping === true);
    alice.send(JSON.stringify({ type: 'typing', isTyping: true }));
    await bobSeesTyping;

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---------- File transfer ----------
  await test('a chunked file transfer reassembles byte-for-byte on the other end', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    // Build a 40KB deterministic payload -> forces multiple 16KB chunks.
    const original = crypto.randomBytes(40 * 1024);
    const CHUNK_SIZE = 16 * 1024;
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(original.length / CHUNK_SIZE);

    const receivedChunks = [];
    let fileStartMeta = null;
    const fileEndPromise = new Promise((resolve) => {
      bob.addEventListener('message', function onMsg(e) {
        const m = JSON.parse(e.data);
        if (m.type === 'file-start' && m.fileId === fileId) fileStartMeta = m;
        if (m.type === 'file-chunk' && m.fileId === fileId) receivedChunks[m.index] = Buffer.from(m.data, 'base64');
        if (m.type === 'file-end' && m.fileId === fileId) {
          bob.removeEventListener('message', onMsg);
          resolve();
        }
      });
    });

    alice.send(JSON.stringify({ type: 'file-start', fileId, name: 'notes.txt', size: original.length, mime: 'text/plain' }));
    for (let i = 0; i < totalChunks; i++) {
      const slice = original.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      alice.send(JSON.stringify({ type: 'file-chunk', fileId, index: i, data: slice.toString('base64') }));
    }
    alice.send(JSON.stringify({ type: 'file-end', fileId }));

    await fileEndPromise;
    assert.strictEqual(fileStartMeta.name, 'notes.txt');
    assert.strictEqual(fileStartMeta.size, original.length);
    assert.strictEqual(fileStartMeta.from, 'Alice');
    const reassembled = Buffer.concat(receivedChunks);
    assert.strictEqual(reassembled.length, original.length);
    assert.ok(reassembled.equals(original), 'reassembled file must match original byte-for-byte');

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---------- Capacity & cleanup ----------
  await test('room is deleted after the last member disconnects', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    alice.close();
    await new Promise((r) => setTimeout(r, 150));

    const bob = await wsOpen(wsBase);
    const res = await request(bob, 'join-room', { code: created.code, name: 'Bob' });
    assert.strictEqual(res.ok, false, 'room should no longer exist once empty');
    bob.close();
  });

  await test('leaving member triggers a system message with updated roster', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    const leftPromise = waitFor(alice, 'system', (m) => m.text.includes('Bob left'));
    bob.close();
    const sys = await leftPromise;
    assert.deepStrictEqual(sys.members, ['Alice']);
    alice.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---------- Regression tests for bugs found in this audit ----------

  await test('[regression] WSConnection only emits close once, even if the underlying socket fires both error and close', () => {
    const { WSConnection } = require('./lib/ws-server');
    const { EventEmitter } = require('events');

    // Minimal fake socket: just enough surface for WSConnection to attach to.
    const fakeSocket = new EventEmitter();
    fakeSocket.destroyed = false;
    fakeSocket.writable = true;
    fakeSocket.write = () => {};
    fakeSocket.end = () => {};

    const conn = new WSConnection(fakeSocket, {});
    let closeCount = 0;
    conn.on('close', () => closeCount++);

    // Real sockets often fire both 'error' and 'close' for the same
    // disconnect — the connection object must not treat that as two
    // separate departures (double "X left" broadcasts, double cleanup).
    fakeSocket.emit('error', new Error('simulated socket error'));
    fakeSocket.emit('close');

    assert.strictEqual(closeCount, 1, 'close should be emitted exactly once no matter how many underlying socket events fire');
  });

  await test('[regression] a sibling directory sharing the "public" prefix is not servable', async () => {
    const fs = require('fs');
    const path = require('path');
    const net = require('net');
    // Deliberately named to share a string prefix with the public/ dir —
    // this is exactly the shape of path a naive startsWith() check would
    // wrongly allow through.
    const trapDir = path.join(__dirname, 'public-secret');
    const trapFile = path.join(trapDir, 'secret.txt');
    fs.mkdirSync(trapDir, { recursive: true });
    fs.writeFileSync(trapFile, 'should never be servable');
    try {
      // Node's own http.get client normalizes '..' out of URLs before
      // sending the request, which would make this test pass against
      // *both* the buggy and fixed server (a false negative). A raw
      // socket sends the literal, unnormalized request line, the way
      // curl --path-as-is or a hand-crafted request would.
      const statusLine = await new Promise((resolve, reject) => {
        const sock = net.createConnection(port, 'localhost', () => {
          sock.write('GET /../public-secret/secret.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let data = '';
        sock.on('data', (chunk) => (data += chunk));
        sock.on('end', () => resolve(data.split('\r\n')[0]));
        sock.on('error', reject);
      });
      assert.ok(!statusLine.includes(' 200 '), `a sibling dir sharing the public/ prefix must not be served (got: ${statusLine})`);
    } finally {
      fs.rmSync(trapDir, { recursive: true, force: true });
    }
  });

  await test('a full room rejects a new joiner', async () => {
    const host = await wsOpen(wsBase);
    const created = await request(host, 'create-room', { name: 'Host' });
    const clients = [host];
    // Room max is 12; host already fills 1 seat, add 11 more to hit the cap.
    for (let i = 0; i < 11; i++) {
      const c = await wsOpen(wsBase);
      const res = await request(c, 'join-room', { code: created.code, name: `Guest${i}` });
      assert.strictEqual(res.ok, true);
      clients.push(c);
    }
    const overflow = await wsOpen(wsBase);
    const res = await request(overflow, 'join-room', { code: created.code, name: 'OneTooMany' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /full/i);

    clients.forEach((c) => c.close());
    overflow.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('malformed JSON frame does not crash the connection', async () => {
    const ws = await wsOpen(wsBase);
    ws.send('this is not json {{{');
    // If the server survived, a subsequent normal request should still work.
    const res = await request(ws, 'create-room', { name: 'StillAlive' });
    assert.strictEqual(res.ok, true);
    ws.close();
  });

  await test('messages never leak across two separate rooms', async () => {
    const a1 = await wsOpen(wsBase);
    const roomA = await request(a1, 'create-room', { name: 'A1' });
    const a2 = await wsOpen(wsBase);
    await request(a2, 'join-room', { code: roomA.code, name: 'A2' });

    const b1 = await wsOpen(wsBase);
    const roomB = await request(b1, 'create-room', { name: 'B1' });
    const b2 = await wsOpen(wsBase);
    await request(b2, 'join-room', { code: roomB.code, name: 'B2' });

    assert.notStrictEqual(roomA.code, roomB.code);

    let bHeardA = false;
    b2.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'chat-message' && m.text === 'secret for room A only') bHeardA = true;
    });

    const a2Hears = waitFor(a2, 'chat-message', (m) => m.text === 'secret for room A only');
    a1.send(JSON.stringify({ type: 'chat-message', text: 'secret for room A only' }));
    await a2Hears;
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(bHeardA, false, 'room B must never see room A\u2019s messages');

    [a1, a2, b1, b2].forEach((c) => c.close());
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('an oversized raw frame is dropped without crashing the server', async () => {
    const ws = await wsOpen(wsBase);
    // Bigger than MAX_MESSAGE_BYTES (200KB) — server should silently ignore it.
    const huge = JSON.stringify({ type: 'chat-message', text: 'x'.repeat(300 * 1024) });
    ws.send(huge);
    await new Promise((r) => setTimeout(r, 100));
    // Server must still be responsive afterwards.
    const res = await request(ws, 'create-room', { name: 'StillHere' });
    assert.strictEqual(res.ok, true);
    ws.close();
  });

  await test('a larger multi-chunk file (200KB) still reassembles correctly', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    const original = crypto.randomBytes(200 * 1024);
    const CHUNK_SIZE = 16 * 1024;
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(original.length / CHUNK_SIZE);
    const receivedChunks = [];

    const donePromise = new Promise((resolve) => {
      bob.addEventListener('message', function onMsg(e) {
        const m = JSON.parse(e.data);
        if (m.type === 'file-chunk' && m.fileId === fileId) receivedChunks[m.index] = Buffer.from(m.data, 'base64');
        if (m.type === 'file-end' && m.fileId === fileId) {
          bob.removeEventListener('message', onMsg);
          resolve();
        }
      });
    });

    alice.send(JSON.stringify({ type: 'file-start', fileId, name: 'big.bin', size: original.length, mime: 'application/octet-stream' }));
    for (let i = 0; i < totalChunks; i++) {
      const slice = original.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      alice.send(JSON.stringify({ type: 'file-chunk', fileId, index: i, data: slice.toString('base64') }));
    }
    alice.send(JSON.stringify({ type: 'file-end', fileId }));
    await donePromise;

    const reassembled = Buffer.concat(receivedChunks);
    assert.ok(reassembled.equals(original), '200KB file must reassemble byte-for-byte across many chunks');

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---------- Production-readiness additions ----------
  await test('serves a /healthz endpoint for uptime checks', async () => {
    const res = await httpGet(base + '/healthz');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /ok/i);
  });

  await test('responses carry baseline security headers', async () => {
    const res = await httpGet(base + '/');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.headers['content-security-policy'], 'expected a Content-Security-Policy header');
  });

  await test('a file-start over the size limit is rejected and not relayed to others', async () => {
    const alice = await wsOpen(wsBase);
    const created = await request(alice, 'create-room', { name: 'Alice' });
    const bob = await wsOpen(wsBase);
    await request(bob, 'join-room', { code: created.code, name: 'Bob' });

    const fileId = crypto.randomUUID();
    let bobSawStart = false;
    bob.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'file-start' && m.fileId === fileId) bobSawStart = true;
    });

    const rejectionPromise = waitFor(alice, 'file-rejected', (m) => m.fileId === fileId);
    alice.send(JSON.stringify({
      type: 'file-start',
      fileId,
      name: 'too-big.bin',
      size: 301 * 1024 * 1024, // just over the 300MB cap
      mime: 'application/octet-stream',
    }));
    const rejection = await rejectionPromise;
    assert.ok(rejection.reason, 'expected a human-readable rejection reason');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(bobSawStart, false, 'an oversized file must never be relayed to other members');

    alice.close();
    bob.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ---------- Wrap up ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
