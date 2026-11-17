(() => {
  'use strict';
  const api = window.clearcall;
  const $ = id => document.getElementById(id);
  const s = { inRoom: false, busy: false, micBusy: false, role: '', muted: true, speaking: false, duckEnabled: true, duckDepth: 15, peer: { sharing: false, muted: false }, candidates: [], generation: 0 };
  let ctx, master, silence, outputGain, micStream, micMonitor, pc, tx, localVideo, remoteVideo;
  let outgoingSystem, pcmNode, pcmDestination, remoteMic, remoteSystem;
  let moduleReady, selectedSource, lastTarget = -1, info = {};
  let lastLocalTarget = 1;
  let localDucked = false;
  let audioScope, micGeneration = 0;
  let roomId = '', inputMode = 'standard', toastTimer, audioInitialization, settingsVisible = false;
  const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
  const videoProfiles = {
    '4k': { label: '4K', width: 3840, height: 2160, fps: 30, bitrate: 25000000 },
    '1440p': { label: '1440p', width: 2560, height: 1440, fps: 30, bitrate: 12000000 },
    '1080p': { label: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 6000000 }
  };
  let videoProfile = videoProfiles['4k'], videoStats = {}, previousVideoSample;
  const localGate = new window.SpeechGate(), remoteGate = new window.SpeechGate();
  const notify = (message, type = '') => {
    if (!message || !type) return;
    clearTimeout(toastTimer); $('notice').textContent = message; $('notice').className = `notice ${type}`;
    toastTimer = setTimeout(() => $('notice').classList.add('hidden'), type === 'error' ? 4500 : 2400);
  };
  const signal = message => api.send(message).catch(() => {});
  const peerState = () => signal({ type: 'peer-state', sharing: Boolean(localVideo), muted: s.muted, speaking: s.speaking && !s.muted, computerAudio: Boolean(outgoingSystem), sourceDucked: localDucked, duckEnabled: s.duckEnabled, duckDepth: s.duckDepth });
  function connection(label, connected = false) {
    $('connectionStatus').textContent = label;
    $('connectionDot').className = connected ? 'online' : '';
    $('participantStatus').textContent = label;
  }
  async function audioContext() {
    if (ctx && ctx.state !== 'closed') { await ctx.resume(); return; }
    if (!audioInitialization) audioInitialization = (async () => {
      info = await api.info();
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'balanced' });
      if (ctx.sampleRate !== 48000) throw new Error('当前音频设备不支持 48kHz 音频。');
      master = ctx.createDynamicsCompressor();
      master.threshold.value = -3; master.knee.value = 3; master.ratio.value = 12;
      master.attack.value = 0.003; master.release.value = 0.15;
      outputGain = ctx.createGain(); outputGain.gain.value = info.testMode ? 0 : 1;
      master.connect(outputGain); outputGain.connect(ctx.destination);
      silence = ctx.createGain(); silence.gain.value = 0; silence.connect(ctx.destination);
      moduleReady = undefined;
    })();
    try { await audioInitialization; } finally { audioInitialization = undefined; }
    await ctx.resume();
  }
  function monitor(stream, playback = false, shared = false) {
    const source = ctx.createMediaStreamSource(stream), gain = ctx.createGain(), analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 160;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 3800;
    source.connect(high); high.connect(low); low.connect(analyser); analyser.connect(silence);
    let playout;
    if (playback) {
      // A silent media element keeps Chromium's remote WebRTC audio playout
      // active; WebAudio supplies the only audible output and its ducking gain.
      playout = new Audio(); playout.autoplay = true; playout.volume = 0; playout.srcObject = stream;
      void playout.play().catch(() => {});
      source.connect(gain); gain.gain.value = shared ? Number($('sharedVolume').value) / 100 : 1; gain.connect(master);
    }
    return { source, gain, analyser, high, low, data: new Float32Array(analyser.fftSize), dispose() { if (playout) { playout.pause(); playout.srcObject = null; } source.disconnect(); gain.disconnect(); high.disconnect(); low.disconnect(); analyser.disconnect(); } };
  }
  async function devices() {
    const list = await navigator.mediaDevices.enumerateDevices(), existing = $('micDevice').value;
    $('micDevice').replaceChildren(new Option(list.find(d => d.kind === 'audioinput' && d.deviceId === 'default')?.label || '系统默认麦克风', ''));
    for (const d of list.filter(d => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId))) $('micDevice').add(new Option(d.label || '麦克风', d.deviceId));
    if (Array.from($('micDevice').options).some(x => x.value === existing)) $('micDevice').value = existing;
    micDeviceHint();
    await api.reportDevices(list.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId })));
  }
  function micDeviceHint() {
    const label = $('micDevice').selectedOptions[0]?.textContent || '';
    setText('micHint', /bluetooth|蓝牙|FreeClip|FreeBuds|AirPods/i.test(label) ? '蓝牙麦克风开启后可能切换通话模式。若鼠标或声音卡顿，请关闭麦克风，改用 USB / 有线麦克风。' : '创建通话默认不开麦。点击“开启麦克风”后才访问设备；关闭麦克风会释放设备。');
  }
  async function microphone() {
    if (s.micBusy) return;
    s.micBusy = true; controls();
    const generation = ++micGeneration;
    const constraints = { echoCancellation: true, noiseSuppression: inputMode === 'standard', autoGainControl: inputMode === 'standard', channelCount: 1 };
    if ($('micDevice').value) constraints.deviceId = { exact: $('micDevice').value };
    let next, timer, expired = false;
    try {
      const pending = navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }).then(stream => {
        if (expired || generation !== micGeneration) { stream.getTracks().forEach(t => t.stop()); throw new Error('麦克风开启已取消。'); }
        return stream;
      });
      next = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('麦克风启动超时')); }, 8000); })]);
      await audioContext();
      if (generation !== micGeneration) { next.getTracks().forEach(t => t.stop()); return; }
      if (tx) await tx.mic.sender.replaceTrack(next.getAudioTracks()[0]);
      const previous = micStream;
      micMonitor?.dispose(); micStream = next; micMonitor = monitor(next); localGate.reset(); s.muted = false;
      previous?.getTracks().forEach(t => t.stop());
      await devices(); await peerState();
    } catch (error) {
      next?.getTracks().forEach(t => t.stop());
      throw new Error(error.name === 'NotFoundError' ? '未检测到麦克风' : error.name === 'NotAllowedError' ? '麦克风访问未获授权' : error.message);
    } finally { clearTimeout(timer); s.micBusy = false; controls(); }
  }
  async function stopMicrophone() {
    micGeneration++; s.muted = true; s.speaking = false;
    const previous = micStream; micStream = undefined;
    previous?.getTracks().forEach(t => t.stop());
    micMonitor?.dispose(); micMonitor = undefined; localGate.reset();
    if (tx) await tx.mic.sender.replaceTrack(null).catch(() => {});
    await peerState(); controls();
    if (!pc && !localVideo && ctx) { const old = ctx; ctx = undefined; await old.close().catch(() => {}); }
  }
  function controls() {
    $('createRoom').disabled = $('joinRoom').disabled = $('joinByRoom').disabled = s.busy;
    $('leaveRoom').disabled = !s.inRoom;
    $('muteMic').disabled = !s.inRoom || s.micBusy;
    $('micDevice').disabled = s.micBusy;
    $('shareScreen').disabled = !s.inRoom || Boolean(localVideo) || s.busy;
    $('muteMic').title = $('muteMic').ariaLabel = s.micBusy ? '麦克风启动中' : micStream ? '关闭麦克风' : '开启麦克风';
    $('muteMic').setAttribute('aria-pressed', String(Boolean(micStream)));
    $('muteMic').querySelector('use').setAttribute('href', `icons.svg#${micStream ? 'mic' : 'mic-off'}`);
    document.body.dataset.view = s.inRoom ? 'session' : 'connect';
    $('setup').classList.toggle('hidden', s.inRoom);
    $('sessionView').classList.toggle('hidden', !s.inRoom);
    $('stage').classList.toggle('hidden', !s.inRoom);
    $('callbar').classList.toggle('hidden', !s.inRoom);
    $('inviteCard').classList.toggle('hidden', !s.inRoom);
    $('settingsButton').disabled = false;
    $('stopShare').classList.toggle('hidden', !localVideo);
    $('shareScreen').classList.toggle('hidden', Boolean(localVideo));
    const receivingOnly = s.peer.sharing && !localVideo;
    $('duckEnabled').disabled = $('duckDepth').disabled = receivingOnly;
    $('duckEnabled').checked = receivingOnly ? s.peer.duckEnabled !== false : s.duckEnabled;
    $('duckDepth').value = receivingOnly ? (s.peer.duckDepth || 15) : s.duckDepth;
    $('duckDepthLabel').textContent = `${$('duckDepth').value} dB`;
    $('duckDescription').textContent = receivingOnly ? '视频音量由共享端统一控制。你说话时，对方会降低视频声音，两边一起变小。' : '任意一方说话时，在共享端降低视频声音。观看端跟随变化，不会再次自动压低。';
  }
  function refreshVideo() {
    const stream = s.peer.sharing ? remoteVideo : localVideo, show = Boolean(stream && (s.peer.sharing || localVideo));
    if ($('screenVideo').srcObject !== stream) $('screenVideo').srcObject = stream || null;
    $('screenVideo').classList.toggle('hidden', !show); $('emptyStage').classList.toggle('hidden', show);
    $('stageTitle').textContent = s.peer.sharing ? '对方正在共享' : localVideo ? '我正在共享 · 本地预览' : '共享画面';
    $('shareStatus').textContent = show ? (s.peer.sharing ? '正在接收共享画面' : '正在共享 · 本地预览静音') : '未共享';
    $('stageHint').textContent = s.inRoom ? (pc ? '点击下方屏幕按钮，或等待对方共享。' : '等待对方加入，也可以先共享屏幕。') : '';
  }
  function closePeer() {
    if (pc) { pc.ontrack = pc.onconnectionstatechange = pc.onicecandidate = null; pc.close(); }
    pc = undefined; tx = undefined; s.candidates = [];
    remoteMic?.dispose(); remoteSystem?.dispose(); remoteMic = remoteSystem = remoteVideo = undefined;
    s.peer = { sharing: false, muted: false }; remoteGate.reset(); lastTarget = -1; refreshVideo();
  }
  async function buildPeer(initiator) {
    closePeer();
    const current = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); pc = current;
    // Only the offerer creates slots. The answerer uses the offered transceivers;
    // pre-creating answerer slots creates extra m-lines and breaks two-way audio.
    if (initiator) tx = { mic: current.addTransceiver('audio', { direction: 'sendrecv' }), system: current.addTransceiver('audio', { direction: 'sendrecv' }), video: current.addTransceiver('video', { direction: 'sendrecv' }) };
    current.onicecandidate = event => { if (event.candidate) void signal({ type: 'candidate', candidate: event.candidate.toJSON() }); };
    current.ontrack = event => {
      const stream = new MediaStream([event.track]);
      const attach = () => {
        if (current !== pc) return;
        if (event.transceiver.mid === '0') { remoteMic?.dispose(); remoteMic = monitor(stream, true); }
        else if (event.transceiver.mid === '1') { remoteSystem?.dispose(); remoteSystem = monitor(stream, true, true); lastTarget = -1; }
        else { remoteVideo = stream; refreshVideo(); }
      };
      if (event.transceiver.mid === '0' || event.transceiver.mid === '1') void audioContext().then(attach).catch(error => { if (current === pc) notify(`远端声音无法播放：${error.message}`, 'error'); });
      else attach();
    };
    current.onconnectionstatechange = () => {
      if (current !== pc) return;
      if (current.connectionState === 'connected') { connection('通话已连接', true); void configureVideo().catch(error => notify(error.message, 'error')); notify('双方可以说话。共享电脑声音时，不会把对方的声音重新传回去。', 'success'); }
      else if (current.connectionState === 'failed') { connection('媒体连接失败'); notify('音视频无法直连。请确认两台电脑在同一局域网或同一 Tailscale 网络，并允许映伴通过防火墙，然后重新加入。', 'error'); }
      else if (current.connectionState === 'disconnected') connection('网络中断，正在尝试恢复');
    };
    if (tx) await attachTracks();
    if (initiator) { await current.setLocalDescription(await current.createOffer()); await signal({ type: 'description', description: current.localDescription.toJSON() }); }
    await peerState(); connection('正在建立媒体连接'); refreshVideo();
  }
  async function attachTracks() {
    await tx.mic.sender.replaceTrack(micStream?.getAudioTracks()[0] || null);
    await tx.system.sender.replaceTrack(outgoingSystem?.getAudioTracks()[0] || null);
    await tx.video.sender.replaceTrack(localVideo?.getVideoTracks()[0] || null);
    await configureVideo();
  }
  async function configureVideo() {
    if (!tx?.video || !localVideo) return;
    const sender = tx.video.sender, parameters = sender.getParameters();
    // Before offer/answer completes there may be no negotiated encoding yet.
    // The connected callback reapplies the selected profile in that case.
    if (!parameters.encodings?.length) return;
    parameters.degradationPreference = 'maintain-resolution';
    for (const encoding of parameters.encodings) {
      encoding.maxBitrate = videoProfile.bitrate;
      encoding.maxFramerate = videoProfile.fps;
      encoding.scaleResolutionDownBy = 1;
    }
    try { await sender.setParameters(parameters); }
    catch { throw new Error('无法应用所选画质的编码设置，请停止共享后重试。'); }
  }
  function refreshQualityLabel() {
    const profile = videoProfiles[$('videoQuality').value] || videoProfiles['4k'];
    const direction = s.peer.sharing ? 'receiving' : localVideo ? 'sending' : '';
    if (!direction) { $('quality').textContent = ''; return; }
    const sample = videoStats.direction === direction ? videoStats : {};
    const local = localVideo?.getVideoTracks()[0]?.getSettings();
    const width = sample.width || (direction === 'receiving' ? $('screenVideo').videoWidth : local?.width);
    const height = sample.height || (direction === 'receiving' ? $('screenVideo').videoHeight : local?.height);
    const parts = [width && height ? `${direction === 'receiving' ? '接收' : sample.width ? '发送' : '采集'} ${width}×${height}` : '等待共享画面'];
    if (Number.isFinite(sample.fps)) parts.push(`${Math.round(sample.fps)} 帧/秒`);
    if (Number.isFinite(sample.mbps)) parts.push(`${sample.mbps.toFixed(1)} Mbps`);
    if (Number.isFinite(sample.rtt)) parts.push(`RTT ${sample.rtt} ms`);
    $('quality').textContent = parts.join(' · ');
    $('quality').title = `所选档位 ${profile.label}。显示实际采集或传输分辨率；静止画面会减少帧率和码率。`;
  }
  let signalQueue = Promise.resolve();
  api.onSignal(message => {
    signalQueue = signalQueue.then(async () => {
      if (message.type === 'welcome') s.role = message.role;
      else if (message.type === 'peer-ready') { if (s.inRoom) await buildPeer(s.role === 'host'); }
      else if (message.type === 'description' && s.inRoom) {
        if (!pc) await buildPeer(false);
        await pc.setRemoteDescription(message.description);
        for (const candidate of s.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (message.description.type === 'offer') {
          const slots = pc.getTransceivers(); tx = { mic: slots[0], system: slots[1], video: slots[2] };
          for (const slot of slots) slot.direction = 'sendrecv';
          await attachTracks();
          await pc.setLocalDescription(await pc.createAnswer()); await signal({ type: 'description', description: pc.localDescription.toJSON() });
        }
      } else if (message.type === 'candidate' && s.inRoom) {
        if (pc?.remoteDescription) await pc.addIceCandidate(message.candidate); else s.candidates.push(message.candidate);
      } else if (message.type === 'peer-state') {
        s.peer = { sharing: message.sharing === true, muted: message.muted === true, speaking: message.speaking === true && message.muted !== true, computerAudio: message.computerAudio === true, sourceDucked: message.sourceDucked === true, duckEnabled: message.duckEnabled === true, duckDepth: Number.isFinite(message.duckDepth) ? Math.max(6, Math.min(24, message.duckDepth)) : 15 }; controls(); refreshVideo();
      } else if (message.type === 'peer-left') {
        closePeer(); connection(s.role === 'host' ? '等待对方重新加入' : '对方已离开'); notify('对方已离开通话。');
      } else if (message.type === 'closed' && s.inRoom) { await endCall(); notify(message.message || '通话已断开。', 'error'); }
    }).catch(error => notify(`连接处理失败：${error.message}`, 'error'));
  });
  async function begin(kind) {
    if (s.busy || s.inRoom) return;
    if (kind === 'join' && !$('inviteInput').value.trim()) { notify('请先粘贴对方的邀请地址。', 'error'); return; }
    s.busy = true; controls(); notify('正在建立通话…');
    try {
      s.inRoom = true; s.generation++;
      await api.setWindowMode('session');
      if (kind === 'create') {
        const result = await api.createRoom();
        roomId = result.roomId || '';
        setText('roomNumber', roomId || '------');
        $('inviteSelect').replaceChildren(...result.invites.map(x => new Option(x, x))); $('inviteCard').classList.remove('hidden');
        notify(result.invites.length ? '复制邀请地址给对方。局域网选本地地址，Tailscale 选 100 开头的地址。' : '未找到 IPv4 网络，请连接局域网或 Tailscale 后重新创建。', result.invites.length ? '' : 'error');
        connection('等待对方加入');
      } else { await api.joinRoom($('inviteInput').value.trim()); notify('已加入，正在建立音视频连接。'); }
      if ($('startMic').checked) await microphone().catch(error => notify(error.message, 'error'));
    } catch (error) { await endCall(); notify(error.message, 'error'); }
    finally { s.busy = false; controls(); refreshVideo(); }
  }
  async function joinByRoom() {
    if (s.busy || s.inRoom) return;
    const code = $('roomInput').value.trim();
    if (!/^\d{6}$/.test(code)) { notify('请输入 6 位房间号。', 'error'); return; }
    s.busy = true; controls(); notify('正在局域网搜索房间…');
    try {
      const discovered = await api.discoverRoom(code);
      s.inRoom = true; s.generation++; roomId = code; setText('roomNumber', code);
      await api.joinRoom(discovered.endpoint); await api.setWindowMode('session');
      notify('已加入，正在建立音视频连接。');
      if ($('startMic').checked) await microphone().catch(error => notify(error.message, 'error'));
    } catch (error) { await endCall(); notify(error.message, 'error'); }
    finally { s.busy = false; controls(); refreshVideo(); }
  }
  async function stopSharing() {
    const previous = localVideo; localVideo = undefined;
    audioScope = undefined;
    videoStats = {}; previousVideoSample = undefined;
    if (tx) { await tx.video.sender.replaceTrack(null).catch(() => {}); await tx.system.sender.replaceTrack(null).catch(() => {}); }
    previous?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    outgoingSystem?.getTracks().forEach(t => t.stop()); outgoingSystem = undefined;
    pcmNode?.disconnect(); pcmDestination?.disconnect(); pcmNode = pcmDestination = undefined;
    await api.stopAudio(); lastLocalTarget = 1; localDucked = false; await peerState(); controls(); refreshVideo();
  }
  async function endCall() {
    s.inRoom = false; s.generation++; $('sourceDialog').close(); await stopSharing(); closePeer();
    await stopMicrophone();
    await api.leaveRoom();
    if (ctx) { await ctx.close().catch(() => {}); ctx = undefined; }
    s.muted = true; s.speaking = false; s.role = ''; localGate.reset(); remoteGate.reset();
    $('inviteCard').classList.add('hidden'); $('inviteSelect').replaceChildren(); roomId = ''; setText('roomNumber', '------'); connection('尚未连接'); controls(); refreshVideo();
    await api.setWindowMode('connect');
  }
  async function openSources() {
    s.busy = true; controls(); selectedSource = undefined; $('confirmShare').disabled = true;
    try {
      const sources = await api.sources(); $('sourceGrid').replaceChildren();
      for (const source of sources) {
        const button = document.createElement('button'); button.className = 'source-item'; button.type = 'button';
        const image = document.createElement('img'); image.src = source.thumbnail || 'icons/monitor.svg'; image.alt = '';
        const label = document.createElement('span'); label.textContent = source.name; button.append(image, label);
        button.addEventListener('click', () => {
          selectedSource = source.id;
          for (const child of $('sourceGrid').children) child.classList.toggle('selected', child === button);
          $('confirmShare').disabled = false;
          setText('audioScopeLabel', source.kind === 'app' ? '同时共享所选应用的声音' : '同时共享其他所有应用的声音');
          setText('scopeHint', source.kind === 'app' ? '仅共享此应用的声音；同一浏览器可能包含其他标签页。' : '共享其他所有应用声音，映伴通话声音会被排除。');
        });
        $('sourceGrid').append(button);
      }
      if (!sources.length) throw new Error('没有找到可共享的屏幕或窗口。');
      $('includeAudio').disabled = !info.nativeAudio; if (!info.nativeAudio) $('includeAudio').checked = false;
      $('sourceDialog').showModal();
    } catch (error) { notify(error.message, 'error'); }
    finally { s.busy = false; controls(); }
  }
  async function startSharing() {
    if (!selectedSource || !s.inRoom || s.busy) return;
    const generation = s.generation, withAudio = $('includeAudio').checked;
    videoProfile = videoProfiles[$('videoQuality').value] || videoProfiles['4k'];
    s.busy = true; $('sourceDialog').close(); controls();
    try {
      await audioContext(); await api.selectSource(selectedSource);
      localVideo = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: videoProfile.width }, height: { max: videoProfile.height }, frameRate: { ideal: videoProfile.fps, max: videoProfile.fps } }, audio: false });
      if (!s.inRoom || generation !== s.generation) { await stopSharing(); return; }
      const track = localVideo.getVideoTracks()[0]; track.contentHint = 'detail'; track.onended = () => { void stopSharing(); };
      const native = track.getCapabilities();
      const nativeWidth = native.width?.max || track.getSettings().width;
      const nativeHeight = native.height?.max || track.getSettings().height;
      // Request detail up to the chosen ceiling, without upscaling a small window.
      const scale = Math.min(1, videoProfile.width / nativeWidth, videoProfile.height / nativeHeight);
      await track.applyConstraints({ width: { ideal: Math.floor(nativeWidth * scale), max: videoProfile.width }, height: { ideal: Math.floor(nativeHeight * scale), max: videoProfile.height }, frameRate: { ideal: videoProfile.fps, max: videoProfile.fps } });
      if (withAudio) {
        if (!moduleReady) moduleReady = ctx.audioWorklet.addModule('pcm-worklet.js'); await moduleReady;
        pcmNode = new AudioWorkletNode(ctx, 'clearcall-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        pcmDestination = ctx.createMediaStreamDestination(); pcmNode.connect(pcmDestination); pcmNode.connect(silence);
        outgoingSystem = pcmDestination.stream; outgoingSystem.getAudioTracks()[0].contentHint = 'music';
        audioScope = (await api.startAudio()).scope;
      }
      if (!s.inRoom || generation !== s.generation) { await stopSharing(); return; }
      if (tx) {
        await tx.video.sender.replaceTrack(track); await tx.system.sender.replaceTrack(outgoingSystem?.getAudioTracks()[0] || null);
        await configureVideo();
      }
      await peerState();
    } catch (error) { await stopSharing(); notify(`共享未启动：${error.message}`, 'error'); }
    finally { s.busy = false; controls(); refreshVideo(); }
  }
  let remainder = new Uint8Array(0);
  api.onPCM(bytes => {
    if (!pcmNode) { remainder = new Uint8Array(0); return; }
    const incoming = new Uint8Array(bytes), joined = new Uint8Array(remainder.length + incoming.length);
    joined.set(remainder); joined.set(incoming, remainder.length);
    const length = joined.length - joined.length % 4, samples = new Float32Array(length / 2), view = new DataView(joined.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    remainder = joined.slice(length); if (samples.length) pcmNode.port.postMessage(samples, [samples.buffer]);
  });
  api.onAudioEnded(() => { if (s.inRoom && outgoingSystem) void stopSharing().then(() => notify('电脑声音采集中断，共享已停止。请检查音频设备后重试。', 'error')); });
  api.onDucked(({ gain }) => { localDucked = gain < 0.999; void peerState(); });
  function level(node) {
    if (!node) return 0;
    node.analyser.getFloatTimeDomainData(node.data);
    let energy = 0; for (const x of node.data) energy += x * x; return Math.sqrt(energy / node.data.length);
  }
  function updateAudio() {
    if (!s.inRoom && !micStream) return;
    const a = level(micMonitor), b = level(remoteMic), now = performance.now(), sensitivity = -Number($('sensitivity').value);
    const localSpeaking = Boolean(micStream) && !s.muted && localGate.update(a, now, sensitivity);
    const remoteSpeaking = !s.peer.muted && (s.peer.speaking || remoteGate.update(b, now, sensitivity));
    if (s.speaking !== localSpeaking) { s.speaking = localSpeaking; if (s.inRoom) void peerState(); }
    $('localMeter').style.transform = `scaleX(${Math.min(1, a * 4.3).toFixed(2)})`; $('remoteMeter').style.transform = `scaleX(${Math.min(1, b * 4.3).toFixed(2)})`;
    setText('localVoice', !micStream ? '未开启' : localSpeaking ? '说话中' : '安静');
    setText('remoteVoice', !pc ? '未连接' : s.peer.muted ? '未开麦' : remoteSpeaking ? '说话中' : '安静');
    const duck = s.duckEnabled && (localSpeaking || remoteSpeaking);
    const localTarget = localVideo && outgoingSystem && duck ? window.sharedGain(1, true, s.duckDepth) : 1;
    if (Math.abs(localTarget - lastLocalTarget) > 0.0001) { lastLocalTarget = localTarget; void api.duckLocal(localTarget).catch(error => notify(`本机视频降音量失败：${error.message}`, 'error')); }
    // All automatic attenuation happens at the sharing source. A receiver only
    // applies its personal listening-volume slider, never a second speech duck.
    const target = Number($('sharedVolume').value) / 100;
    if (remoteSystem && ctx && Math.abs(target - lastTarget) > 0.0001) {
      const parameter = remoteSystem.gain.gain;
      parameter.cancelAndHoldAtTime(ctx.currentTime); parameter.setTargetAtTime(target, ctx.currentTime, lastTarget < 0 || target < lastTarget ? 0.035 : 0.22); lastTarget = target;
    }
    const active = localVideo ? localDucked : s.peer.sourceDucked;
    $('duckState').classList.toggle('active', Boolean(active && s.inRoom));
    setText('duckLabel', !s.inRoom ? '等待通话' : !$('duckEnabled').checked ? '人声优先已关闭' : active ? '共享端已降低视频声音' : !(localVideo || s.peer.computerAudio) ? '等待共享应用声音' : '正在聆听 · 视频背景音正常');
  }
  setInterval(updateAudio, 50);
  setInterval(async () => {
    if (pc?.connectionState !== 'connected') { refreshQualityLabel(); return; }
    const current = pc;
    try {
      const reports = await current.getStats();
      if (pc !== current) return;
      const receiving = s.peer.sharing, type = receiving ? 'inbound-rtp' : 'outbound-rtp';
      const rows = Array.from(reports.values());
      const video = rows.find(r => r.type === type && r.kind === 'video' && !r.isRemote);
      const pair = rows.find(r => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated);
      if (video) {
        const bytes = receiving ? video.bytesReceived : video.bytesSent;
        const previous = previousVideoSample;
        const mbps = previous?.id === video.id && video.timestamp > previous.time ? Math.max(0, (bytes - previous.bytes) * 8 / (video.timestamp - previous.time) / 1000) : undefined;
        previousVideoSample = { id: video.id, time: video.timestamp, bytes };
        videoStats = { direction: receiving ? 'receiving' : 'sending', width: video.frameWidth, height: video.frameHeight, fps: video.framesPerSecond, mbps, rtt: pair ? Math.round((pair.currentRoundTripTime || 0) * 1000) : undefined, limitation: video.qualityLimitationReason, codec: reports.get(video.codecId)?.mimeType };
      }
      refreshQualityLabel();
    } catch { }
  }, 1000);
  $('createRoom').addEventListener('click', () => { void begin('create'); });
  $('joinRoom').addEventListener('click', () => { void begin('join'); });
  $('joinForm').addEventListener('submit', event => { event.preventDefault(); void joinByRoom(); });
  $('roomInput').addEventListener('input', () => { $('roomInput').value = $('roomInput').value.replace(/\D/g, '').slice(0, 6); });
  $('leaveRoom').addEventListener('click', () => { void endCall(); });
  $('muteMic').addEventListener('click', () => { void (micStream ? stopMicrophone() : microphone()).catch(error => notify(error.message, 'error')); });
  $('micDevice').addEventListener('change', () => {
    micDeviceHint();
    if (micStream) void stopMicrophone().then(() => microphone()).catch(error => notify(error.message, 'error'));
  });
  $('shareScreen').addEventListener('click', () => { void openSources(); });
  $('stopShare').addEventListener('click', () => { void stopSharing(); });
  $('closeDialog').addEventListener('click', () => $('sourceDialog').close());
  $('settingsButton').addEventListener('click', () => { void api.openSettings(); });
  $('homeSettings').addEventListener('click', () => { void api.openSettings(); });
  $('confirmShare').addEventListener('click', () => { void startSharing(); });
  $('videoQuality').addEventListener('change', () => {
    const profile = videoProfiles[$('videoQuality').value];
    $('qualityHint').textContent = `${profile.width}×${profile.height} 上限 · 最高 ${profile.fps} 帧/秒 · 码率上限 ${profile.bitrate / 1000000} Mbps。实际清晰度取决于共享源、网络与设备，静态内容用量更低。`;
  });
  $('copyInvite').addEventListener('click', async () => { if ($('inviteSelect').value) { await api.copy($('inviteSelect').value); notify('邀请链接已复制', 'success'); } });
  $('copyRoom').addEventListener('click', async () => { if (roomId) { await api.copy(roomId); notify('房间号已复制', 'success'); } });
  $('duckDepth').addEventListener('input', () => { s.duckDepth = Number($('duckDepth').value); $('duckDepthLabel').textContent = `${s.duckDepth} dB`; void peerState(); });
  $('duckEnabled').addEventListener('change', () => { s.duckEnabled = $('duckEnabled').checked; void peerState(); });
  $('sharedVolume').addEventListener('input', () => { $('sharedVolumeLabel').textContent = `${$('sharedVolume').value}%`; });
  $('sensitivity').addEventListener('input', () => { const v = Number($('sensitivity').value); $('sensitivityLabel').textContent = v < 36 ? '偏低' : v > 49 ? '偏高' : '适中'; });
  $('fullscreen').addEventListener('click', () => { void (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error => notify(`全屏未能开启：${error.message}`, 'error')); });
  document.addEventListener('fullscreenchange', () => { $('fullscreen').title = $('fullscreen').ariaLabel = document.fullscreenElement ? '退出全屏' : '全屏'; $('fullscreen').querySelector('use').setAttribute('href', `icons.svg#${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}`); });
  function applyPreferences({ preferences: p }) {
    const restart = micStream && (inputMode !== p.inputMode || $('micDevice').value !== p.micDevice);
    s.duckEnabled = p.duckEnabled; s.duckDepth = p.duckDepth; inputMode = p.inputMode;
    $('sharedVolume').value = p.sharedVolume; $('sensitivity').value = p.sensitivity;
    if (Array.from($('micDevice').options).some(o => o.value === p.micDevice)) $('micDevice').value = p.micDevice;
    controls(); void peerState();
    if (restart) void stopMicrophone().then(() => microphone()).catch(error => notify(error.message, 'error'));
  }
  api.onSettings(applyPreferences); api.onSettingsVisible(visible => { settingsVisible = visible; });
  void api.getSettings().then(applyPreferences);
  setInterval(() => { if (settingsVisible) void api.reportStatus({ mic: Boolean(micStream), connected: pc?.connectionState === 'connected', speaking: s.speaking, remoteSpeaking: Boolean(s.peer.speaking), remoteMuted: s.peer.muted, localLevel: level(micMonitor), remoteLevel: level(remoteMic), sharing: Boolean(localVideo), peerSharing: s.peer.sharing, peerDuckEnabled: s.peer.duckEnabled, peerDuckDepth: s.peer.duckDepth, ducking: localDucked || s.peer.sourceDucked }); }, 200);
  api.info().then(result => { info = result; }).catch(() => {}); void devices().catch(() => {}); controls();
  navigator.mediaDevices.addEventListener('devicechange', () => { void devices().catch(() => {}); });
  window.clearcallDiagnostics = () => ({ inRoom: s.inRoom, role: s.role, connection: pc?.connectionState || 'none', mic: Boolean(micStream), muted: s.muted, sharing: Boolean(localVideo), computerAudio: Boolean(outgoingSystem), peerSharing: s.peer.sharing, localDucked, peerSourceDucked: s.peer.sourceDucked, localLevel: level(micMonitor), remoteLevel: level(remoteMic), sharedLevel: level(remoteSystem), context: ctx?.state, remoteTracks: pc?.getReceivers().map(x => ({ kind: x.track.kind, muted: x.track.muted, state: x.track.readyState })), sharedGain: remoteSystem?.gain.gain.value, screen: { width: $('screenVideo').videoWidth, height: $('screenVideo').videoHeight }, audioScope, capture: localVideo?.getVideoTracks()[0]?.getSettings(), videoProfile, videoStats, encoder: tx?.video.sender.getParameters() });
  window.clearcallMediaStats = async () => pc ? Array.from((await pc.getStats()).values()).filter(r => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(r.type)).map(r => ({ type: r.type, kind: r.kind, mid: r.mid, audioLevel: r.audioLevel, totalAudioEnergy: r.totalAudioEnergy, packetsReceived: r.packetsReceived, packetsSent: r.packetsSent, bytesSent: r.bytesSent })) : [];
})();
