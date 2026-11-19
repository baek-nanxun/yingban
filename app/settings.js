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
    if (receivingOnly) { $('duckEnabled').checked = runtime.peerDuckEnabled !== false; $('duckDepth').value = runtime.peerDuckDepth || 9; }
    else if (snapshot) { $('duckEnabled').checked = snapshot.preferences.duckEnabled; $('duckDepth').value = snapshot.preferences.duckDepth; }
    $('duckDescription').textContent = receivingOnly ? '此房间由共享者控制人声优先。' : '任意一方说话时降低共享内容的声音。';
    $('duckStatus').textContent = runtime.ducking ? '共享端正在降低背景音' : runtime.sharing || runtime.peerSharing ? '背景音正常' : '';
    labels();
  }
  function apply(value) {
    snapshot = value;
    const p = value.preferences;
    if (document.activeElement !== $('displayName')) $('displayName').value = p.displayName || '';
    $('profileInitial').textContent = Array.from(p.displayName || '我')[0] || '我';
    $('profileImage').hidden = !p.avatarData; $('profileInitial').hidden = Boolean(p.avatarData);
    if (p.avatarData) $('profileImage').src = p.avatarData; else $('profileImage').removeAttribute('src');
    const selection = p.micDevice;
    $('micDevice').replaceChildren(new Option('系统默认', ''));
    for (const d of (value.devices || []).filter(d => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId))) $('micDevice').add(new Option(d.label || '麦克风', d.deviceId));
    if (Array.from($('micDevice').options).some(o => o.value === selection)) $('micDevice').value = selection;
    $('outputDevice').replaceChildren(new Option('系统默认', ''));
    for (const d of (value.devices || []).filter(d => d.kind === 'audiooutput' && !['default', 'communications'].includes(d.deviceId))) $('outputDevice').add(new Option(d.label || '播放设备', d.deviceId));
    if (Array.from($('outputDevice').options).some(o => o.value === p.outputDevice)) $('outputDevice').value = p.outputDevice;
    const actualDefault = value.devices?.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
    const selectedLabel = selection ? $('micDevice').selectedOptions[0]?.text : actualDefault?.label || '';
    $('deviceHint').textContent = /bluetooth|蓝牙|FreeClip|FreeBuds|AirPods/i.test(selectedLabel) ? '蓝牙麦克风会让耳机进入通话模式，音乐可能变差；建议改用电脑内置或 USB 麦克风。' : value.devices?.some(d => d.kind === 'audioinput') ? '' : '未检测到输入设备';
    $('inputMode').value = p.inputMode;
    $('sharedVolume').value = p.sharedVolume; $('sensitivity').value = p.sensitivity;
    $('duckEnabled').checked = p.duckEnabled; $('duckDepth').value = p.duckDepth;
    $('versionLabel').textContent = `YingBan ${value.version}`; $('aboutVersion').textContent = `版本 ${value.version} · ${value.platform === 'linux' ? 'Linux' : 'Windows'}`;
    $('scopeDescription').textContent = value.platform === 'linux' ? '共享窗口时请选择对应的声音应用；整屏共享采集可识别的其他应用，并排除映伴通话。同一浏览器的多个标签页可能共用音频。' : '应用窗口只共享所属应用的声音；整屏共享包含其他应用声音，并排除映伴通话。同一浏览器的多个标签页可能共用音频进程。';
    applyStatus(value.status || runtime);
  }
  let pendingPatch = {};
  const save = patch => { pendingPatch = { ...pendingPatch, ...patch }; clearTimeout(saveTimer); saveTimer = setTimeout(async () => { const next = pendingPatch; pendingPatch = {}; try { await api.saveSettings(next); $('saveStatus').textContent = '已保存'; } catch { pendingPatch = { ...next, ...pendingPatch }; $('saveStatus').textContent = '保存失败，请重试'; } }, 100); };
  $('displayName').addEventListener('input', () => { $('profileInitial').textContent = Array.from($('displayName').value.trim() || '我')[0] || '我'; save({ displayName: $('displayName').value }); });
  $('chooseAvatar').addEventListener('click', () => $('avatarFile').click());
  $('removeAvatar').addEventListener('click', () => { $('profileStatus').textContent = ''; save({ avatarData: '' }); });
  $('avatarFile').addEventListener('change', async () => {
    const file = $('avatarFile').files?.[0]; $('avatarFile').value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { $('profileStatus').textContent = '请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。'; return; }
    try {
      const bitmap = await createImageBitmap(file), canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const size = Math.min(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 128, 128); bitmap.close();
      const avatarData = canvas.toDataURL('image/jpeg', 0.78);
      if (avatarData.length > 48000) throw new Error('图片过大');
      $('profileStatus').textContent = ''; save({ avatarData });
    } catch { $('profileStatus').textContent = '无法读取这张图片，请换一张后重试。'; }
  });
  for (const id of ['sharedVolume', 'duckDepth', 'sensitivity']) $(id).addEventListener('input', () => { labels(); save({ [id]: Number($(id).value) }); });
  $('duckEnabled').addEventListener('change', () => save({ duckEnabled: $('duckEnabled').checked }));
  for (const id of ['micDevice', 'outputDevice', 'inputMode']) $(id).addEventListener('change', () => save({ [id]: $(id).value }));
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    for (const button of document.querySelectorAll('[data-tab]')) { button.classList.toggle('active', button === tab); button.setAttribute('aria-selected', String(button === tab)); }
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
  let downloadURL = '';
  $('checkUpdate').addEventListener('click', async () => {
    $('checkUpdate').disabled = true; $('updateStatus').textContent = '正在检查更新…'; $('downloadUpdate').hidden = true;
    try {
      const r = await api.checkUpdates(); updateURL = r.url || ''; downloadURL = r.downloadURL || '';
      if (!r.configured) $('updateStatus').textContent = '更新地址未配置';
      else if (!r.available) $('updateStatus').textContent = '已是最新版本';
      else if (downloadURL && !r.testMode) {
        $('updateStatus').textContent = `发现新版本 ${r.tag}，正在下载安装包…`;
        $('updateDialogTitle').textContent = `发现新版本 ${r.tag}`; $('updateDialogStatus').textContent = '正在下载安装包…'; $('updateProgress').value = 0; $('manualUpdate').hidden = true; $('closeUpdateDialog').textContent = '后台下载'; $('updateDialog').showModal();
        await api.downloadUpdate({ downloadURL });
        $('updateStatus').textContent = '下载完成，映伴即将退出并安装更新。'; $('updateDialogStatus').textContent = $('updateStatus').textContent;
      } else {
        $('updateStatus').textContent = `发现新版本 ${r.tag}，请前往下载。`;
        $('downloadUpdate').hidden = !updateURL;
      }
    } catch (error) {
      $('updateStatus').textContent = updateURL ? '自动下载失败，可前往手动下载。' : error.message.includes('404') ? '暂未发布新版本' : '暂时无法连接 GitHub';
      $('downloadUpdate').hidden = !updateURL;
      if ($('updateDialog').open) { $('updateDialogStatus').textContent = $('updateStatus').textContent; $('manualUpdate').hidden = !updateURL; $('closeUpdateDialog').textContent = '关闭'; }
    } finally { $('checkUpdate').disabled = false; }
  });
  $('downloadUpdate').textContent = '前往手动下载';
  $('downloadUpdate').addEventListener('click', () => { if (updateURL) void api.openUpdate(updateURL); });
  $('manualUpdate').addEventListener('click', () => { if (updateURL) void api.openUpdate(updateURL); });
  $('closeUpdateDialog').addEventListener('click', () => $('updateDialog').close());
  api.onUpdateProgress(progress => { if (progress?.total) { $('updateStatus').textContent = `正在下载更新… ${progress.percent}%`; $('updateDialogStatus').textContent = $('updateStatus').textContent; $('updateProgress').value = progress.percent; } });
  api.onSettings(apply); api.onRuntime(applyStatus); void api.getSettings().then(apply);
})();
