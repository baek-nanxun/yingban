'use strict';
// Run inside an isolated PipeWire session started by scripts/test-linux-audio.sh.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { listStreams, applications } = require('../app/linux-audio.cjs');
const temp = mkdtempSync(join(tmpdir(), 'yingban-audio-'));
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${description}`);
}
function wave(name, frequency) {
  const frames = 48000 * 120, data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28);
  data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) { const sample = Math.round(Math.sin(i * frequency * Math.PI * 2 / 48000) * 7000); data.writeInt16LE(sample, 44 + i * 4); data.writeInt16LE(sample, 46 + i * 4); }
  const file = join(temp, name + '.wav'); writeFileSync(file, data); return file;
}
function play(name, file) {
  const child = spawn('paplay', ['--device=yingban_test', `--client-name=${name}`, `--property=application.name=${name}`, file], { stdio: 'ignore' });
  children.push(child); return child;
}
function createWorker(owner, scope) {
  const child = spawn(process.execPath, ['--require', join(__dirname, 'linux-audio-worker-faults.cjs'), join(__dirname, '../app/linux-audio-worker.cjs'), String(owner), JSON.stringify(scope)], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let data = Buffer.alloc(0), stderr = '', request = 0;
  const events = [], replies = new Map();
  child.stdout.on('data', chunk => { data = Buffer.concat([data, chunk]); if (data.length > 384000) data = data.subarray(data.length - 384000); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('message', message => { if (message.reply) replies.set(message.reply, message); else events.push(message); });
  async function command(command, options = {}) {
    const id = ++request;
    child.send({ id, command, ...options });
    const reply = await until(() => replies.get(id), `worker command ${command}`);
    replies.delete(id);
    assert(!reply.error, reply.error);
  }
  const count = (event, index) => events.filter(item => item.event === event && (index === undefined || item.index === index)).length;
  return { child, command, count, clear: () => { data = Buffer.alloc(0); }, samples: () => data, log: () => stderr };
}
function amplitude(data, frequency) {
  const count = Math.min(48000, Math.floor(data.length / 4)), start = data.length - count * 4;
  let real = 0, imaginary = 0;
  for (let i = 0; i < count; i++) { const value = data.readInt16LE(start + i * 4) / 32768, phase = i * frequency * Math.PI * 2 / 48000; real += value * Math.cos(phase); imaginary += value * Math.sin(phase); }
  return count ? 2 * Math.hypot(real, imaginary) / count : 0;
}
async function measure(worker) { await delay(600); worker.clear(); await delay(1250); return worker.samples(); }
async function stopped(child) { await until(() => child.exitCode !== null || child.signalCode !== null, 'audio process to stop', 20000); }
function alive(worker) { assert(worker.child.exitCode === null && worker.child.signalCode === null, `worker exited unexpectedly: ${worker.log()}`); }
async function capture(worker, index, after = 0) {
  await until(() => { alive(worker); return worker.count('capture-start', index) > after; }, `capture for stream ${index}`);
}
async function interrupt(worker, index) {
  const previous = worker.count('capture-start', index);
  await worker.command('kill-capture', { index });
  await capture(worker, index, previous);
}

(async () => {
  try {
    const video = wave('video', 440), voice = wave('voice', 1000), video2 = wave('video2', 700);
    // The owner's child represents call playback; it must never enter capture.
    const ownerScript = `const c=require('node:child_process').spawn('paplay',['--device=yingban_test','--client-name=YBVoice','--property=application.name=YBVoice',${JSON.stringify(voice)}],{stdio:'ignore'});process.on('SIGTERM',()=>{c.kill();process.exit(0)});setInterval(()=>{},1000)`;
    const owner = spawn(process.execPath, ['-e', ownerScript], { stdio: 'ignore' }); children.push(owner);
    play('YBVideo', video);
    const stream = await until(async () => (await listStreams(owner.pid)).find(item => item.name === 'YBVideo'), 'video stream');
    execFileSync('pactl', ['set-sink-input-volume', String(stream.index), '65536']);
    await until(() => JSON.parse(execFileSync('pactl', ['--format=json', 'list', 'sink-inputs'], { encoding: 'utf8' })).some(item => item.properties?.['application.name'] === 'YBVoice'), 'call stream');
    assert(!(await listStreams(owner.pid)).some(item => item.name === 'YBVoice'));
    const other = play('YBVideo2', video2);
    await until(async () => (await listStreams(owner.pid)).some(item => item.name === 'YBVideo2'), 'second application');
    const app = applications(await listStreams(owner.pid)).find(item => item.name === 'YBVideo');
    const single = createWorker(owner.pid, { kind: 'app', appKey: app.id });
    await until(() => single.log().includes('READY '), 'single-app worker');
    const normal = await measure(single), before = amplitude(normal, 440);
    assert(before > 0.025, `selected application was not captured (${before}); ${single.log()}`);
    assert(amplitude(normal, 1000) < before * 0.1, 'call playback leaked into single-app capture');
    assert(amplitude(normal, 700) < before * 0.1, 'another application leaked into single-app capture');
    single.child.stdin.write('DUCK 0.17783\n');
    await until(() => single.log().includes('DUCKED 0.17783'), 'local duck');
    const lowered = await measure(single), ratio = amplitude(lowered, 440) / before;
    assert(ratio > 0.08 && ratio < 0.3, `unexpected transmitted duck ratio ${ratio}`);
    const local = (await listStreams(owner.pid)).find(item => item.name === 'YBVideo');
    assert(local.volume[0] < 50000, 'local video did not duck');
    single.child.stdin.write('DUCK 1\n');
    await until(async () => Math.abs((await listStreams(owner.pid)).find(item => item.name === 'YBVideo').volume[0] - 65536) <= 2, 'silence to restore source volume');
    const released = await measure(single);
    assert(amplitude(released, 440) > before * 0.8, 'transmitted audio did not recover after speech');
    single.child.stdin.write('DUCK 0.17783\n');
    await until(async () => (await listStreams(owner.pid)).find(item => item.name === 'YBVideo').volume[0] < 50000, 'duck before stopping');
    single.child.stdin.end('\n'); await stopped(single.child);
    const restored = (await listStreams(owner.pid)).find(item => item.name === 'YBVideo');
    assert(Math.abs(restored.volume[0] - 65536) <= 2, 'local video volume was not restored');
    other.kill('SIGTERM'); await stopped(other);
    await until(async () => !(await listStreams(owner.pid)).some(item => item.name === 'YBVideo2'), 'second application to stop');

    const screen = createWorker(owner.pid, { kind: 'screen' });
    await until(() => screen.log().includes('READY '), 'screen worker');
    play('YBVideo2', video2);
    await until(async () => (await listStreams(owner.pid)).some(item => item.name === 'YBVideo2'), 'second application');
    await delay(1000);
    const mixed = await measure(screen), first = amplitude(mixed, 440), second = amplitude(mixed, 700);
    assert(first > 0.025 && second > 0.025, `screen audio did not include both applications (${first}, ${second})`);
    assert(amplitude(mixed, 1000) < Math.min(first, second) * 0.1, 'call playback leaked into screen capture');
    screen.child.stdin.write('DUCK 0.2\n');
    await until(() => screen.log().includes('DUCKED 0.2'), 'screen duck');
    const active = await listStreams(owner.pid);
    assert(active.filter(item => /^YBVideo/.test(item.name)).every(item => item.volume[0] < 51000));
    // A manual volume choice becomes the new baseline; stopping must retain it.
    execFileSync('pactl', ['set-sink-input-volume', String(stream.index), '54000']);
    await until(async () => (await listStreams(owner.pid)).find(item => item.name === 'YBVideo').volume[0] < 40000, 'manual volume baseline to be ducked');
    screen.child.kill('SIGTERM'); await stopped(screen.child);
    const final = await listStreams(owner.pid);
    assert(Math.abs(final.find(item => item.name === 'YBVideo').volume[0] - 54000) <= 2, 'manual volume was overwritten on shutdown');
    console.log('PASS: PipeWire per-application capture, call exclusion, dynamic screen mixing, speech release, screen ducking and restoration after stdin close/SIGTERM.');

    const churn = createWorker(owner.pid, { kind: 'screen' });
    await capture(churn, stream.index);
    for (let i = 0; i < 10; i++) {
      const player = play('YBChurn', video2);
      const changing = await until(async () => (await listStreams(owner.pid)).find(item => item.name === 'YBChurn'), 'churn stream');
      await capture(churn, changing.index);
      // Force the recorder-exits-before-the-next-snapshot ordering. Some
      // PipeWire versions leave the recorder open when its input disappears.
      await churn.command('kill-capture', { index: changing.index });
      player.kill('SIGTERM'); await stopped(player);
      await until(async () => !(await listStreams(owner.pid)).some(item => item.index === changing.index), 'churn removal');
      alive(churn);
    }
    const afterChurn = await measure(churn);
    assert(amplitude(afterChurn, 440) > 0.025, 'stable audio did not survive ten stream removals');
    assert(amplitude(afterChurn, 1000) < 0.002, 'call playback leaked after churn');
    churn.child.stdin.end('QUIT\n'); await stopped(churn.child);
    assert.equal(churn.child.exitCode, 0, churn.log());
    console.log('PASS: ten real stream removals and recorder exits retain capture without a lifetime failure limit.');

    const recovering = createWorker(owner.pid, { kind: 'app', appKey: app.id });
    await capture(recovering, stream.index);
    recovering.child.stdin.write('DUCK 0.2\n');
    await until(() => recovering.log().includes('DUCKED 0.2'), 'initial recovery-test duck');
    // A failed gain change must not replace the original volume with an
    // already-ducked volume when the refresh retries.
    await recovering.command('faults', { volume: 1 });
    recovering.child.stdin.write('DUCK 0.5\n');
    await until(() => recovering.count('volume-failure') === 1, 'injected volume failure');
    await until(() => recovering.log().includes('DUCKED 0.5'), 'volume retry');
    const expected = Math.round(54000 * Math.cbrt(0.5));
    assert(Math.abs((await listStreams(owner.pid)).find(item => item.index === stream.index).volume[0] - expected) <= 2, 'volume retry lost the original baseline');
    const confirmed = await measure(recovering);
    assert(amplitude(confirmed, 440) > 0.025, 'capture failed to recover from volume error');
    for (let cycle = 0; cycle < 3; cycle++) {
      const failures = recovering.count('metadata-failure');
      const starts = recovering.count('capture-start', stream.index);
      await recovering.command('faults', { metadata: 3 });
      await until(() => recovering.count('metadata-failure') === failures + 3, 'three metadata failures');
      // The third failure backs off for 1.2 s; discard already-delivered PCM
      // and observe silence while authorization is unavailable.
      await delay(100); recovering.clear(); await delay(400);
      assert(recovering.samples().length >= 1920, 'worker stopped emitting frames during recovery');
      assert(recovering.samples().every(value => value === 0), 'stale authorized audio survived metadata failure');
      alive(recovering);
      await capture(recovering, stream.index, starts);
      const resumed = await measure(recovering);
      assert(amplitude(resumed, 440) > 0.025, 'audio did not resume after fresh metadata');
      assert(amplitude(resumed, 1000) < 0.002 && amplitude(resumed, 700) < 0.002, 'unauthorized audio leaked after metadata recovery');
    }
    await recovering.command('faults', { volume: 1 });
    recovering.child.stdin.end('QUIT\n'); await stopped(recovering.child);
    assert.equal(recovering.child.exitCode, 0, recovering.log());
    assert(Math.abs((await listStreams(owner.pid)).find(item => item.index === stream.index).volume[0] - 54000) <= 2, 'shutdown did not retry volume restoration');
    console.log('PASS: nine intermittent metadata failures fail closed and recover; volume errors preserve and restore the baseline.');

    const retries = createWorker(owner.pid, { kind: 'app', appKey: app.id });
    await capture(retries, stream.index);
    retries.child.stdin.write('DUCK 0.2\n');
    await until(() => retries.log().includes('DUCKED 0.2'), 'duck before recorder failures');
    for (let i = 0; i < 7; i++) await interrupt(retries, stream.index);
    // Confirmed healthy capture, not merely a successful metadata query,
    // resets the retry budget for this same input identity.
    await delay(3800);
    assert(amplitude(await measure(retries), 440) > 0.005, 'recorder did not recover after seven exits');
    for (let i = 0; i < 7; i++) await interrupt(retries, stream.index);
    retries.child.send({ id: 1000, command: 'kill-capture', index: stream.index });
    await stopped(retries.child);
    assert.equal(retries.child.exitCode, 1, 'persistent recorder failure was not bounded');
    assert(retries.log().includes('ERROR '), retries.log());
    assert(Math.abs((await listStreams(owner.pid)).find(item => item.index === stream.index).volume[0] - 54000) <= 2, 'recorder retry exhaustion did not restore volume');
    console.log('PASS: healthy capture resets the per-stream budget; eight consecutive recorder failures stop and restore volume.');

    const outage = createWorker(owner.pid, { kind: 'app', appKey: app.id });
    await capture(outage, stream.index);
    outage.child.stdin.write('DUCK 0.2\n');
    await until(() => outage.log().includes('DUCKED 0.2'), 'duck before persistent metadata failure');
    await outage.command('faults', { metadata: 8, volume: 1 });
    await stopped(outage.child);
    assert.equal(outage.child.exitCode, 1, 'persistent metadata failure was not bounded');
    assert.equal(outage.count('metadata-failure'), 8);
    assert(Math.abs((await listStreams(owner.pid)).find(item => item.index === stream.index).volume[0] - 54000) <= 2, 'refresh retry exhaustion did not restore volume');
    console.log('PASS: persistent metadata failure stops after eight attempts and retries restoration.');
  } finally {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
