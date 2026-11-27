'use strict';

// This process owns audio capture and volume restoration so audio work never
// runs in the renderer or blocks mouse input in the Electron main process.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pactl, verifyTools, listStreams, findSavedInput, volumeForGain, volumesEqual, mixBuffers } = require('./linux-audio.cjs');

const FRAME_BYTES = 48000 * 2 * 2 / 50; // 20 ms, stereo s16le
const MAX_BUFFER = FRAME_BYTES * 6;
const MAX_FAILURES = 8;
const HEALTHY_LANE_MS = 3000;
const retryDelay = failures => Math.min(300 * 2 ** (failures - 1), 2000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner, scope;
try {
  owner = Number(process.argv[2]); scope = JSON.parse(process.argv[3]);
  if (!Number.isSafeInteger(owner) || owner <= 0 || !scope || !['screen', 'app'].includes(scope.kind) || (scope.kind === 'app' && (typeof scope.appKey !== 'string' || scope.appKey.length > 2048))) throw new Error();
} catch { process.stderr.write('ERROR 无效的声音共享范围。\n'); process.exit(1); }

const lanes = new Map(), saved = new Map(), laneRetries = new Map();
let gain = 1, appliedGain = 1, refreshTimer, mixerTimer, refreshing, refreshPending = false, closing = false, stopping, refreshFailures = 0, refreshNotBefore = 0;
const selected = stream => scope.kind === 'screen' || stream.appKey === scope.appKey;
function terminateLane(lane) { lane.confirmed = false; lane.process.stdout.removeAllListeners('data'); lane.process.kill(); lane.buffer = Buffer.alloc(0); }
function invalidateLanes() {
  // A failed metadata lookup must revoke existing authorization, including
  // buffered PCM. Recreated lanes need a second successful snapshot to confirm.
  const previous = [...lanes.values()];
  lanes.clear();
  for (const lane of previous) terminateLane(lane);
}

function attach(stream) {
  const child = spawn('parec', [
    '--raw', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=40', '--process-time-msec=20',
    `--device=${stream.monitor}`, `--monitor-stream=${stream.index}`, '--client-name=YingBan Audio Capture'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lane = { process: child, stream, confirmed: false, healthySince: null, buffer: Buffer.alloc(0) };
  child.stdout.on('data', data => {
    if (!lane.confirmed || closing) return;
    lane.healthySince ??= Date.now();
    if (Date.now() - lane.healthySince >= HEALTHY_LANE_MS) laneRetries.delete(stream.identity);
    lane.buffer = Buffer.concat([lane.buffer, data]);
    if (lane.buffer.length > MAX_BUFFER) {
      const excess = Math.ceil((lane.buffer.length - MAX_BUFFER) / 4) * 4;
      lane.buffer = lane.buffer.subarray(excess);
    }
  });
  child.stderr.resume();
  child.on('error', () => { if (!closing) fail(new Error('无法启动 Linux 声音采集组件。')); });
  child.on('exit', () => {
    if (lanes.get(stream.identity) !== lane) return;
    lanes.delete(stream.identity);
    if (closing) return;
    const failures = (laneRetries.get(stream.identity)?.failures || 0) + 1;
    laneRetries.set(stream.identity, { failures, nextAttempt: Date.now() + retryDelay(failures) });
    // Removal is normal stream churn. Only charge this failure if the next
    // metadata snapshot still authorizes the same stream.
    scheduleRefresh();
  });
  lanes.set(stream.identity, lane);
}
async function setVolume(index, volume) { await pactl('set-sink-input-volume', String(index), ...volume.map(String)); }
async function applyVolume(stream, savedVolume, targetGain) {
  if (!volumesEqual(stream.volume, savedVolume.applied)) savedVolume.original = stream.volume.slice();
  const target = volumeForGain(savedVolume.original, targetGain);
  if (!volumesEqual(stream.volume, target)) await setVolume(stream.index, target);
  savedVolume.applied = target;
  stream.volume = target;
}
async function restoreOne(stream, previous) {
  // If the user adjusted the stream during ducking, keep their new choice.
  const target = volumesEqual(stream.volume, previous.applied) ? previous.original : stream.volume;
  if (!volumesEqual(stream.volume, target)) await setVolume(stream.index, target);
  return target;
}
async function refresh() {
  const all = await listStreams(owner);
  if (closing) return;
  const targetGain = gain;
  const wanted = all.filter(selected);
  if (wanted.length > 32) throw new Error('同时播放声音的应用过多，请关闭部分应用后重试。');
  const byId = new Map(wanted.map(stream => [stream.identity, stream]));
  for (const [id, lane] of lanes) {
    const now = byId.get(id);
    if (!now || now.sink !== lane.stream.sink || now.monitor !== lane.stream.monitor) { lanes.delete(id); terminateLane(lane); }
    else { lane.stream = now; lane.confirmed = true; }
  }
  for (const id of laneRetries.keys()) if (!byId.has(id)) laneRetries.delete(id);
  for (const stream of wanted) {
    if (lanes.has(stream.identity)) continue;
    const retry = laneRetries.get(stream.identity);
    if (retry?.failures >= MAX_FAILURES) { fail(new Error('无法连接应用的独立音频，请检查 PipeWire 后重试。')); return; }
    if (!retry || Date.now() >= retry.nextAttempt) attach(stream);
  }

  const allById = new Map(all.map(stream => [stream.identity, stream]));
  for (const [id, previous] of saved) {
    if (targetGain < 0.999 && byId.has(id)) continue;
    const stream = allById.get(id);
    if (stream) stream.volume = await restoreOne(stream, previous);
    saved.delete(id);
  }
  if (targetGain < 0.999) {
    const changes = wanted.map(stream => {
      let previous = saved.get(stream.identity);
      if (!previous) { previous = { index: stream.index, pid: stream.pid, started: stream.started, original: stream.volume.slice(), applied: stream.volume.slice() }; saved.set(stream.identity, previous); }
      return applyVolume(stream, previous, targetGain);
    });
    const results = await Promise.allSettled(changes);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  if (Math.abs(appliedGain - targetGain) > 0.0001) { appliedGain = targetGain; process.stderr.write(`DUCKED ${targetGain}\n`); }
}
function scheduleRefresh(delay = 0) {
  if (closing) return;
  clearTimeout(refreshTimer);
  if (refreshing) { refreshPending = true; return; }
  refreshTimer = setTimeout(() => {
    refreshing = refresh().then(() => {
      refreshFailures = 0; refreshNotBefore = 0;
    }).catch(error => {
      invalidateLanes();
      if (closing) return;
      if (++refreshFailures >= MAX_FAILURES) { fail(error); return; }
      refreshNotBefore = Date.now() + retryDelay(refreshFailures);
      process.stderr.write(`RETRY Linux audio refresh ${refreshFailures}/${MAX_FAILURES}\n`);
    }).finally(() => {
      refreshing = null;
      if (!closing) { const delayNext = refreshPending ? 0 : 300; refreshPending = false; scheduleRefresh(delayNext); }
    });
  }, Math.max(delay, refreshNotBefore - Date.now()));
}
function mix() {
  if (closing || process.stdout.writableNeedDrain) return;
  const buffers = [];
  for (const lane of lanes.values()) {
    if (!lane.confirmed) continue;
    const bytes = Math.min(FRAME_BYTES, lane.buffer.length - lane.buffer.length % 4);
    const buffer = lane.buffer.subarray(0, bytes);
    lane.buffer = lane.buffer.subarray(bytes);
    if (lane.stream.muted) continue;
    // parec reads a sink-input monitor after PipeWire/PulseAudio applies the
    // stream volume. Applying that volume again here double-ducks the outgoing
    // audio (0.17783 becomes roughly 0.0316). Keep the captured lane at unity;
    // pactl's stream volume is the single attenuation point.
    const gains = [1, 1];
    buffers.push({ buffer, gains });
  }
  process.stdout.write(mixBuffers(buffers, FRAME_BYTES));
}
async function restoreSaved() {
  if (!saved.size) return;
  let inputs, clients;
  try {
    const [inputJson, clientJson] = await Promise.all([
      pactl('--format=json', 'list', 'sink-inputs'),
      pactl('--format=json', 'list', 'clients')
    ]);
    inputs = JSON.parse(inputJson); clients = JSON.parse(clientJson);
  }
  catch { return; }
  if (!Array.isArray(inputs) || !Array.isArray(clients)) return;
  await Promise.allSettled([...saved].map(async ([id, previous]) => {
    const input = findSavedInput(inputs, clients, previous);
    if (!input) { saved.delete(id); return; }
    const volume = Object.values(input.volume || {}).map(channel => Number(channel.value));
    if (!volume.length || volume.some(value => !Number.isSafeInteger(value) || value < 0)) return;
    await restoreOne({ index: previous.index, volume }, previous);
    saved.delete(id);
  }));
}
function stop(code = 0) {
  if (stopping) return stopping;
  closing = true; clearTimeout(refreshTimer); clearInterval(mixerTimer);
  invalidateLanes();
  stopping = (async () => {
    if (refreshing) await refreshing;
    for (let attempt = 0; attempt < 3 && saved.size; attempt++) {
      if (attempt) await delay(150);
      await restoreSaved();
    }
    if (saved.size) process.stderr.write('WARN 无法恢复部分应用音量，请检查 Linux 音频服务。\n');
    process.exit(code);
  })();
  return stopping;
}
function fail(error) { if (closing) return; process.stderr.write(`ERROR ${String(error.message || error).replace(/[\r\n]/g, ' ')}\n`); void stop(1); }

process.stdout.on('error', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (line === 'QUIT' || line === '') { void stop(); return; }
  const match = /^DUCK (0?\.\d+|1(?:\.0+)?)$/.exec(line);
  if (match) { const value = Number(match[1]); if (value >= 0.05 && value <= 1) { gain = value; scheduleRefresh(); } }
});
input.on('close', () => { void stop(); });
(async () => {
  await verifyTools();
  const initial = await listStreams(owner);
  if (closing) return;
  if (scope.kind === 'app' && !initial.some(selected)) throw new Error('选择的应用已停止播放，请播放声音并重新选择。');
  process.stderr.write('READY 48000 2\n');
  mixerTimer = setInterval(mix, 20);
  scheduleRefresh();
})().catch(fail);
