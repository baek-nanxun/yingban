'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeStreams, applications, belongsToProcess, findSavedInput, volumeForGain, mixBuffers } = require('../app/linux-audio.cjs');

const processes = new Map([
  [1, { parent: 0, started: '1' }],
  [100, { parent: 1, started: '100' }],
  [101, { parent: 100, started: '101' }],
  [200, { parent: 1, started: '200' }],
  [201, { parent: 200, started: '201' }],
  [300, { parent: 999, started: '300' }]
]);
const getProcess = pid => processes.get(pid) || null;
const sinks = [{ index: 7, monitor_source: 'speaker.monitor' }];
function input(index, pid, name = 'Video', binary = 'video-player') {
  return { index, sink: 7, mute: false, volume: { 'front-left': { value: 65536 }, 'front-right': { value: 65536 } }, properties: { 'application.process.id': String(pid), 'application.name': name, 'application.process.binary': binary } };
}

test('only identifiable non-call playback streams are eligible', () => {
  const items = [input(11, 101, 'YingBan', 'yingban'), input(12, 200), input(13, 201), input(14, 300), input(15, 999), input(16, 200)];
  delete items[5].properties['application.process.binary'];
  const result = safeStreams(items, sinks, 100, getProcess);
  assert.deepEqual(result.map(item => item.index), [12, 13]);
  assert.equal(applications(result).length, 1);
  assert.equal(belongsToProcess(101, 100, getProcess), true);
  assert.equal(belongsToProcess(300, 100, getProcess), null);
  assert.throws(() => safeStreams(items, sinks, 999, getProcess), /无法安全识别/);
});
test('fills missing stream process metadata from the PulseAudio client', () => {
  const item = input(17, 200, 'Client-only video');
  item.client = 42;
  delete item.properties['application.process.id'];
  delete item.properties['application.process.binary'];
  const result = safeStreams([item], sinks, 100, getProcess, [{
    index: 42,
    properties: {
      'application.process.id': '200',
      'application.process.binary': 'video-player'
    }
  }]);
  assert.deepEqual(result.map(stream => stream.index), [17]);
  assert.equal(result[0].pid, 200);
  assert.equal(result[0].binary, 'video-player');
});
test('finds a saved client-only stream when restoring volume', () => {
  const item = input(18, 200, 'Client-only video');
  item.client = 43;
  delete item.properties['application.process.id'];
  delete item.properties['application.process.binary'];
  const found = findSavedInput([item], [{
    index: 43,
    properties: {
      'application.process.id': '200',
      'application.process.binary': 'video-player'
    }
  }], { index: 18, pid: 200, started: '200' }, getProcess);
  assert.equal(found, item);
});
test('monitor routing and process start time are part of stream identity', () => {
  const unavailable = input(3, 200); unavailable.sink = 8;
  assert.deepEqual(safeStreams([unavailable], sinks, 100, getProcess), []);
  const first = safeStreams([input(3, 200)], sinks, 100, getProcess)[0];
  const restarted = pid => pid === 200 ? { parent: 1, started: '2010' } : getProcess(pid);
  const second = safeStreams([input(3, 200)], sinks, 100, restarted)[0];
  assert.notEqual(first.identity, second.identity);
});
test('ducking respects PulseAudio cubic volume and preserves channel balance', () => {
  const volumes = volumeForGain([65536, 32768], 0.125);
  assert.deepEqual(volumes, [32768, 16384]);
  assert.deepEqual(volumeForGain([65536, 32768], 1), [65536, 32768]);
});
test('stereo mixer applies each lane gain, handles partial frames and clips', () => {
  const a = Buffer.alloc(8), b = Buffer.alloc(4);
  a.writeInt16LE(20000, 0); a.writeInt16LE(-20000, 2); a.writeInt16LE(1000, 4); a.writeInt16LE(-1000, 6);
  b.writeInt16LE(30000, 0); b.writeInt16LE(-30000, 2);
  const result = mixBuffers([{ buffer: a, gains: [0.5, 0.25] }, { buffer: b, gains: [1, 1] }], 8);
  assert.deepEqual([0, 2, 4, 6].map(i => result.readInt16LE(i)), [32767, -32768, 500, -250]);
});
