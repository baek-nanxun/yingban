const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const dgram = require('node:dgram');

const TYPES = new Set(['description', 'candidate', 'peer-state', 'profile']);
function parseInvite(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('邀请链接无效。'); }
  if (!['yingban:', 'clearcall:'].includes(url.protocol) || !/^\d{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || !/^\/[a-f0-9]{48}$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error('邀请地址无效，请重新复制。');
  }
  return { endpoint: `ws://${url.hostname}:${url.port}${url.pathname}` };
}
function addresses(port, token) {
  const hosts = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')).map(x => x.address);
  hosts.sort((a, b) => Number(b.startsWith('100.')) - Number(a.startsWith('100.')));
  return [...new Set(hosts)].map(host => `yingban://${host}:${port}/${token}`);
}
function roomCode() { return String(100000 + Math.floor(Math.random() * 900000)); }
function broadcastAddresses() {
  const result = new Set(['255.255.255.255']);
  for (const adapter of Object.values(networkInterfaces()).flat()) {
    if (!adapter || adapter.family !== 'IPv4' || adapter.internal || !adapter.netmask) continue;
    const ip = adapter.address.split('.').map(Number), mask = adapter.netmask.split('.').map(Number);
    result.add(ip.map((value, i) => (value & mask[i]) | (255 ^ mask[i])).join('.'));
  }
  return [...result];
}
async function discoverRoom(code, timeoutMs = 1800) {
  if (!/^\d{6}$/.test(String(code))) throw new Error('房间号需要是 6 位数字。');
  const socket = dgram.createSocket('udp4');
  const responses = [];
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', () => { try { socket.setBroadcast(true); } catch {} resolve(); });
  });
  socket.on('message', (message, info) => {
    const text = message.toString();
    if (!text.startsWith('YINGBAN_ROOM|')) return;
    const [, room, token, port] = text.split('|');
    if (room === String(code) && /^[a-f0-9]{48}$/.test(token) && /^\d+$/.test(port)) responses.push({ endpoint: `ws://${info.address}:${port}/${token}`, address: info.address, port: Number(port) });
  });
  const packet = Buffer.from(`YINGBAN_DISCOVER|${code}`);
  for (const address of broadcastAddresses()) socket.send(packet, 43128, address);
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  socket.close();
  if (!responses[0]) throw new Error('找不到这个房间。请确认两台电脑在同一局域网，或使用邀请地址。');
  return responses[0];
}
async function createRoom({ port = 43127, host = '0.0.0.0', token = randomBytes(24).toString('hex'), roomId = roomCode(), discoveryPort = 43128 } = {}) {
  const peers = new Map();
  const server = new WebSocketServer({ port, host, maxPayload: 128 * 1024 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const discovery = dgram.createSocket('udp4');
  if (discoveryPort) {
    try {
      await new Promise((resolve, reject) => { discovery.once('error', reject); discovery.bind(discoveryPort, '0.0.0.0', resolve); });
    } catch (error) {
      try { discovery.close(); } catch {}
      await new Promise(resolve => server.close(resolve));
      throw error;
    }
    discovery.on('message', (message, info) => {
      const [, requested] = message.toString().split('|');
      if (message.toString().startsWith('YINGBAN_DISCOVER|') && requested === roomId) {
        discovery.send(Buffer.from(`YINGBAN_ROOM|${roomId}|${token}|${server.address().port}`), info.port, info.address);
      }
    });
  }
  server.on('error', () => {});
  const send = (socket, data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
  server.on('connection', (socket, request) => {
    const supplied = (request.url || '').slice(1);
    if (request.headers.origin || !/^[a-f0-9]{48}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      socket.close(1008, 'Invalid invitation'); return;
    }
    if (peers.size >= 2) { socket.close(1008, 'Room full'); return; }
    // The app connects its local host first; no address is exposed until that succeeds.
    const role = peers.size === 0 ? 'host' : 'guest';
    peers.set(socket, role);
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    send(socket, { type: 'welcome', role });
    if (peers.size === 2) for (const peer of peers.keys()) send(peer, { type: 'peer-ready' });
    let bucket = 150;
    let refill = Date.now();
    socket.on('message', raw => {
      const now = Date.now();
      bucket = Math.min(150, bucket + (now - refill) * 0.05); refill = now;
      if (--bucket < 0) { socket.close(1008, 'Rate limit'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || !TYPES.has(message.type)) return;
      for (const other of peers.keys()) if (other !== socket) send(other, message);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!peers.has(socket)) return;
      const leavingRole = peers.get(socket);
      peers.delete(socket);
      for (const other of peers.keys()) {
        send(other, { type: 'peer-left' });
        if (leavingRole === 'host') other.close(1001, 'Host left');
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of peers.keys()) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  }, 10000);
  heartbeat.unref();
  const actualPort = server.address().port;
  return {
    token, roomId, port: actualPort, invites: addresses(actualPort, token),
    close: async () => {
      clearInterval(heartbeat);
      try { discovery.close(); } catch {}
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
module.exports = { createRoom, parseInvite, addresses, discoverRoom };
