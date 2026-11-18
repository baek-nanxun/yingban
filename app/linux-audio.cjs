'use strict';

// PulseAudio's per-stream monitor API is also implemented by pipewire-pulse.
// Never fall back to a monitor of the complete output: that would include calls.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const commandOptions = { timeout: 3000, maxBuffer: 2 * 1024 * 1024 };
async function pactl(...args) {
  try { return (await exec('pactl', args, commandOptions)).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('缺少 Linux 音频工具。请安装 pulseaudio-utils 后重试。');
    throw new Error('无法连接 Linux 音频服务，请检查 PipeWire 和 pipewire-pulse。');
  }
}
async function verifyTools() {
  try { await exec('parec', ['--version'], commandOptions); }
  catch { throw new Error('缺少 Linux 音频工具。请安装 pulseaudio-utils 后重试。'); }
  await pactl('info');
}

function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const parent = Number(fields[1]), started = fields[19];
    if (!Number.isSafeInteger(parent) || !/^\d+$/.test(started || '')) return null;
    return { parent, started };
  } catch { return null; }
}
function belongsToProcess(pid, owner, getProcess = processInfo) {
  // An unreadable or broken ancestry is unsafe, not evidence of a different app.
  const visited = new Set();
  for (let current = pid; current > 0; ) {
    if (current === owner) return true;
    if (visited.has(current)) return null;
    visited.add(current);
    const info = getProcess(current);
    if (!info) return null;
    current = info.parent;
  }
  return false;
}
function applicationKey(name, binary) {
  return Buffer.from(JSON.stringify([name, binary])).toString('base64url');
}
function safeStreams(inputs, sinks, owner, getProcess = processInfo) {
  const monitors = new Map(sinks.map(sink => [Number(sink.index), sink.monitor_source || sink.monitor_source_name]));
  const ownerInfo = getProcess(owner);
  if (!ownerInfo) throw new Error('无法安全识别映伴进程，已停止声音共享。');
  const safe = [];
  for (const item of inputs) {
    const props = item.properties || {}, rawPid = String(props['application.process.id'] || '');
    const pid = Number(rawPid), index = Number(item.index), sink = Number(item.sink);
    const binary = props['application.process.binary'], name = props['application.name'] || binary;
    const monitor = monitors.get(sink);
    if (!/^\d+$/.test(rawPid) || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(sink) || sink < 0 ||
        typeof binary !== 'string' || !binary.trim() || typeof name !== 'string' || !name.trim() || typeof monitor !== 'string' || !monitor) continue;
    const proc = getProcess(pid);
    if (!proc || belongsToProcess(pid, owner, getProcess) !== false) continue;
    const volume = Object.values(item.volume || {}).map(channel => Number(channel.value));
    if (!volume.length || volume.some(value => !Number.isSafeInteger(value) || value < 0)) continue;
    safe.push({ index, sink, pid, started: proc.started, monitor, name: name.slice(0, 120), binary: binary.slice(0, 120),
      appKey: applicationKey(name, binary), identity: `${index}:${pid}:${proc.started}`, muted: Boolean(item.mute), volume,
      monitorHasVolume: String(props['monitor.channel-volumes']).toLowerCase() === 'true' });
  }
  return safe;
}
async function listStreams(owner) {
  const [inputs, sinks] = await Promise.all([pactl('--format=json', 'list', 'sink-inputs'), pactl('--format=json', 'list', 'sinks')]);
  let parsedInputs, parsedSinks;
  try { parsedInputs = JSON.parse(inputs); parsedSinks = JSON.parse(sinks); }
  catch { throw new Error('无法读取 Linux 音频设备列表。'); }
  if (!Array.isArray(parsedInputs) || !Array.isArray(parsedSinks)) throw new Error('无法读取 Linux 音频设备列表。');
  return safeStreams(parsedInputs, parsedSinks, owner);
}
function applications(streams) {
  const unique = new Map();
  for (const item of streams) if (!unique.has(item.appKey)) unique.set(item.appKey, { id: item.appKey, name: item.name, binary: item.binary });
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function volumeForGain(volume, gain) {
  // PulseAudio's normalized volume is cubic: halving amplitude is cbrt(.5).
  return volume.map(value => Math.max(0, Math.min(0x7fffffff, Math.round(value * Math.cbrt(gain)))));
}
function volumesEqual(a, b) {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= 2);
}
function mixBuffers(lanes, bytes) {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) {
    let value = 0;
    for (const lane of lanes) if (i + 1 < lane.buffer.length) value += lane.buffer.readInt16LE(i) * lane.gains[(i / 2) % 2];
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i);
  }
  return out;
}
module.exports = { pactl, verifyTools, processInfo, belongsToProcess, safeStreams, listStreams, applications, volumeForGain, volumesEqual, mixBuffers };
