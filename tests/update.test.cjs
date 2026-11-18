const test = require('node:test');
const assert = require('node:assert/strict');
const { isNewerVersion, parseInstallerURL, selectInstaller } = require('../app/update.cjs');

test('update checks never offer an older or invalid release', () => {
  assert.equal(isNewerVersion('v1.2.3', '1.2.2'), true);
  assert.equal(isNewerVersion('v1.2.3', '1.2.3'), false);
  assert.equal(isNewerVersion('v1.2.2', '1.2.3'), false);
  assert.equal(isNewerVersion('v1.3.0-beta', '1.2.3'), false);
});

test('automatic update only accepts matching release assets from the project repository', () => {
  const url = 'https://github.com/baek-nanxun/yingban-windows/releases/download/v1.2.3/YingBan-Setup-1.2.3.exe';
  assert.deepEqual(parseInstallerURL(url), { version: '1.2.3', manifestURL: 'https://github.com/baek-nanxun/yingban-windows/releases/download/v1.2.3/checksums.json' });
  for (const invalid of [url.replace('baek-nanxun', 'someone'), url.replace('Setup-1.2.3', 'Setup-1.2.4'), url.replace('https:', 'http:')]) assert.throws(() => parseInstallerURL(invalid));
});
test('automatic update requires a bounded installer size and SHA-256 in the release manifest', () => {
  const valid = { file: 'YingBan-Setup-1.2.3.exe', bytes: 100, sha256: 'a'.repeat(64) };
  assert.equal(selectInstaller([valid], '1.2.3'), valid);
  for (const manifest of [[], [{ ...valid, bytes: 0 }], [{ ...valid, bytes: 600 * 1024 * 1024 }], [{ ...valid, sha256: 'bad' }]]) assert.throws(() => selectInstaller(manifest, '1.2.3'));
});
