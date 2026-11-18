const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, shell, screen } = require('electron');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const { join } = require('node:path');
const { release } = require('node:os');
const { WebSocket } = require('ws');
const { createRoom, parseInvite, discoverRoom } = require('./room.cjs');
const { isNewerVersion, parseInstallerURL, selectInstaller } = require('./update.cjs');
const isWindows = process.platform === 'win32';
const windowIcon = join(__dirname, isWindows ? 'icon.ico' : 'icon.png');

function nativeHelperPath() {
  const bundled = join(__dirname, '../native/bin/YingBan.Audio.exe');
  const external = join(process.resourcesPath || '', 'native/bin/YingBan.Audio.exe');
  return app.isPackaged && fs.existsSync(external) ? external : bundled;
}

// Invitees need routable adapter candidates, including a Tailscale adapter.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
let window, settingsWindow, miniWindow, room, socket, capture, selectedSource, captureTask, grantedSource;
let pendingProtocolInvite;
let miniState = { inRoom: false, voiceOnly: false, mic: false };
let windowMode = 'connect';
let preferences = { duckEnabled: true, duckDepth: 15, sharedVolume: 80, sensitivity: 42, micDevice: '', outputDevice: '', inputMode: 'standard', displayName: '', avatarData: '' };
let deviceList = [], runtimeStatus = {};
function settingsSnapshot() { return { preferences, devices: deviceList, status: runtimeStatus, version: app.getVersion(), platform: process.platform, nativeAudio: isWindows && Number(release().split('.')[2]) >= 20348 }; }
function sendSettings() {
  const snapshot = settingsSnapshot();
  sendWindow(window, 'settings:changed', snapshot);
  sendWindow(settingsWindow, 'settings:changed', snapshot);
}
function setWindowMode(mode) {
  if (!window || window.isDestroyed() || !['connect', 'session'].includes(mode) || mode === windowMode) return;
  windowMode = mode;
  const available = screen.getDisplayMatching(window.getBounds()).workArea;
  const desired = mode === 'connect' ? [800, 560] : [1280, 820];
  const minimum = mode === 'connect' ? [720, 500] : [900, 640];
  if (window.isMaximized()) window.unmaximize();
  window.setMinimumSize(Math.min(minimum[0], available.width), Math.min(minimum[1], available.height));
  window.setSize(Math.min(desired[0], available.width), Math.min(desired[1], available.height));
  window.center();
}
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  const available = screen.getDisplayMatching(window.getBounds()).workArea;
  settingsWindow = new BrowserWindow({ parent: window, width: Math.min(760, available.width), height: Math.min(640, available.height), minWidth: 660, minHeight: 540, title: '映伴设置', icon: windowIcon, backgroundColor: '#f6f1eb', autoHideMenuBar: true, show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.loadFile(join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show(); });
  settingsWindow.on('closed', () => { settingsWindow = undefined; ui('settings:visible', false); });
  ui('settings:visible', true);
}
function showMiniIfNeeded() {
  if (!window || window.isDestroyed() || !miniState.inRoom || !miniState.voiceOnly || !window.isMinimized()) { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide(); return; }
  if (!miniWindow || miniWindow.isDestroyed()) {
    miniWindow = new BrowserWindow({ width: 68, height: 68, frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, show: false, title: '映伴麦克风', icon: windowIcon, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    miniWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    miniWindow.loadFile(join(__dirname, 'mini.html'));
    miniWindow.webContents.once('did-finish-load', () => sendWindow(miniWindow, 'mini:state', miniState));
    miniWindow.on('closed', () => { miniWindow = undefined; });
    const workArea = screen.getPrimaryDisplay().workArea;
    miniWindow.setPosition(workArea.x + workArea.width - 84, workArea.y + workArea.height - 84, false);
  }
  try {
    if (miniWindow.isDestroyed()) return;
    miniWindow.webContents.send('mini:state', miniState);
    miniWindow.show(); miniWindow.setAlwaysOnTop(true, 'floating');
  } catch { miniWindow = undefined; }
}
function isInviteUrl(value) { return typeof value === 'string' && /^(?:yingban|clearcall):\/\//i.test(value); }
function isWebInviteUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://baek-nanxun.github.io' && url.pathname === '/yingban-windows/join/' && isInviteUrl(decodeURIComponent(url.searchParams.get('target') || ''));
  } catch { return false; }
}
function isInviteClipboardText(value) {
  const match = String(value).match(/https:\/\/baek-nanxun\.github\.io\/yingban-windows\/join\/\?target=[^\s]+/);
  return Boolean(match && isWebInviteUrl(match[0]));
}
function protocolArgument(argv) { return argv.find(value => isInviteUrl(value)); }
function queueProtocolInvite(value) {
  if (!isInviteUrl(value)) return;
  pendingProtocolInvite = value;
  if (window && !window.isDestroyed() && !window.webContents.isLoading()) ui('protocol:invite', value);
}
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
app.on('second-instance', (_event, argv) => queueProtocolInvite(protocolArgument(argv)));
app.on('open-url', (event, value) => { event.preventDefault(); queueProtocolInvite(value); });
let captureGeneration = 0;
async function ensureFirewallRules() {
  if (!isWindows || process.env.CLEARCALL_TEST === '1') return { skipped: true };
  const rules = [
    ['YingBan Signaling TCP', 'TCP', '43127'],
    ['YingBan Room Discovery UDP', 'UDP', '43128'],
    ['YingBan WebRTC UDP', 'UDP', 'program']
  ];
  const missing = [];
  for (const [name] of rules) {
    try { await runFile('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { windowsHide: true }); }
    catch { missing.push(name); }
  }
  if (!missing.length) return { ready: true };
  try {
    const program = process.execPath.replace(/"/g, '');
    const command = `Start-Process netsh -Verb RunAs -ArgumentList 'advfirewall firewall add rule name="YingBan Signaling TCP" dir=in action=allow enable=yes profile=private,domain protocol=TCP localport=43127' -Wait; Start-Process netsh -Verb RunAs -ArgumentList 'advfirewall firewall add rule name="YingBan Room Discovery UDP" dir=in action=allow enable=yes profile=private,domain protocol=UDP localport=43128' -Wait; Start-Process netsh -Verb RunAs -ArgumentList 'advfirewall firewall add rule name="YingBan WebRTC UDP" dir=in action=allow enable=yes profile=private,domain protocol=UDP program="${program}"' -Wait`;
    await runFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: false, timeout: 30000 });
    return { ready: true, added: missing };
  } catch (error) {
    return { ready: false, missing, message: 'Windows 防火墙没有允许映伴接收局域网连接。请在防火墙提示中允许映伴，或执行使用说明中的两条管理员命令。' };
  }
}
function sendWindow(windowRef, channel, data) {
  try { if (windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) windowRef.webContents.send(channel, data); } catch {}
}
const ui = (channel, data) => sendWindow(window, channel, data);
function stopCapture() {
  captureGeneration++;
  const current = capture;
  capture = undefined;
  captureTask = undefined;
  if (!current) return;
  current.stdin.end('\n');
  const timer = setTimeout(() => { if (current.exitCode === null) current.kill(); }, 1000);
  timer.unref();
  current.once('exit', () => clearTimeout(timer));
}
async function leave() {
  stopCapture();
  selectedSource = grantedSource = undefined;
  const current = socket;
  socket = undefined;
  if (current) current.close(1000, 'Left');
  if (room) { const existing = room; room = undefined; await existing.close(); }
}
async function connect(endpoint) {
  const current = new WebSocket(endpoint, { maxPayload: 128 * 1024, handshakeTimeout: 8000 });
  socket = current;
  let opened = false;
  current.on('message', raw => {
    if (socket !== current) return;
    try { ui('signal', JSON.parse(raw.toString())); } catch { }
  });
  current.on('error', () => {});
  current.on('close', (code, reason) => {
    if (socket === current) { socket = undefined; ui('signal', { type: 'closed', message: opened ? (reason.toString() === 'Room full' ? '通话已满，只支持两台电脑。' : '连接已断开，请重新加入。') : '无法连接到对方。' }); }
  });
  await new Promise((resolve, reject) => {
    current.once('open', () => { opened = true; resolve(); });
    current.once('error', () => reject(new Error('连接失败。请确认对方在线、地址正确，并允许 Windows 防火墙通过。')));
    current.once('close', () => { if (!opened) reject(new Error('连接被拒绝。')); });
  });
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    const ownContents = [window?.webContents, settingsWindow?.webContents, miniWindow?.webContents].filter(Boolean);
    if (!ownContents.includes(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid sender');
    if (event.sender === miniWindow?.webContents && !['mini:action', 'mini:move'].includes(name)) throw new Error('Invalid mini operation');
    if (event.sender === settingsWindow?.webContents && !['settings:get', 'settings:save', 'settings:close', 'app:info', 'updates:check', 'updates:download', 'updates:open'].includes(name)) throw new Error('Invalid settings operation');
    return fn(...args);
  });
}
app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  if (process.env.CLEARCALL_TEST !== '1') {
    try { const saved = JSON.parse(fs.readFileSync(join(app.getPath('userData'), 'preferences.json'), 'utf8')); for (const key of Object.keys(preferences)) if (typeof saved[key] === typeof preferences[key]) preferences[key] = saved[key]; } catch {}
  }
  handle('settings:get', settingsSnapshot);
  handle('settings:open', openSettings);
  handle('settings:close', () => { settingsWindow?.close(); });
  handle('settings:save', patch => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'duckEnabled' && typeof value === 'boolean') preferences[key] = value;
      if (key === 'duckDepth' && Number.isFinite(value)) preferences[key] = Math.max(6, Math.min(24, value));
      if (key === 'sharedVolume' && Number.isFinite(value)) preferences[key] = Math.max(0, Math.min(100, value));
      if (key === 'sensitivity' && Number.isFinite(value)) preferences[key] = Math.max(25, Math.min(60, value));
      if (key === 'micDevice' && typeof value === 'string' && value.length < 1024) preferences[key] = value;
      if (key === 'outputDevice' && typeof value === 'string' && value.length < 1024) preferences[key] = value;
      if (key === 'inputMode' && ['standard', 'compatibility'].includes(value)) preferences[key] = value;
      if (key === 'displayName' && typeof value === 'string') preferences[key] = value.trim().slice(0, 20);
      if (key === 'avatarData' && typeof value === 'string' && (value === '' || (value.length <= 48000 && /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(value)))) preferences[key] = value;
    }
    if (process.env.CLEARCALL_TEST !== '1') fs.writeFileSync(join(app.getPath('userData'), 'preferences.json'), JSON.stringify(preferences));
    sendSettings(); return settingsSnapshot();
  });
  handle('settings:devices', list => { deviceList = Array.isArray(list) ? list.slice(0, 40).map(d => ({ kind: String(d.kind), deviceId: String(d.deviceId), label: String(d.label) })) : []; sendWindow(settingsWindow, 'settings:changed', settingsSnapshot()); });
  handle('settings:status', status => { runtimeStatus = status; sendWindow(settingsWindow, 'settings:runtime', status); });
  handle('mini:state', state => { if (!state || typeof state !== 'object') return; miniState = { inRoom: Boolean(state.inRoom), voiceOnly: Boolean(state.voiceOnly), mic: Boolean(state.mic) }; sendWindow(miniWindow, 'mini:state', miniState); showMiniIfNeeded(); });
  handle('mini:action', action => { if (action === 'toggle-mic') sendWindow(window, 'mini:command', action); });
  handle('mini:move', point => { if (!miniWindow || miniWindow.isDestroyed() || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return; const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea; const x = Math.max(area.x, Math.min(area.x + area.width - 68, Math.round(point.x))); const y = Math.max(area.y, Math.min(area.y + area.height - 68, Math.round(point.y))); miniWindow.setPosition(x, y, false); });
  const localPage = frame => Boolean(frame?.url.startsWith('file:'));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && localPage(contents.mainFrame) && ['media', 'display-capture', 'fullscreen'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && localPage(contents.mainFrame) && ['media', 'display-capture', 'fullscreen'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!selectedSource || request.frame !== window.webContents.mainFrame) { callback({}); return; }
    const id = selectedSource;
    selectedSource = undefined;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find(x => x.id === id);
      grantedSource = source ? { id: source.id, name: source.name } : undefined;
      callback(source ? { video: source } : {});
    } catch { callback({}); }
  });
  handle('room:create', async () => {
    await leave();
    try {
      const firewall = await ensureFirewallRules();
      if (firewall.ready === false) throw new Error(firewall.message);
      room = await createRoom(process.env.CLEARCALL_TEST === '1' ? { port: 0, host: '0.0.0.0' } : {});
      await connect(`ws://127.0.0.1:${room.port}/${room.token}`);
      return { invites: room.invites, roomId: room.roomId };
    } catch (error) {
      await leave();
      throw new Error(error.code === 'EADDRINUSE' ? '43127 端口已被占用，请先关闭另一个映伴实例。' : error.message);
    }
  });
  handle('room:join', async input => {
    if (typeof input !== 'string' || input.length > 300) throw new Error('邀请地址无效。');
    const endpoint = input.startsWith('ws://') ? (() => { const url = new URL(input); if (!/^ws:$/.test(url.protocol) || !/^\d{1,5}$/.test(url.port) || !/^\/[a-f0-9]{48}$/.test(url.pathname)) throw new Error('房间发现地址无效。'); return input; })() : parseInvite(input).endpoint;
    await leave();
    await connect(endpoint);
    return true;
  });
  handle('room:discover', async code => {
    const result = await discoverRoom(String(code));
    return result;
  });
  handle('window:mode', mode => { setWindowMode(mode); return mode; });
  handle('room:leave', leave);
  handle('signal:send', message => {
    if (message && ['description', 'candidate', 'peer-state', 'profile'].includes(message.type) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  });
  handle('sources:list', async () => {
    const sources = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })).filter(x => !x.name.startsWith('映伴')).map(x => ({ id: x.id, name: x.name, kind: x.id.startsWith('window:') ? 'app' : 'screen', thumbnail: x.thumbnail.toDataURL() }));
    try {
      if (!isWindows) return sources;
      const { stdout } = await runFile(nativeHelperPath(), ['--list-windows', String(process.pid)], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
      const visibleNames = new Set(sources.filter(source => source.kind === 'app').map(source => source.name));
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const [handle, minimized, ...titleParts] = line.split('|'); const name = titleParts.join('|').trim();
        if (!name || visibleNames.has(name)) continue;
        sources.push({ id: `window-hwnd:${handle}`, name: `${name}${minimized === '1' ? '（后台窗口，选择后恢复）' : ''}`, kind: 'app', thumbnail: '' });
      }
    } catch {}
    return sources;
  });
  handle('sources:select', async id => {
    if (typeof id !== 'string' || !/^(?:screen|window):|^window-hwnd:/.test(id)) throw new Error('无效的共享窗口。');
    if (!isWindows) { if (id.startsWith('window-hwnd:')) throw new Error('无效的共享窗口。'); selectedSource = id; grantedSource = undefined; return; }
    if (id.startsWith('window-hwnd:')) {
      const handle = id.slice('window-hwnd:'.length);
      await runFile(nativeHelperPath(), ['--restore-window', handle], { windowsHide: true, timeout: 5000 });
      await new Promise(resolve => setTimeout(resolve, 250));
      const refreshed = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      let title = '';
      try { const listing = await runFile(nativeHelperPath(), ['--list-windows', String(process.pid)], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }); title = listing.stdout.split(/\r?\n/).map(line => line.split('|')).find(parts => parts[0] === handle)?.slice(2).join('|').trim() || ''; } catch {}
      const match = refreshed.find(source => source.name && source.name === title);
      if (!match) throw new Error('恢复窗口后仍无法获得可共享画面，请确认应用没有被系统隐藏。');
      selectedSource = match.id;
    } else if (id.startsWith('window:')) {
      const match = /^window:(\d+):\d+$/.exec(id);
      if (match) await runFile(nativeHelperPath(), ['--restore-window', match[1]], { windowsHide: true, timeout: 5000 });
    }
    if (!selectedSource) selectedSource = id;
    grantedSource = undefined;
  });
  handle('audio:start', () => {
    if (!isWindows) throw new Error('当前 Linux 版本暂不支持共享应用声音，可继续共享画面和麦克风。');
    if (captureTask) return captureTask;
    const source = grantedSource;
    if (!source) throw new Error('请先选择并开始共享屏幕或应用。');
    const build = Number(release().split('.')[2]);
    if (build < 20348) throw new Error('安全采集电脑声音需要 Windows 11。当前系统可仅共享画面。');
    const helper = nativeHelperPath();
    const generation = captureGeneration;
    captureTask = (async () => {
    let targetPid = 0;
    if (source.id.startsWith('window:')) {
      const match = /^window:(\d+):\d+$/.exec(source.id);
      if (!match) throw new Error('无法确定这个窗口所属的应用，已停止音频共享。');
      try {
        const { stdout } = await runFile(helper, ['--window-pid', match[1], String(process.pid)], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
        targetPid = Number(stdout.trim());
        if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || targetPid === process.pid) throw new Error('Invalid PID');
      } catch { throw new Error('无法安全识别这个窗口的独立应用音频。请关闭音频选项后共享画面，或选择其他应用。不会改为共享整机声音。'); }
    }
    if (generation !== captureGeneration) throw new Error('共享已取消。');
    const scope = { kind: targetPid ? 'app' : 'screen', targetPid, name: source.name };
    const current = spawn(helper, [String(process.pid), '0', String(targetPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    capture = current;
    let ready = false;
    return await new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(() => { reject(new Error('电脑声音采集启动超时。')); stopCapture(); }, 12000);
      current.stderr.on('data', chunk => {
        stderr += chunk.toString();
        let newline;
        while ((newline = stderr.indexOf('\n')) !== -1) {
          const line = stderr.slice(0, newline).trim(); stderr = stderr.slice(newline + 1);
          if (!ready && line.startsWith('READY ')) { ready = true; clearTimeout(timeout); resolve({ sampleRate: 48000, channels: 2, scope }); }
          if (capture === current && line.startsWith('DUCKED ')) ui('audio:ducked', { gain: Number(line.slice(7)) });
        }
      });
      current.stdout.on('data', chunk => { if (capture === current) ui('audio:pcm', chunk); });
      current.stdin.on('error', () => {});
      current.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动电脑声音采集组件。')); if (capture === current) { capture = undefined; captureTask = undefined; } });
      current.on('exit', code => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`电脑声音采集失败（${code}）。请使用 Windows 11，或关闭“共享电脑声音”后重试。`));
        if (capture === current) { capture = undefined; captureTask = undefined; ui('audio:ended', { code }); }
      });
    });
    })().catch(error => { if (generation === captureGeneration) captureTask = undefined; throw error; });
    return captureTask;
  });
  handle('audio:stop', () => { stopCapture(); return true; });
  handle('audio:duck', gain => {
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0.05 || gain > 1) throw new Error('Invalid volume');
    if (capture && capture.stdin.writable) capture.stdin.write(`DUCK ${gain.toFixed(5)}\n`);
  });
  handle('clipboard:copy', text => { if (typeof text === 'string' && text.length < 1200 && (/^\d{6}$/.test(text) || (/^(?:yingban|clearcall):\/\//.test(text) && text.length < 300) || isWebInviteUrl(text) || isInviteClipboardText(text))) clipboard.writeText(text); });
  handle('updates:check', async () => {
    const repo = process.env.YINGBAN_GITHUB_REPO || 'baek-nanxun/yingban-windows';
    if (!/^[^/]+\/yingban-windows$/.test(repo)) return { available: false, configured: false, message: 'GitHub 更新地址尚未配置。' };
    const current = `v${app.getVersion()}`;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'YingBan' };
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(6000) });
      if (response.ok) {
        const latest = await response.json();
        const assets = (latest.assets || []).map(asset => ({ name: asset.name, url: asset.browser_download_url }));
        const installer = isWindows ? assets.find(asset => /^YingBan-Setup-\d+\.\d+\.\d+\.exe$/i.test(asset.name)) : undefined;
        return { available: isNewerVersion(latest.tag_name, current), configured: true, tag: latest.tag_name, url: latest.html_url, downloadURL: installer?.url, assets, testMode: process.env.CLEARCALL_TEST === '1' };
      }
    } catch {}
    // The public API is rate-limited on shared networks. The release page is
    // still available and redirects to the current tag without an API token.
    const page = await fetch(`https://github.com/${repo}/releases/latest`, { headers: { 'user-agent': 'YingBan' }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
    if (!page.ok) throw new Error(`GitHub 返回 HTTP ${page.status}`);
    const match = page.url.match(/\/releases\/tag\/([^/?#]+)/);
    if (!match) return { available: false, configured: true, tag: current, url: `https://github.com/${repo}/releases` };
    const tag = decodeURIComponent(match[1]);
    return { available: isNewerVersion(tag, current), configured: true, tag, url: page.url, downloadURL: isWindows ? `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/YingBan-Setup-${tag.replace(/^v/i, '')}.exe` : undefined, assets: [], testMode: process.env.CLEARCALL_TEST === '1' };
  });
  handle('updates:download', async info => {
    const url = typeof info === 'string' ? info : info?.downloadURL;
    const { version, manifestURL } = parseInstallerURL(url);
    const manifestResponse = await fetch(manifestURL, { headers: { 'user-agent': 'YingBan' }, signal: AbortSignal.timeout(15000) });
    if (!manifestResponse.ok) throw new Error('无法获取安装包校验信息。');
    const manifest = await manifestResponse.json();
    const expected = selectInstaller(manifest, version);
    const response = await fetch(url, { headers: { 'user-agent': 'YingBan' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`下载安装包失败（HTTP ${response.status}）。`);
    const total = expected.bytes; let received = 0; const hash = createHash('sha256');
    if (!response.body) throw new Error('下载响应为空。');
    const file = join(app.getPath('temp'), `YingBan-Setup-${randomUUID()}.exe`);
    try {
      const handle = await fs.promises.open(file, 'wx');
      try {
        for await (const chunk of response.body) { const data = Buffer.from(chunk); received += data.length; if (received > total) throw new Error('安装包大小不匹配。'); hash.update(data); await handle.writeFile(data); const progress = { received, total, percent: Math.round(received / total * 100) }; sendWindow(window, 'updates:progress', progress); sendWindow(settingsWindow, 'updates:progress', progress); }
      } finally { await handle.close(); }
      if (received !== total || hash.digest('hex').toLowerCase() !== expected.sha256.toLowerCase()) throw new Error('安装包校验失败，请手动下载。');
      const installer = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { installer.once('spawn', resolve); installer.once('error', reject); }); installer.unref();
      setTimeout(() => app.quit(), 300);
      return { started: true };
    } catch (error) { await fs.promises.unlink(file).catch(() => {}); throw error; }
  });
  handle('updates:open', async url => { if (typeof url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/yingban-windows\/(?:releases\/|releases\/download\/)/.test(url)) throw new Error('更新地址无效。'); await shell.openExternal(url); });
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, systemRelease: release(), windows: isWindows ? release() : undefined, nativeAudio: isWindows && Number(release().split('.')[2]) >= 20348, testMode: process.env.CLEARCALL_TEST === '1' }));
  if (process.platform === 'win32' || process.platform === 'linux') {
    for (const scheme of ['yingban', 'clearcall']) {
      if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1]]);
      else app.setAsDefaultProtocolClient(scheme);
    }
  }
  window = new BrowserWindow({ width: 800, height: 560, minWidth: 720, minHeight: 500, backgroundColor: '#f6f1eb', title: '映伴', icon: windowIcon, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { void leave(); });
  window.loadFile(join(__dirname, 'index.html'));
  window.webContents.once('did-finish-load', () => {
    const invite = pendingProtocolInvite || protocolArgument(process.argv);
    pendingProtocolInvite = undefined;
    if (invite) ui('protocol:invite', invite);
  });
  window.on('closed', () => { window = undefined; if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy(); void leave(); });
  window.on('minimize', showMiniIfNeeded);
  window.on('restore', () => { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { stopCapture(); if (socket) socket.terminate(); });
