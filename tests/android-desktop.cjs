// Run with an Android emulator connected and the debug APK installed.
const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const root = join(__dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'yingban-android-'));
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 20000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hierarchy() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/yingban-window.xml');
  return adb('shell', 'cat', '/sdcard/yingban-window.xml');
}
async function waitForDescription(description, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const xml = await hierarchy();
    const node = xml.match(new RegExp(`content-desc="${description}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
    if (node) return node.slice(1).map(Number);
    await pause(1000);
  }
  throw new Error(`Android control or video not found: ${description}`);
}
(async () => {
  let app;
  try {
    adb('shell', 'pm', 'grant', 'com.yingban.mobile', 'android.permission.RECORD_AUDIO');
    app = await electron.launch({ args: [root, '--no-sandbox', `--user-data-dir=${join(temp, 'host')}`], env: { ...process.env, CLEARCALL_TEST: '1' } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.clearcallDiagnostics);
    await page.evaluate(() => { window.testPeerStates = []; window.clearcall.onSignal(message => { if (message.type === 'peer-state') window.testPeerStates.push({ muted: message.muted, sharing: message.sharing }); }); });
    await page.locator('#createRoom').click();
    await page.waitForFunction(() => document.querySelector('#inviteSelect').options.length > 0);
    const invite = await page.locator('#inviteSelect').inputValue(), url = new URL(invite);
    const mobileInvite = `yingban://10.0.2.2:${url.port}${url.pathname}`;
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', mobileInvite, 'com.yingban.mobile');
    await page.waitForFunction(() => window.clearcallDiagnostics().connection === 'connected', null, { timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('#remoteVoice').textContent === '未开麦');
    const [x1, y1, x2, y2] = await waitForDescription('开启麦克风');
    adb('shell', 'input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2)));
    try { await page.waitForFunction(() => window.testPeerStates.some(state => state.muted === false), null, { timeout: 30000 }); }
    catch (error) {
      console.error('Android microphone state:', await page.evaluate(() => ({ states: window.testPeerStates, voice: document.querySelector('#remoteVoice').textContent, diagnostics: window.clearcallDiagnostics() })));
      console.error('Android controls:', (await hierarchy()).replace(/[a-f0-9]{48}/g, '[redacted]'));
      throw error;
    }
    await page.locator('#shareScreen').click(); await page.locator('.source-item').first().click(); await page.locator('#confirmShare').click();
    await page.waitForFunction(() => window.clearcallDiagnostics().sharing, null, { timeout: 30000 });
    await waitForDescription('共享画面已接收', 60000);
    assert.equal((await page.evaluate(() => window.clearcallDiagnostics())).computerAudio, false);
    console.log('PASS: Android emulator joins a Linux desktop, enables its microphone, and renders shared video.');
  } catch (error) {
    try { console.error(adb('logcat', '-d', '-t', '300').replace(/[a-f0-9]{48}/g, '[redacted]')); } catch { }
    throw error;
  } finally {
    try { adb('shell', 'am', 'force-stop', 'com.yingban.mobile'); } catch { }
    if (app) await app.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
