const { _electron: electron } = require('playwright');
const { join } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const app = await electron.launch({ args: [join(__dirname, 'site-fixture.cjs')] });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('h1');
    assert.match(await page.locator('h1').innerText(), /一起看屏幕/);
    assert.match(await page.locator('a.primary').getAttribute('href'), /YingBan-Setup-1\.0\.3\.exe$/);
    await page.screenshot({ path: join(__dirname, '../test-results/ui-homepage.png'), fullPage: true, scale: 'css' });
    console.log('PASS: homepage contains the current Windows installer download.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
