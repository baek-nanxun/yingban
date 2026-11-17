const { _electron } = require('playwright');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const root = join(__dirname, '..');
(async () => {
  const app = await _electron.launch({ executablePath: join(root, 'dist/YingBan-Windows/YingBan.exe'), args: [`--user-data-dir=${join(root, 'test-results/profile-packaged')}`], env: { ...process.env, CLEARCALL_TEST: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.clearcallDiagnostics === 'function');
    assert(await app.evaluate(({ app }) => app.isPackaged));
    const info = await page.evaluate(() => window.clearcall.info());
    assert.equal(info.version, require('../package.json').version);
    const sources = await page.evaluate(() => window.clearcall.sources());
    assert(Array.isArray(sources));
    console.log('PASS: portable executable opens packaged resources, IPC, and desktop source enumeration without Node.js or SDK installation.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
