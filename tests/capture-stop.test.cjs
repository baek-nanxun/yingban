'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stopCaptureProcess } = require('../app/capture-stop.cjs');

function helper() {
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  child.stdin = { writable: true, end: value => { child.command = value; } };
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); };
  return child;
}
test('stopping waits for restoration and process exit, even with a closed pipe', async () => {
  for (const closed of [false, true]) {
    const child = helper(); child.stdin.destroyed = closed;
    let finished = false;
    const stopped = stopCaptureProcess(child, 100).then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(child.command, closed ? undefined : '\n');
    child.emit('exit', 0);
    await stopped;
    assert.deepEqual(child.signals, []);
  }
});
test('an unresponsive helper is terminated then killed; completion still waits for exit', async () => {
  const child = helper();
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') child.emit('exit', null, signal);
  };
  await stopCaptureProcess(child, 5, 5);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
test('already exited helpers need no shutdown command', async () => {
  const child = helper(); child.exitCode = 0;
  await stopCaptureProcess(child);
  assert.equal(child.command, undefined);
});
