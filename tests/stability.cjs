const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const root = join(__dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'yingban-stability-')), apps = [], errors = [];
async function open(name) {
  const app = await electron.launch({ args: [root, '--no-sandbox', `--user-data-dir=${join(temp, name)}`], env: { ...process.env, CLEARCALL_TEST: '1', YINGBAN_TEST_DISCOVERY_PORT: '0' } });
  apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.clearcallDiagnostics);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sources:list'); ipcMain.handle('sources:list', () => [{ id: 'screen:test', kind: 'screen', name: 'Stability test screen' }]);
    ipcMain.removeHandler('sources:select'); ipcMain.handle('sources:select', () => {});
    ipcMain.removeHandler('audio:start'); ipcMain.handle('audio:start', () => ({ scope: { kind: 'screen' } }));
  });
  await page.evaluate(() => {
    window.testPeers = []; window.testOffers = 0;
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(options) {
        super(options); window.testPeers.push(this);
        const original = this.getStats.bind(this);
        this.getStats = async () => {
          const reports = await original();
          if (this.freeze) return new Map([...reports].map(([id, r]) => [id, r.type === 'inbound-rtp' && r.kind === 'video' ? { ...r, framesDecoded: this.freeze } : r]));
          return reports;
        };
      }
      createOffer(options) { window.testOffers++; return super.createOffer(options); }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination(), osc = ctx.createOscillator();
      osc.connect(dest); osc.start(); await ctx.resume();
      const track = dest.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); osc.stop(); void ctx.close(); }; return dest.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
      let frame = 0;
      window.testDraw = () => {
        context.fillStyle = '#f6f1eb'; context.fillRect(0, 0, 1280, 720);
        context.fillStyle = '#245b53'; context.font = '48px sans-serif'; context.fillText('YingBan stability test', 80, 140);
        context.fillText(`Frame ${++frame}`, 80, 230); track.requestFrame();
      };
      window.testDraw(); window.testDrawing = setInterval(window.testDraw, 100);
      const stop = track.stop.bind(track); track.stop = () => { clearInterval(window.testDrawing); stop(); };
      window.testCapture = track; return stream;
    };
  });
  return { app, page };
}
(async () => {
  try {
    const host = await open('host'), guest = await open('guest');
    await host.page.locator('#createRoom').click();
    await host.page.waitForFunction(() => document.querySelector('#inviteSelect').options.length);
    const invite = await host.page.locator('#inviteSelect').inputValue();
    await guest.page.evaluate(invite => { document.querySelector('#inviteInput').value = invite; document.querySelector('#joinRoom').click(); }, invite);
    await Promise.all([host, guest].map(c => c.page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected')));
    await host.page.locator('#muteMic').click(); await guest.page.locator('#muteMic').click();
    await Promise.all([host, guest].map(c => c.page.waitForFunction(() => window.clearcallDiagnostics().remoteLevel > 0.01)));
    await host.page.locator('#shareScreen').click(); await host.page.locator('.source-item').first().click(); await host.page.locator('#confirmShare').click();
    await guest.page.waitForFunction(() => window.clearcallDiagnostics().videoStats.framesDecoded > 5);
    assert.equal((await host.page.evaluate(() => window.clearcallDiagnostics())).computerAudio, true);
    await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).webContents.send('audio:ended', { message: '测试声音中断' }));
    await host.page.locator('#retrySharedAudio').waitFor({ state: 'visible' });
    let state = await host.page.evaluate(() => window.clearcallDiagnostics());
    assert.equal(state.sharing, true); assert.equal(state.computerAudio, false); assert.equal(state.mic, true);
    await host.page.locator('#retrySharedAudio').click();
    await host.page.waitForFunction(() => window.clearcallDiagnostics().computerAudio);
    await host.page.screenshot({ path: '/tmp/yingban-stability-host.png' });
    await guest.page.screenshot({ path: '/tmp/yingban-stability-viewer.png' });
    console.log('PASS: real peer media, audio failure isolation and retry preserve video and microphone.');

    await guest.page.evaluate(async () => {
      const peer = window.testPeers.at(-1), stats = await peer.getStats();
      peer.freeze = [...stats.values()].find(r => r.type === 'inbound-rtp' && r.kind === 'video').framesDecoded;
      window.frozenPeer = peer;
    });
    await guest.page.waitForFunction(() => window.testPeers.at(-1) !== window.frozenPeer && window.clearcallDiagnostics().connection === 'connected' && window.clearcallDiagnostics().videoStats.framesDecoded > 0, null, { timeout: 65000 });
    assert.equal(await host.page.evaluate(() => window.testCapture.readyState), 'live');
    state = await host.page.evaluate(() => window.clearcallDiagnostics());
    assert.equal(state.sharing, true); assert.equal(state.mic, true); assert.equal(state.computerAudio, true);
    console.log('PASS: stalled receiver triggers ICE recovery then coordinated peer rebuild without recapturing.');

    const peersBefore = await guest.page.evaluate(() => window.testPeers.length);
    await host.page.evaluate(() => clearInterval(window.testDrawing));
    await guest.page.waitForFunction(start => performance.now() - start > 16000, await guest.page.evaluate(() => performance.now()), { timeout: 20000 });
    assert.equal(await guest.page.evaluate(() => window.testPeers.length), peersBefore);
    console.log('PASS: static screen remains connected without needless peer rebuilds.');
    await host.page.locator('#stopShare').click();
    await host.app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('audio:start'); ipcMain.handle('audio:start', () => { throw new Error('Injected unavailable audio source'); }); });
    await host.page.locator('#shareScreen').click(); await host.page.locator('.source-item').first().click(); await host.page.locator('#confirmShare').click();
    await host.page.locator('#retrySharedAudio').waitFor({ state: 'visible' });
    await guest.page.waitForFunction(() => window.clearcallDiagnostics().peerSharing && window.clearcallDiagnostics().videoStats.health === 'healthy');
    assert.equal((await host.page.evaluate(() => window.clearcallDiagnostics())).sharing, true);
    console.log('PASS: audio startup failure still delivers video.');
    await guest.page.locator('#leaveRoom').click();
    await guest.page.waitForFunction(() => !window.clearcallDiagnostics().inRoom);
    assert.equal(await host.page.evaluate(() => window.testCapture.readyState), 'live');
    assert.deepEqual(errors, []);
    console.log('PASS: explicit leave ends the session without restarting it.');
  } catch (error) {
    for (const app of apps) {
      try { console.error(await app.windows()[0].evaluate(() => ({ diagnostics: window.clearcallDiagnostics(), peers: window.testPeers.length, offers: window.testOffers, notice: document.querySelector('#notice').textContent }))); } catch {}
    }
    throw error;
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
