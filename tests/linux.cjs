const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const root = join(__dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'yingban-linux-')), apps = [];
const errors = [];
async function open(name) {
  const app = await electron.launch({ args: [root, '--no-sandbox', `--user-data-dir=${join(temp, name)}`], env: { ...process.env, CLEARCALL_TEST: '1' } });
  apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.clearcallDiagnostics);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
      oscillator.frequency.value = 170; oscillator.connect(destination); oscillator.start(); await context.resume();
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); void context.close(); }; return destination.stream;
    };
  });
  return { app, page };
}
(async () => {
  try {
    const host = await open('host');
    await host.page.locator('#createRoom').click();
    await host.page.waitForFunction(() => window.clearcallDiagnostics().inRoom && document.querySelector('#roomNumber').textContent.match(/^\d{6}$/));
    const code = await host.page.locator('#roomNumber').innerText();
    await host.page.locator('#copyRoom').click();
    assert.equal(await host.app.evaluate(({ clipboard }) => clipboard.readText()), code);
    const guest = await open('guest');
    await guest.page.locator('#roomInput').fill(code); await guest.page.locator('#joinByRoom').click();
    await Promise.all([host.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected'), guest.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected')]);
    await host.page.locator('#muteMic').click(); await guest.page.locator('#muteMic').click();
    await Promise.all([host.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01), guest.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01)]);
    await host.page.locator('#shareScreen').click();
    const source = host.page.locator('.source-item').first();
    try { await source.waitFor({ timeout: 15000 }); }
    catch (error) {
      console.error('Linux capture diagnostics:', await host.page.evaluate(async () => ({
        notice: document.querySelector('#notice').textContent,
        dialogOpen: document.querySelector('#sourceDialog').open,
        sources: await window.clearcall.sources().then(items => items.map(({ id, name }) => ({ id, name }))).catch(e => ({ error: e.message }))
      })));
      console.error('Linux native sources:', await host.app.evaluate(async ({ desktopCapturer }) => {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
        return sources.map(({ id, name }) => ({ id, name }));
      }));
      throw error;
    }
    assert.equal(await host.page.locator('#includeAudio').isDisabled(), true);
    await source.click();
    await host.page.locator('#confirmShare').click();
    await guest.page.waitForFunction(() => window.clearcallDiagnostics().peerSharing && document.querySelector('#screenVideo').videoWidth > 0, null, { timeout: 30000 });
    assert.equal((await host.page.evaluate(() => window.clearcallDiagnostics())).computerAudio, false);
    assert.deepEqual(errors, []);
    console.log('PASS: Linux room discovery, bidirectional synthetic microphones and screen capture.');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
