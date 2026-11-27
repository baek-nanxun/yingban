const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioRecovery } = require('../app/audio-recovery.js');
function clock() {
  let id = 0;
  const jobs = new Map();
  return { jobs, setTimeout(fn, delay) { jobs.set(++id, { fn, delay }); return id; }, clearTimeout(id) { jobs.delete(id); }, fire() { const [id, job] = jobs.entries().next().value; jobs.delete(id); job.fn(); } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('capture exits automatically retry the original source with bounded backoff and cleanup', async () => {
  const timers = clock(), starts = [], states = []; let stops = 0, failing = false;
  const recovery = new AudioRecovery({ timers, start: async source => { starts.push(source); if (failing) throw Error('offline'); }, stop: async () => { stops++; }, status: (...args) => states.push(args) });
  const source = { appKey: 'only-this-app' };
  await recovery.begin(source);
  failing = true;
  await recovery.failed('helper exited');
  for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
    assert.equal([...timers.jobs.values()][0].delay, delay);
    timers.fire(); await recovery.queue;
  }
  failing = false; timers.fire(); await recovery.queue;
  assert.equal(states.at(-1)[0], 'running');
  assert.ok(starts.every(s => s === source)); assert.ok(stops > starts.length);
  await recovery.stop(); assert.equal(timers.jobs.size, 0);
});

test('stop during delayed startup prevents attachment and waits for resource cleanup', async () => {
  const timers = clock(), entered = deferred(), finish = deferred(); let attached = false, resources = false;
  const recovery = new AudioRecovery({ timers, start: async (_source, active) => { resources = true; entered.resolve(); await finish.promise; if (active()) attached = true; }, stop: async () => { resources = false; }, status() {} });
  const opening = recovery.begin({ appKey: 'one' }); await entered.promise;
  const stopped = recovery.stop(); finish.resolve(); await opening; await stopped;
  assert.equal(attached, false); assert.equal(resources, false); assert.equal(timers.jobs.size, 0);
});

test('failure during startup is not lost, and duplicate exits and manual retry never overlap', async () => {
  const timers = clock(), entered = deferred(), finish = deferred(); let starts = 0;
  const recovery = new AudioRecovery({ timers, start: async () => { starts++; if (starts === 1) { entered.resolve(); await finish.promise; } }, stop: async () => {}, status() {} });
  const opening = recovery.begin({ appKey: 'one' }); await entered.promise;
  recovery.failed('exit after READY'); recovery.failed('duplicate'); recovery.retry();
  finish.resolve(); await opening;
  assert.equal(starts, 1); assert.equal(timers.jobs.size, 1);
  await recovery.retry(); assert.equal(starts, 2); assert.equal(timers.jobs.size, 0);
  await recovery.stop();
});

test('new share waits for cancelled old work, including its failing cleanup', async () => {
  const timers = clock(), entered = deferred(), finish = deferred(), calls = [];
  const recovery = new AudioRecovery({ timers, start: async (source, active) => {
    calls.push(source);
    if (source === 'old') { entered.resolve(); await finish.promise; assert.equal(active(), false); throw Error('late old failure'); }
  }, stop: async () => {}, status() {} });
  const old = recovery.begin('old'); await entered.promise;
  const stopped = recovery.stop(), next = recovery.begin('new');
  finish.resolve(); await Promise.all([old, stopped, next]);
  assert.deepEqual(calls, ['old', 'new']); assert.equal(timers.jobs.size, 0);
  await recovery.stop();
});

test('leaving during retry backoff cancels automatic and manual restarts', async () => {
  const timers = clock(); let starts = 0;
  const recovery = new AudioRecovery({ timers, start: async () => { starts++; throw Error('unavailable'); }, stop: async () => {}, status() {} });
  await recovery.begin('app'); assert.equal(timers.jobs.size, 1);
  await recovery.stop(); await recovery.retry(); await recovery.failed('late event');
  assert.equal(timers.jobs.size, 0); assert.equal(starts, 1);
});
