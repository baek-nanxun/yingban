const { _electron: electron } = require('playwright');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = join(__dirname, '..'), out = join(root, 'test-results');
mkdirSync(out, { recursive: true });
const errors = [], apps = [];
const toneFile = join(root, 'native/bin/TestTone.exe');
execFileSync(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/platform:x64', '/out:' + toneFile, join(__dirname, 'NativeTone.cs')]);
async function open(name) {
  const app = await electron.launch({ args: [root, `--user-data-dir=${join(out, 'profile-' + name)}`], env: { ...process.env, CLEARCALL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  apps.push(app); const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.clearcallDiagnostics);
  await page.evaluate(() => {
    window.testMicCalls = 0; window.testMicTracks = []; window.testNoMic = false;
    navigator.mediaDevices.getUserMedia = async () => {
      window.testMicCalls++;
      if (window.testNoMic) throw new DOMException('No device', 'NotFoundError');
      const context = new AudioContext({ sampleRate: 48000 }), destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(); oscillator.type = 'sawtooth'; oscillator.frequency.value = 170;
      const gain = context.createGain(); gain.gain.value = 0.12; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      window.testMicTracks.push(track);
      track.stop = () => { stop(); try { oscillator.stop(); } catch {} void context.close().catch(() => {}); };
      return destination.stream;
    };
  });
  return { app, page };
}
async function share(page, kind = 'app', quality = '4k') {
  await page.bringToFront(); await page.locator('#shareScreen').click();
  if (kind === 'app') await page.locator('.source-item').filter({ hasText: 'YingBan Test Pattern' }).first().click();
  else await page.locator('.source-item').first().click();
  await page.locator('#videoQuality').selectOption(quality);
  await page.locator('#confirmShare').click();
  await page.waitForFunction(() => window.clearcallDiagnostics().sharing && window.clearcallDiagnostics().computerAudio, null, { timeout: 20000 });
}
async function fullscreen(client) {
  await client.page.bringToFront(); await client.page.locator('#fullscreen').click();
  await client.page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
  assert.equal(await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await client.page.evaluate(() => document.exitFullscreen());
  await client.page.waitForFunction(() => !document.fullscreenElement);
}
(async () => {
  try {
    const a = await open('host');
    await a.page.screenshot({ path: join(out, 'ui-connect.png'), scale: 'css' });
    assert.deepEqual(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), [800, 560]);
    assert.equal(await a.page.locator('#stage').isVisible(), false);
    assert(await a.page.locator('#roomInput').evaluate(node => node.getBoundingClientRect().width >= 150));
    assert(await a.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth));
    await a.page.locator('#createRoom').click();
    await a.page.waitForFunction(() => window.clearcallDiagnostics().inRoom && document.getElementById('inviteSelect').options.length);
    assert.equal(await a.page.evaluate(() => window.testMicCalls), 0);
    assert.equal((await a.page.evaluate(() => window.clearcallDiagnostics())).context, undefined);
    console.log('PASS: creating a room never opens microphone or audio output by default.');
    // No hardware present is an optional-input failure, not a room failure.
    await a.page.evaluate(() => { window.testNoMic = true; }); await a.page.locator('#muteMic').click();
    await a.page.waitForFunction(() => document.getElementById('notice').textContent === '未检测到麦克风');
    assert.equal((await a.page.evaluate(() => window.clearcallDiagnostics())).inRoom, true);
    await a.page.evaluate(() => { window.testNoMic = false; });
    await fullscreen(a);
    const roomNumber = await a.page.locator('#roomNumber').innerText();
    const b = await open('guest'); await b.page.locator('#roomInput').fill(roomNumber); await b.page.locator('#joinByRoom').click();
    await Promise.all([a.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected'), b.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected')]);
    assert.equal(await b.page.evaluate(() => window.testMicCalls), 0);
    await a.page.locator('#muteMic').click(); await b.page.locator('#muteMic').click();
    await Promise.all([a.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01), b.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01)]);
    console.log('PASS: microphones explicitly enabled after connection transmit in both directions.');
    const settingsEvent = a.app.waitForEvent('window');
    await a.page.locator('#settingsButton').click();
    const settings = await settingsEvent;
    await settings.waitForURL('**/settings.html');
    await settings.waitForFunction(() => document.getElementById('versionLabel').textContent.includes('YingBan'));
    await settings.screenshot({ path: join(out, 'ui-settings-audio.png'), scale: 'css' });
    assert.deepEqual(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === '映伴设置').getSize()), [760, 640]);
    assert.deepEqual(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === '映伴').getSize()), [1280, 820]);
    await settings.locator('[data-tab="sharing"]').click();
    await settings.waitForSelector('#duckEnabled', { state: 'visible' });
    await settings.screenshot({ path: join(out, 'ui-settings-sharing.png'), scale: 'css' });
    await settings.locator('#duckDepth').fill('18');
    await a.page.waitForFunction(() => document.getElementById('duckDepth').value === '18');
    await settings.locator('#duckDepth').fill('15');
    await a.page.waitForFunction(() => document.getElementById('duckDepth').value === '15');
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === '映伴设置')?.close());
    await a.page.screenshot({ path: join(out, 'ui-session.png'), scale: 'css' });
    const fixture = await electron.launch({ args: [join(__dirname, 'fixture.cjs'), `--tone=${toneFile}`, `--user-data-dir=${join(out, 'fixture-profile')}`] }); apps.push(fixture); await fixture.firstWindow();
    await share(a.page);
    await b.page.waitForFunction(() => window.clearcallDiagnostics().screen.width >= 3840 && window.clearcallDiagnostics().screen.height >= 2150, null, { timeout: 25000 });
    await a.page.waitForFunction(() => window.clearcallDiagnostics().videoStats.width === 3840);
    const video4k = await a.page.evaluate(() => window.clearcallDiagnostics());
    assert.equal(video4k.audioScope.kind, 'app'); assert.equal(video4k.audioScope.targetPid, await fixture.evaluate(() => process.pid));
    assert.equal(video4k.encoder.encodings[0].maxBitrate, 25000000);
    const colors = await b.page.evaluate(() => {
      const v = document.getElementById('screenVideo'), c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      const x = c.getContext('2d'); x.drawImage(v, 0, 0);
      return [[0.15,0.2],[0.85,0.2],[0.15,0.8],[0.85,0.8]].map(([a,b]) => Array.from(x.getImageData(Math.floor(a*c.width),Math.floor(b*c.height),1,1).data).slice(0,3));
    });
    const expected = [[255,107,107],[101,224,189],[128,167,255],[244,211,122]];
    assert(colors.every((c,i) => c.every((v,j) => Math.abs(v-expected[i][j])<40)));
    await fullscreen(a); await fullscreen(b);
    console.log('PASS: true 4K application capture and fullscreen/ESC work on both the sender and receiver.');
    await a.page.locator('#muteMic').click(); await b.page.locator('#muteMic').click();
    await a.page.waitForFunction(() => !window.clearcallDiagnostics().localDucked);
    assert(await a.page.evaluate(() => window.testMicTracks.every(t => t.readyState === 'ended')));
    assert(await b.page.evaluate(() => window.testMicTracks.every(t => t.readyState === 'ended')));
    // Test tone is a child of the selected app. It must be included by app-tree capture.
    await b.page.waitForFunction(() => window.clearcallDiagnostics().sharedLevel > 0.002);
    const base = (await b.page.evaluate(() => window.clearcallDiagnostics())).sharedLevel;
    await a.page.locator('#muteMic').click();
    await a.page.waitForFunction(() => window.clearcallDiagnostics().localDucked);
    await b.page.waitForFunction(base => window.clearcallDiagnostics().sharedLevel < base*0.5, base);
    assert((await b.page.evaluate(() => window.clearcallDiagnostics())).sharedGain > 0.79);
    await a.page.locator('#muteMic').click();
    await a.page.waitForFunction(() => !window.clearcallDiagnostics().localDucked);
    await b.page.waitForFunction(base => window.clearcallDiagnostics().sharedLevel > base*0.7, base);
    await b.page.locator('#muteMic').click();
    await a.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01 && window.clearcallDiagnostics().localDucked);
    await b.page.waitForFunction(base => window.clearcallDiagnostics().sharedLevel < base*0.5, base);
    console.log('PASS: app-only audio reaches peer; either speaker ducks the selected app; closing microphones releases capture devices.');
    const diagnostics = { host: await a.page.evaluate(() => window.clearcallDiagnostics()), guest: await b.page.evaluate(() => window.clearcallDiagnostics()) };
    await a.page.locator('#stopShare').click(); await b.page.waitForFunction(() => !window.clearcallDiagnostics().peerSharing);
    await share(b.page, 'screen', '1080p');
    await a.page.waitForFunction(() => window.clearcallDiagnostics().screen.width === 1920 && window.clearcallDiagnostics().screen.height === 1080);
    assert.equal((await b.page.evaluate(() => window.clearcallDiagnostics())).audioScope.kind, 'screen');
    await b.page.locator('#stopShare').click();
    // Sharing this very application's audio must fail closed, never capture all apps.
    const selfAttempt = await a.page.evaluate(async () => {
      const sources = await window.clearcall.sources();
      return sources.filter(s => s.name.startsWith('映伴')).length;
    }); assert.equal(selfAttempt, 0);
    await b.page.locator('#leaveRoom').click(); await a.page.locator('#leaveRoom').click();
    await a.page.waitForFunction(() => !window.clearcallDiagnostics().mic && !window.clearcallDiagnostics().context);
    assert.deepEqual(errors, []);
    writeFileSync(join(out,'desktop-results.json'),JSON.stringify({ passed:true,diagnostics,checks:['no-mic startup','optional mic failure','mic release','4K','application scope','screen scope','fullscreen both directions','source-only ducking'] },null,2));
    console.log('PASS: full-screen audio scope, 1080p, disconnect and resource cleanup.');
  } catch(e) {
    console.error(e); for (const app of apps) { try { const p = await app.firstWindow(); console.error(await p.locator('#notice').innerText({timeout:500}), await p.evaluate(() => window.clearcallDiagnostics())); } catch {} } process.exitCode = 1;
  } finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exitCode=1; });
