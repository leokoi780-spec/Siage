// Fast Private Chat — server
//
// Zero external dependencies: just Node's built-in http/fs plus the small
// hand-rolled WebSocket server in lib/ws-server.js. Run it with nothing
// more than `node server.js`.
//
// Everything lives in memory only. There is no database, no file written
// to disk, and no message log kept anywhere. When the last person leaves
// a room, that room and everything said in it is gone for good.
//
// Rooms are relay-only: the server passes chat text and file chunks
// straight through from sender to the other members of the room without
// storing or inspecting them beyond what's needed to route them.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WSServer } = require('./lib/ws-server');

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 12;
const MAX_MESSAGE_BYTES = 200 * 1024; // guards against a malformed/huge frame
const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB per file — keeps memory use on the receiving browser bounded
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// A conservative baseline CSP: the page only ever loads its own JS/CSS plus
// Google Fonts, and only ever talks back to itself over WebSocket.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

// ---------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  const withinPublicDir = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (!withinPublicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  // Lightweight endpoint for deploy platforms (Render/Railway/Fly/etc.) to
  // poll so they know the process is alive and can route traffic to it.
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  serveStatic(req, res);
});
const wss = new WSServer(server);

// ---------------------------------------------------------------------
// Room state (in-memory only)
// ---------------------------------------------------------------------

// roomCode -> { members: Map<connId, { conn, name }> }
const rooms = new Map();
// connId -> { roomCode }
const connMeta = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(raw) {
  const name = String(raw || '').trim().slice(0, 24);
  return name || 'Guest';
}

function memberNames(room) {
  return Array.from(room.members.values()).map((m) => m.name);
}

function broadcast(roomCode, payload, exceptConnId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const json = JSON.stringify(payload);
  for (const [connId, member] of room.members) {
    if (connId === exceptConnId) continue;
    member.conn.send(json);
  }
}

function sendTo(conn, payload) {
  conn.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------

wss.on('connection', (conn) => {
  connMeta.set(conn.id, { roomCode: null });

  conn.on('message', (raw) => {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) return; // drop oversize frames silently
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed input rather than crash the connection
    }
    handleMessage(conn, msg);
  });

  conn.on('close', () => {
    const meta = connMeta.get(conn.id);
    connMeta.delete(conn.id);
    if (!meta?.roomCode) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const leaverName = room.members.get(conn.id)?.name || 'Someone';
    room.members.delete(conn.id);
    if (room.members.size === 0) {
      rooms.delete(meta.roomCode);
    } else {
      broadcast(meta.roomCode, { type: 'system', text: `${leaverName} left`, members: memberNames(room) });
    }
  });
});

function ack(conn, reqId, data) {
  sendTo(conn, { type: 'ack', reqId, ...data });
}

function joinRoom(conn, roomCode, rawName, reqId) {
  const room = rooms.get(roomCode);
  if (!room) return ack(conn, reqId, { ok: false, error: 'That room no longer exists.' });
  if (room.members.size >= MAX_ROOM_SIZE) {
    return ack(conn, reqId, { ok: false, error: 'That room is full.' });
  }
  const name = sanitizeName(rawName);
  room.members.set(conn.id, { conn, name });
  connMeta.set(conn.id, { roomCode });

  ack(conn, reqId, { ok: true, code: roomCode, name, members: memberNames(room) });
  broadcast(roomCode, { type: 'system', text: `${name} joined`, members: memberNames(room) }, conn.id);
}

function handleMessage(conn, msg) {
  const meta = connMeta.get(conn.id);
  const roomCode = meta?.roomCode;
  const room = roomCode ? rooms.get(roomCode) : null;
  const sender = room?.members.get(conn.id);

  switch (msg.type) {
    case 'create-room': {
      const code = generateRoomCode();
      rooms.set(code, { members: new Map() });
      joinRoom(conn, code, msg.name, msg.reqId);
      break;
    }

    case 'join-room': {
      const code = String(msg.code || '').trim().toUpperCase();
      if (!code) return ack(conn, msg.reqId, { ok: false, error: 'Enter a room code to join.' });
      joinRoom(conn, code, msg.name, msg.reqId);
      break;
    }

    case 'chat-message': {
      if (!sender) return;
      const text = String(msg.text || '').slice(0, 4000);
      if (!text.trim()) return;
      broadcast(roomCode, { type: 'chat-message', text, name: sender.name, ts: Date.now() }, conn.id);
      break;
    }

    case 'typing': {
      if (!sender) return;
      broadcast(roomCode, { type: 'typing', name: sender.name, isTyping: !!msg.isTyping }, conn.id);
      break;
    }

    case 'file-start': {
      if (!sender) return;
      const size = Number(msg.size) || 0;
      if (size > MAX_FILE_SIZE) {
        sendTo(conn, {
          type: 'file-rejected',
          fileId: msg.fileId,
          reason: 'That file is larger than the 300 MB limit for this room.',
        });
        return;
      }
      broadcast(roomCode, {
        type: 'file-start',
        fileId: msg.fileId,
        name: String(msg.name || 'file').slice(0, 255),
        size,
        mime: String(msg.mime || 'application/octet-stream').slice(0, 100),
        from: sender.name,
      }, conn.id);
      break;
    }

    case 'file-chunk': {
      if (!sender) return;
      broadcast(roomCode, {
        type: 'file-chunk',
        fileId: msg.fileId,
        index: msg.index,
        data: msg.data,
      }, conn.id);
      break;
    }

    case 'file-end': {
      if (!sender) return;
      broadcast(roomCode, { type: 'file-end', fileId: msg.fileId }, conn.id);
      break;
    }

    default:
      break; // unknown message type — ignore
  }
}

// Periodically ping connections so dead sockets (closed laptop lids, lost
// wifi) get cleaned up instead of lingering as phantom room members.
const pingInterval = setInterval(() => {
  for (const room of rooms.values()) {
    for (const { conn } of room.members.values()) {
      if (!conn.alive) {
        conn.close();
        continue;
      }
      conn.ping();
    }
  }
}, 30000);
pingInterval.unref();

server.listen(PORT, () => {
  console.log(`Fast Private Chat running at http://localhost:${PORT}`);
});

// Deploy platforms (and `docker stop`, Ctrl-C, etc.) signal shutdown with
// SIGTERM/SIGINT — exit cleanly instead of dropping connections mid-write.
function shutdown() {
  server.close(() => process.exit(0));
  // Belt-and-braces: force exit if something keeps an open handle alive.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
