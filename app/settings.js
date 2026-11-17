(() => {
  const api = window.clearcall, $ = id => document.getElementById(id);
  let snapshot, runtime = {}, updateURL, saveTimer;
  const labels = () => { $('volumeLabel').textContent = `${$('sharedVolume').value}%`; $('depthLabel').textContent = `${$('duckDepth').value} dB`; const n = Number($('sensitivity').value); $('sensitivityLabel').textContent = n > 49 ? '偏高' : n < 36 ? '偏低' : '适中'; };
  function applyStatus(value) {
    runtime = value || {};
    $('localMeter').style.transform = `scaleX(${Math.min(1, (runtime.localLevel || 0) * 4.3)})`;
    $('remoteMeter').style.transform = `scaleX(${Math.min(1, (runtime.remoteLevel || 0) * 4.3)})`;
    $('localVoice').textContent = !runtime.mic ? '未开启' : runtime.speaking ? '说话中' : '安静';
    $('remoteVoice').textContent = !runtime.connected ? '未连接' : runtime.remoteMuted ? '未开麦' : runtime.remoteSpeaking ? '说话中' : '安静';
    const receivingOnly = runtime.peerSharing && !runtime.sharing;
    $('duckEnabled').disabled = $('duckDepth').disabled = Boolean(receivingOnly);
    if (receivingOnly) { $('duckEnabled').checked = runtime.peerDuckEnabled !== false; $('duckDepth').value = runtime.peerDuckDepth || 15; }
    else if (snapshot) { $('duckEnabled').checked = snapshot.preferences.duckEnabled; $('duckDepth').value = snapshot.preferences.duckDepth; }
    $('duckDescription').textContent = receivingOnly ? '此房间由共享者控制人声优先。' : '任意一方说话时降低共享内容的声音。';
    $('duckStatus').textContent = runtime.ducking ? '共享端正在降低背景音' : runtime.sharing || runtime.peerSharing ? '背景音正常' : '';
    labels();
  }
  function apply(value) {
    snapshot = value;
    const p = value.preferences;
    const selection = p.micDevice;
    $('micDevice').replaceChildren(new Option('系统默认', ''));
    for (const d of (value.devices || []).filter(d => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId))) $('micDevice').add(new Option(d.label || '麦克风', d.deviceId));
    if (Array.from($('micDevice').options).some(o => o.value === selection)) $('micDevice').value = selection;
    const actualDefault = value.devices?.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
    const selectedLabel = selection ? $('micDevice').selectedOptions[0]?.text : actualDefault?.label || '';
    $('deviceHint').textContent = /bluetooth|蓝牙|FreeClip|FreeBuds|AirPods/i.test(selectedLabel) ? '当前为蓝牙输入设备，开启后可能切换耳机通话模式。' : value.devices?.some(d => d.kind === 'audioinput') ? '' : '未检测到输入设备';
    $('inputMode').value = p.inputMode;
    $('sharedVolume').value = p.sharedVolume; $('sensitivity').value = p.sensitivity;
    $('duckEnabled').checked = p.duckEnabled; $('duckDepth').value = p.duckDepth;
    $('versionLabel').textContent = `YingBan ${value.version}`; $('aboutVersion').textContent = `版本 ${value.version} · Windows`;
    applyStatus(value.status || runtime);
  }
  let pendingPatch = {};
  const save = patch => { pendingPatch = { ...pendingPatch, ...patch }; clearTimeout(saveTimer); saveTimer = setTimeout(async () => { const next = pendingPatch; pendingPatch = {}; try { await api.saveSettings(next); $('saveStatus').textContent = '已保存'; } catch { pendingPatch = { ...next, ...pendingPatch }; $('saveStatus').textContent = '保存失败，请重试'; } }, 100); };
  for (const id of ['sharedVolume', 'duckDepth', 'sensitivity']) $(id).addEventListener('input', () => { labels(); save({ [id]: Number($(id).value) }); });
  $('duckEnabled').addEventListener('change', () => save({ duckEnabled: $('duckEnabled').checked }));
  for (const id of ['micDevice', 'inputMode']) $(id).addEventListener('change', () => save({ [id]: $(id).value }));
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    for (const button of document.querySelectorAll('[data-tab]')) { button.classList.toggle('active', button === tab); button.setAttribute('aria-selected', String(button === tab)); }
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
  $('checkUpdate').addEventListener('click', async () => {
    $('checkUpdate').disabled = true; $('updateStatus').textContent = '正在检查更新…'; $('downloadUpdate').hidden = true;
    try { const r = await api.checkUpdates(); $('updateStatus').textContent = !r.configured ? '更新地址未配置' : r.available ? `发现新版本 ${r.tag}` : `已是最新版本 ${r.tag}`; updateURL = r.url; $('downloadUpdate').hidden = !r.available || !r.url; }
    catch (error) { $('updateStatus').textContent = error.message.includes('404') ? '暂未发布新版本' : '暂时无法连接 GitHub'; }
    finally { $('checkUpdate').disabled = false; }
  });
  $('downloadUpdate').addEventListener('click', () => { if (updateURL) void api.openUpdate(updateURL); });
  api.onSettings(apply); api.onRuntime(applyStatus); void api.getSettings().then(apply);
})();
