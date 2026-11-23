// A stand-in for the room service, for the desktop checks on the hosted macOS and Windows machines (files-direct-30): nothing here talks to the real site.
// It answers the home page with the page's own settings block (no addresses for finding a direct route, so nothing leaves this machine), and opens a room
// for whoever asks: it tells the sender the room's nine-digit code and then keeps the socket open. Nobody ever joins, so no transfer happens.
// Prints one line, {"port": N}, when it is ready. Stops when its input closes.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const HOME = `<!doctype html><title>stand-in</title><script type="application/json" id="fd-config">${JSON.stringify({ ice: [], route: { switch: false } })}</script>`;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HOME);
  }
  res.writeHead(426);
  res.end();
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !/^\/api\/rooms\/[\w-]+\/ws\?/.test(req.url ?? '')) return socket.destroy();
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (/role=sender/.test(req.url)) socket.write(frame(JSON.stringify({ t: 'code', code: '123456789', ref: '0123456789ab' })));
  socket.on('data', () => {});
  socket.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
