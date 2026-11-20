const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;

function isNewerVersion(tag, current) {
  const parse = value => { const match = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(value); return match ? match.slice(1).map(Number) : null; };
  const latest = parse(tag), installed = parse(current);
  if (!latest || !installed) return false;
  for (let i = 0; i < 3; i++) { if (latest[i] !== installed[i]) return latest[i] > installed[i]; }
  return false;
}

function parseInstallerURL(url) {
  const match = typeof url === 'string' && /^https:\/\/github\.com\/baek-nanxun\/yingban\/releases\/download\/v(\d+\.\d+\.\d+)\/YingBan-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(url);
  if (!match || match[1] !== match[2]) throw new Error('安装包地址无效。');
  return { version: match[1], manifestURL: url.replace(/YingBan-Setup-\d+\.\d+\.\d+\.exe$/i, 'checksums.json') };
}
function selectInstaller(manifest, version) {
  const item = Array.isArray(manifest) && manifest.find(entry => entry.file === `YingBan-Setup-${version}.exe` && /^[a-f0-9]{64}$/i.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_INSTALLER_BYTES);
  if (!item) throw new Error('安装包校验信息无效，请手动下载。');
  return item;
}
module.exports = { isNewerVersion, parseInstallerURL, selectInstaller };
