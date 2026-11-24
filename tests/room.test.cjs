const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createRoom, parseInvite } = require('../app/room.cjs');
const dgram = require('node:dgram');
const net = require('node:net');
async function client(url, options) {
  const socket = new WebSocket(url, options); socket.messages = [];
  socket.on('message', bytes => socket.messages.push(JSON.parse(bytes)));
  socket.on('error', () => {});
  await once(socket, 'open'); return socket;
}
async function received(socket, type) {
  for (let i = 0; i < 80; i++) { const m = socket.messages.find(m => m.type === type); if (m) return m; await delay(20); }
  throw new Error(`No ${type} message`);
}

test('occupied discovery port releases the partially opened signaling server', { timeout: 5000 }, async t => {
  const occupied = dgram.createSocket('udp4');
  t.after(() => occupied.close());
  occupied.bind(0, '0.0.0.0'); await once(occupied, 'listening');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await assert.rejects(createRoom({ port, host: '127.0.0.1', discoveryPort: occupied.address().port }), { code: 'EADDRINUSE' });
  probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
  await new Promise(resolve => probe.close(resolve));
});
test('invites accept a LAN/Tailscale destination and reject other protocols or malformed secrets', () => {
  const token = 'a'.repeat(48);
  assert.equal(parseInvite(`yingban://100.80.0.2:43127/${token}`).endpoint, `ws://100.80.0.2:43127/${token}`);
  assert.equal(parseInvite(`clearcall://100.80.0.2:43127/${token}`).endpoint, `ws://100.80.0.2:43127/${token}`);
  for (const address of [`https://example.com/${token}`, 'clearcall://localhost:43127/abc', `clearcall://user:pass@localhost:43127/${token}`, `clearcall://localhost:43127/${token}?x=1`]) assert.throws(() => parseInvite(address));
});
test('two peers relay separate media signaling, reject a third peer and notify disconnection', { timeout: 10000 }, async t => {
  const room = await createRoom({ port: 0, host: '127.0.0.1', discoveryPort: 0 }); t.after(() => room.close());
  const url = `ws://127.0.0.1:${room.port}/${room.token}`;
  const a = await client(url); assert.equal((await received(a, 'welcome')).role, 'host');
  const b = await client(url); assert.equal((await received(b, 'welcome')).role, 'guest');
  await Promise.all([received(a, 'peer-ready'), received(b, 'peer-ready')]);
  a.send(JSON.stringify({ type: 'description', description: { type: 'offer', sdp: 'test' } }));
  assert.equal((await received(b, 'description')).description.sdp, 'test');
  assert.equal(a.messages.some(m => m.type === 'description'), false);
  b.send(JSON.stringify({ type: 'recovery', action: 'request', sessionId: 'test-session' }));
  assert.equal((await received(a, 'recovery')).sessionId, 'test-session');
  const third = new WebSocket(url); const [code, reason] = await once(third, 'close');
  assert.equal(code, 1008); assert.equal(reason.toString(), 'Room full');
  b.close(); await received(a, 'peer-left');
  const replacement = await client(url); assert.equal((await received(replacement, 'welcome')).role, 'guest');
  const closed = once(replacement, 'close'); a.close();
  assert.equal((await closed)[1].toString(), 'Host left');
});
test('wrong invitation and browser origins cannot join a room', { timeout: 10000 }, async t => {
  const room = await createRoom({ port: 0, host: '127.0.0.1', discoveryPort: 0 }); t.after(() => room.close());
  const bad = new WebSocket(`ws://127.0.0.1:${room.port}/${'0'.repeat(48)}`);
  assert.equal((await once(bad, 'close'))[0], 1008);
  const browser = new WebSocket(`ws://127.0.0.1:${room.port}/${room.token}`, { origin: 'https://example.com' });
  assert.equal((await once(browser, 'close'))[0], 1008);
});
