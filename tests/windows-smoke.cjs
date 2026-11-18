'use strict';
const { _electron: electron } = require('playwright');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const root = join(__dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'yingban-smoke-')), apps = [], errors = [];
async function open(name) {
  const app = await electron.launch({ args: [root, `--user-data-dir=${join(temp, name)}`], env: { ...process.env, CLEARCALL_TEST: '1', YINGBAN_TEST_HIDDEN: '1', YINGBAN_TEST_DISCOVERY_PORT: '0' } });
  apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.clearcallDiagnostics);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
      oscillator.frequency.value = 170; oscillator.connect(destination); oscillator.start(); await context.resume();
      const track = destination.stream.getAudioTracks()[0], original = track.stop.bind(track);
      track.stop = () => { original(); oscillator.stop(); void context.close(); };
      return destination.stream;
    };
  });
  return { app, page };
}
(async () => {
  try {
    const host = await open('host'), guest = await open('guest');
    await host.page.evaluate(() => document.getElementById('createRoom').click());
    await host.page.waitForFunction(() => window.clearcallDiagnostics().inRoom && document.getElementById('inviteSelect').value);
    const invite = await host.page.evaluate(() => document.getElementById('inviteSelect').value);
    await guest.page.evaluate(value => { document.getElementById('inviteInput').value = value; document.getElementById('joinRoom').click(); }, invite);
    await Promise.all([host.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected'), guest.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected')]);
    await Promise.all([host.page.evaluate(() => document.getElementById('muteMic').click()), guest.page.evaluate(() => document.getElementById('muteMic').click())]);
    await Promise.all([host.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01), guest.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01)]);
    assert.equal(await host.page.locator('#linuxAudioPicker').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: hidden Windows instances connect and exchange synthetic microphone audio.');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
