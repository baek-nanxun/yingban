const { spawn, execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const root = join(__dirname, '..');
const helper = join(root, 'native/bin/YingBan.Audio.exe');
const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
execFileSync(compiler, ['/nologo', '/platform:x64', '/out:' + join(root, 'native/bin/TestTone.exe'), join(__dirname, 'NativeTone.cs')]);
const children = [];
function start(path, args) {
  const child = spawn(path, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  child.packets = [];
  child.stdout.on('data', bytes => child.packets.push({ time: Date.now(), bytes }));
  child.ready = new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('Native ready timeout')), 15000);
    child.stderr.on('data', bytes => { text += bytes; if (text.includes('READY')) { clearTimeout(timeout); resolve(); } });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(text)); });
  });
  return child;
}
function amplitude(child, from, to) {
  const bytes = Buffer.concat(child.packets.filter(p => p.time >= from && p.time < to).map(p => p.bytes));
  let sum = 0, frames = Math.floor(bytes.length / 4);
  for (let i = 0; i < frames; i++) { const x = bytes.readInt16LE(i * 4) / 32768; sum += x * x; }
  return Math.sqrt(sum / Math.max(frames, 1));
}
(async () => {
  try {
    const tone = start(join(root, 'native/bin/TestTone.exe'), []); await tone.ready;
    const included = start(helper, ['4']); const excluded = start(helper, [String(tone.pid)]);
    await Promise.all([included.ready, excluded.ready]);
    tone.stdin.write('PLAY\n'); await delay(700);
    const baseStart = Date.now(); await delay(600); const baseEnd = Date.now();
    included.stdin.write('DUCK 0.2\n'); await delay(500);
    const duckStart = Date.now(); await delay(600); const duckEnd = Date.now();
    included.stdin.write('DUCK 1\n'); await delay(400);
    const restoreStart = Date.now(); await delay(600); const restoreEnd = Date.now();
    const base = amplitude(included, baseStart, baseEnd), without = amplitude(excluded, baseStart, baseEnd);
    const ducked = amplitude(included, duckStart, duckEnd), restored = amplitude(included, restoreStart, restoreEnd);
    const result = { base, excluded: without, ducked, restored, captureVolumeRatio: ducked / base, restoredRatio: restored / base };
    console.log(JSON.stringify(result, null, 2));
    assert(base > 0.0001, 'Diagnostic tone must reach process capture');
    assert(without < base * 0.12, 'Excluded process must not be recaptured');
    assert(ducked < base * 0.5, 'Source-side attenuation must lower captured background audio');
    assert(restored > base * 0.8, 'Application volume must be restored');
    console.log('Native exclusion and restoration verified. Capture is ' + (ducked < base * 0.5 ? 'post-session-volume.' : 'pre-session-volume.'));
  } finally {
    for (const child of children) if (child.exitCode === null) child.stdin.end('\n');
    await delay(300);
    for (const child of children) if (child.exitCode === null) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
