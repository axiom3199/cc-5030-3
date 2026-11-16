'use strict';

// Minimal RFC 6455 WebSocket server framing — enough for text JSON messages,
// with proper masking, ping/pong and close handshake. No npm dependencies.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => { this.closed = true; this.onClose && this.onClose(); });
    socket.on('error', () => { this.closed = true; this.onClose && this.onClose(); });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = this._parseFrame();
      if (frame === null) break;
      if (frame === false) continue;
      this._dispatch(frame);
    }
  }

  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = b[0] & 0x80;
    const opcode = b[0] & 0x0f;
    const masked = b[1] & 0x80;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      len = Number(b.readBigUInt64BE(off)); off += 8;
    }
    let mask;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = b.slice(off, off + len);
    this.buf = b.slice(off + len);
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    return { fin: Boolean(fin), opcode, payload };
  }

  _dispatch(frame) {
    const { opcode, payload } = frame;
    if (opcode === 0x8) { // close
      this.close();
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      this._send(0xA, payload);
      return;
    }
    if (opcode === 0xA) return; // pong
    if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
      this.fragments.push(payload);
      if (frame.fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (opcode !== 0x2) {
          try { this.onMessage && this.onMessage(full.toString('utf8')); }
          catch (e) { this.onError && this.onError(e); }
        }
      }
    }
  }

  _send(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch { this.closed = true; }
  }

  sendText(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  send(obj) { this.sendText(JSON.stringify(obj)); }
  close() {
    if (this.closed) return;
    try { this._send(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    this.closed = true;
    this.socket.end();
  }
}

function upgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ];
  socket.write(headers.join('\r\n'));
  if (head && head.length) socket.unshift(head);
  const conn = new WSConnection(socket);
  onConnection(conn);
}

module.exports = { WSConnection, upgrade, acceptKey };
