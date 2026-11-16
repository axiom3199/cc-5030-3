'use strict';

// Test/script-side WebSocket client using the same tiny framing rules.
const crypto = require('crypto');
const net = require('net');

function connect(port, path = '/ws') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    const messages = [];
    const waiters = [];
    let buf = Buffer.alloc(0);
    let established = false;

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      if (!established) {
        const idx = buf.indexOf('\r\n\r\n');
        buf = Buffer.concat([buf, chunk]);
        const idx2 = buf.indexOf('\r\n\r\n');
        if (idx2 < 0) return;
        established = true;
        buf = buf.slice(idx2 + 4);
        const api = makeApi();
        resolve(api);
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
      drain();
    });
    socket.on('close', () => { for (const w of waiters) w.reject(new Error('socket closed')); });

    function drain() {
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (!fin) continue;
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString('utf8'));
          messages.push(msg);
          while (waiters.length && messages.length) waiters.shift().resolve(messages.shift());
        }
      }
    }

    function makeApi() {
      return {
        socket,
        send(obj) {
          const json = Buffer.from(JSON.stringify(obj), 'utf8');
          let header;
          const len = json.length;
          if (len < 126) { header = Buffer.from([0x81, len]); }
          else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
          socket.write(Buffer.concat([header, json]));
        },
        recv(timeoutMs = 3000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('recv timeout')), timeoutMs);
            waiters.push({ resolve: (m) => { clearTimeout(t); res(m); }, reject: (e) => { clearTimeout(t); rej(e); } });
          });
        },
        async recvUntil(pred, timeoutMs = 3000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error('recvUntil timeout');
            const m = await this.recv(left);
            if (pred(m)) return m;
          }
        },
        // Drain queued messages without asserting on them (broadcasts etc).
        drainQueue() { const q = messages.splice(0); return q; },
        close: () => socket.destroy(),
      };
    }
  });
}

module.exports = { connect };
