const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSignalingConnection } = require('../app/signaling.cjs');

class FakeClock {
  constructor() { this.time = 0; this.nextId = 1; this.pending = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = id => { this.pending.delete(id); };
  advance(ms) {
    this.time += ms;
    while (true) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.pending.delete(due[0]);
      due[1].callback();
    }
  }
}

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  constructor(endpoint) {
    super();
    this.endpoint = endpoint;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = FakeSocket.OPEN; this.emit('open'); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  drop(code, reason = '') {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  fail() {
    this.readyState = FakeSocket.CLOSED;
    this.emit('error', new Error('offline'));
  }
  close(code = 1000, reason = '') { this.drop(code, reason); }
  send(value) { this.sent.push(value); }
}

function setup(options = {}) {
  FakeSocket.instances = [];
  const clock = new FakeClock();
  const signals = [];
  const connection = createSignalingConnection('ws://same.example/room', {
    WebSocket: FakeSocket,
    timers: clock,
    now: clock.now,
    backoffMs: [250, 500, 1000],
    onSignal: signal => signals.push(signal),
    ...options
  });
  return { clock, signals, connection };
}

async function establishedGuest(options) {
  const state = setup(options);
  const opening = state.connection.connect();
  const first = FakeSocket.instances[0];
  first.open();
  await opening;
  first.message({ type: 'welcome', role: 'guest' });
  return { ...state, first };
}

test('a guest reconnects on an unexpected close and receives normal signaling after rejoin', async () => {
  const state = await establishedGuest();
  state.first.drop(1006, 'network reset');
  assert.deepEqual(state.signals, [{ type: 'welcome', role: 'guest' }, { type: 'reconnecting' }]);

  state.clock.advance(249);
  assert.equal(FakeSocket.instances.length, 1);
  state.clock.advance(1);
  const replacement = FakeSocket.instances[1];
  assert.equal(replacement.endpoint, 'ws://same.example/room');
  replacement.open();
  replacement.message({ type: 'welcome', role: 'guest' });
  replacement.message({ type: 'peer-ready' });

  assert.deepEqual(state.signals, [
    { type: 'welcome', role: 'guest' },
    { type: 'reconnecting' },
    { type: 'welcome', role: 'guest' },
    { type: 'peer-ready' }
  ]);
  assert.equal(state.connection.send({ type: 'recovery' }), true);
  assert.deepEqual(JSON.parse(replacement.sent[0]), { type: 'recovery' });
  state.connection.close();
});

test('a refused reconnect attempt continues with the next backoff slot', async () => {
  const state = await establishedGuest();
  state.first.drop(1006, 'network reset');
  state.clock.advance(250);
  FakeSocket.instances[1].drop(1006, 'refused');
  state.clock.advance(499);
  assert.equal(FakeSocket.instances.length, 2);
  state.clock.advance(1);
  const replacement = FakeSocket.instances[2];
  replacement.open();
  replacement.message({ type: 'welcome', role: 'guest' });
  assert.equal(state.signals.some(signal => signal.type === 'closed'), false);
  state.connection.close();
});

test('host failure, host-left, and invalid policy closes fail closed without retry', async () => {
  const host = setup();
  const opening = host.connection.connect();
  const hostSocket = FakeSocket.instances[0]; hostSocket.open(); await opening;
  hostSocket.message({ type: 'welcome', role: 'host' });
  hostSocket.drop(1006, 'network reset');
  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(host.signals.at(-1), { type: 'closed', message: '连接已断开，请重新加入。' });
  host.connection.close();

  for (const [code, reason] of [[1001, 'Host left'], [1008, 'Invalid invitation']]) {
    const guest = await establishedGuest();
    guest.first.drop(code, reason);
    assert.equal(FakeSocket.instances.length, 1);
    assert.deepEqual(guest.signals.at(-1), { type: 'closed', message: '连接已断开，请重新加入。' });
    guest.connection.close();
  }
});

test('a transient Room full close retries, but the reconnect window has a hard deadline', async () => {
  const state = await establishedGuest();
  state.first.drop(1008, 'Room full');
  assert.deepEqual(state.signals.at(-1), { type: 'reconnecting' });
  state.clock.advance(250);
  const replacement = FakeSocket.instances[1];
  replacement.open();
  state.clock.advance(59_749);
  assert.equal(state.signals.some(signal => signal.type === 'closed'), false);
  state.clock.advance(1);
  assert.deepEqual(state.signals.at(-1), { type: 'closed', message: '通话已满，只支持两台电脑。' });
  state.connection.close();
});

test('explicit close cancels pending retries and preserves initial connection errors', async () => {
  const state = await establishedGuest();
  state.first.drop(1006, 'network reset');
  state.connection.close();
  state.clock.advance(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(state.signals, [{ type: 'welcome', role: 'guest' }, { type: 'reconnecting' }]);

  const initial = setup();
  const opening = initial.connection.connect();
  FakeSocket.instances[0].fail();
  await assert.rejects(opening, { message: '连接失败。请确认对方在线、地址正确，并允许 Windows 防火墙通过。' });
  initial.connection.close();

  const cancelled = setup();
  const pending = cancelled.connection.connect();
  cancelled.connection.close();
  await assert.rejects(pending, { message: '连接被拒绝。' });
});
