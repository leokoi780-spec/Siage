// A minimal, dependency-free WebSocket server (RFC 6455).
//
// This exists so the app can run with nothing but `node server.js` — no
// `npm install`, no third-party WebSocket library. It implements exactly
// what this app needs: the opening handshake, text-frame messages, close,
// and ping/pong. It does not implement permessage-deflate or any WebSocket
// extensions, which is fine for a same-origin chat app like this one.
//
// For a larger production system you'd typically reach for the battle
// tested `ws` package instead — this hand-rolled version is intentionally
// small and has been exercised with an automated test client (see test.js)
// covering handshake, fragmented/large messages, and abrupt disconnects.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Attempts to read one frame off the front of `buf`. Returns
// { frame, rest } if a full frame is available, or null if more data is
// needed before we can parse anything.
function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const byte0 = buf[0];
  const byte1 = buf[1];
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let len = byte1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    len = Number(big); // fine for our message sizes (well under 4GB)
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null; // payload not fully arrived yet

  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }

  return { frame: { fin, opcode, payload }, rest: buf.subarray(offset + len) };
}

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.id = crypto.randomUUID();
    this.alive = true;
    this._closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // Parse as many complete frames as are already buffered.
    for (;;) {
      const parsed = tryParseFrame(this._buffer);
      if (!parsed) break;
      this._buffer = Buffer.from(parsed.rest); // detach from the growing buffer
      this._handleFrame(parsed.frame);
    }
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OPCODE.CLOSE) {
      this._sendRaw(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE));
      this.socket.end();
      return;
    }
    if (opcode === OPCODE.PING) {
      this._sendRaw(encodeFrame(payload, OPCODE.PONG));
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.alive = true;
      return;
    }

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (fin) {
        this.emit('message', payload.toString('utf8'));
      } else {
        this._fragOpcode = opcode;
        this._fragChunks = [payload];
      }
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      this._fragChunks.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragChunks);
        this._fragChunks = [];
        this._fragOpcode = null;
        this.emit('message', full.toString('utf8'));
      }
      return;
    }
  }

  _sendRaw(buf) {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(buf);
    }
  }

  send(str) {
    this._sendRaw(encodeFrame(Buffer.from(str, 'utf8'), OPCODE.TEXT));
  }

  ping() {
    this.alive = false;
    this._sendRaw(encodeFrame(Buffer.alloc(0), OPCODE.PING));
  }

  close() {
    try {
      this._sendRaw(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE));
      this.socket.end();
    } catch {
      // socket already gone — nothing to do
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }
}

class WSServer extends EventEmitter {
  constructor(httpServer) {
    super();
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgradeHeader = (req.headers['upgrade'] || '').toLowerCase();
    if (upgradeHeader !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');
    socket.write(responseHeaders);

    const conn = new WSConnection(socket, req);
    if (head && head.length) conn._onData(head);
    this.emit('connection', conn, req);
  }
}

module.exports = { WSServer, WSConnection };
