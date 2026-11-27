(() => {
  'use strict';
  const api = window.clearcall;
  const $ = id => document.getElementById(id);
  const s = { inRoom: false, busy: false, micBusy: false, role: '', muted: true, speaking: false, duckEnabled: true, duckDepth: 9, peerJoined: false, peerName: '', peerAvatar: '', peer: { sharing: false, muted: false }, candidates: [], generation: 0 };
  let ctx, master, sharedMaster, silence, outputGain, micStream, micMonitor, pc, tx, localVideo, remoteVideo;
  let outgoingSystem, pcmNode, pcmDestination, remoteMic, remoteSystem;
  let moduleReady, selectedSource, selectedSourceKind, audioAppsGeneration = 0, lastTarget = -1, info = {};
  let localGain = 1, localGainTarget = 1, lastLocalTarget = 1, lastGainTime = performance.now();
  let localDucked = false;
  let audioScope, micGeneration = 0;
  let roomId = '', inputMode = 'standard', outputDevice = '', toastTimer, audioInitialization, settingsVisible = false;
  let localProfile = { displayName: '', avatarData: '' };
  const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
  const videoProfiles = {
    '4k': { label: '4K', width: 3840, height: 2160, fps: 30, bitrate: 25000000 },
    '1440p': { label: '1440p', width: 2560, height: 1440, fps: 30, bitrate: 12000000 },
    '1080p': { label: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 6000000 }
  };
  let videoProfile = videoProfiles['4k'], videoStats = {}, previousVideoSample;
  const videoHealth = new window.VideoHealth(), videoAdaptation = new window.VideoAdaptation();
  let recoveryTimer, recoveryGeneration = 0, recoveryAttempts = 0, recoveryPending = false, recoveryReason = '', signalReconnecting = false;
  let sharedAudioStatus = 'stopped';
  const audioRecovery = new window.AudioRecovery({
    start: startSharedAudio, stop: stopSharedAudio,
    status(state, message = '', delay = 0) {
      sharedAudioStatus = state; sharedAudioError = message;
      if (state === 'retrying') notify(`${message}。画面继续共享，${delay / 1000} 秒后自动恢复声音。`, 'error');
      controls(); refreshVideo();
    }
  });
  let peerSession = '', lastRecoveryRequest = -Infinity, statsBusy = false, lastSentFrames, sharedAudioError = '';
  let videoConfiguration = Promise.resolve();
  const localGate = new window.SpeechGate(), remoteGate = new window.SpeechGate();
  const notify = (message, type = '') => {
    if (!message || !type) return;
    clearTimeout(toastTimer); $('notice').textContent = message; $('notice').className = `notice ${type}`;
    toastTimer = setTimeout(() => $('notice').classList.add('hidden'), type === 'error' ? 4500 : 2400);
  };
  const signal = message => api.send(message).catch(() => {});
  const peerState = () => signal({ type: 'peer-state', sharing: Boolean(localVideo), muted: s.muted, speaking: s.speaking && !s.muted, computerAudio: Boolean(outgoingSystem), sourceDucked: localDucked, duckEnabled: s.duckEnabled, duckDepth: s.duckDepth, recoveryVersion: 1 });
  const sendProfile = () => signal({ type: 'profile', displayName: localProfile.displayName, avatarData: localProfile.avatarData });
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
      if (outputDevice && typeof ctx.setSinkId === 'function') await ctx.setSinkId(outputDevice).catch(() => {});
      if (ctx.sampleRate !== 48000) throw new Error('当前音频设备不支持 48kHz 音频。');
      master = ctx.createDynamicsCompressor();
      master.threshold.value = -3; master.knee.value = 3; master.ratio.value = 12;
      master.attack.value = 0.003; master.release.value = 0.15;
      sharedMaster = ctx.createGain();
      outputGain = ctx.createGain(); outputGain.gain.value = info.testMode ? 0 : 1;
      master.connect(outputGain); sharedMaster.connect(outputGain); outputGain.connect(ctx.destination);
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
      source.connect(gain); gain.gain.value = shared ? Number($('sharedVolume').value) / 100 : 1; gain.connect(shared ? sharedMaster : master);
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
  async function setOutputDevice(deviceId) {
    outputDevice = deviceId || '';
    if (ctx && typeof ctx.setSinkId === 'function') await ctx.setSinkId(outputDevice || 'default').catch(() => {});
  }
  function micDeviceHint() {
    const label = $('micDevice').selectedOptions[0]?.textContent || '';
    setText('micHint', /bluetooth|蓝牙|FreeClip|FreeBuds|AirPods/i.test(label) ? '蓝牙麦克风会让耳机进入通话模式，音乐可能变差；建议使用电脑内置或 USB 麦克风。' : '');
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
      const currentTx = tx, currentPc = pc;
      if (currentTx) await currentTx.mic.sender.replaceTrack(next.getAudioTracks()[0]);
      if (generation !== micGeneration || !s.inRoom || pc !== currentPc || tx !== currentTx) {
        if (currentTx && tx === currentTx) await currentTx.mic.sender.replaceTrack(null).catch(() => {});
        next.getTracks().forEach(t => t.stop()); return;
      }
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
    $('fullscreen').disabled = !s.inRoom;
    $('pictureInPicture').disabled = !$('screenVideo').srcObject || !document.pictureInPictureEnabled;
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
    $('retrySharedAudio').classList.toggle('hidden', !localVideo || !sharedAudioError);
    $('retrySharedAudio').disabled = s.busy || audioRecovery.pending;
    $('shareScreen').classList.toggle('hidden', Boolean(localVideo));
    const receivingOnly = s.peer.sharing && !localVideo;
    $('duckEnabled').disabled = $('duckDepth').disabled = receivingOnly;
    $('duckEnabled').checked = receivingOnly ? s.peer.duckEnabled !== false : s.duckEnabled;
    $('duckDepth').value = receivingOnly ? (s.peer.duckDepth || 9) : s.duckDepth;
    $('duckDepthLabel').textContent = `${$('duckDepth').value} dB`;
    $('duckDescription').textContent = receivingOnly ? '视频音量由共享端统一控制。你说话时，对方会降低视频声音，两边一起变小。' : '任意一方说话时，在共享端降低视频声音。观看端跟随变化，不会再次自动压低。';
    void api.setMiniState({ inRoom: s.inRoom, voiceOnly: s.inRoom && !localVideo && !s.peer.sharing, mic: Boolean(micStream) });
  }
  function refreshVideo() {
    const stream = s.peer.sharing ? remoteVideo : localVideo, show = Boolean(stream && (s.peer.sharing || localVideo));
    if ($('screenVideo').srcObject !== stream) $('screenVideo').srcObject = stream || null;
    $('screenVideo').classList.toggle('hidden', !show); $('emptyStage').classList.toggle('hidden', show); $('emptyStage').classList.toggle('voice-only', Boolean(s.inRoom && !show && s.peerJoined));
    $('voiceParticipants').classList.toggle('hidden', !(s.inRoom && !show && s.peerJoined));
    $('fullscreen').disabled = !s.inRoom;
    $('pictureInPicture').disabled = !show || !document.pictureInPictureEnabled;
    $('localPresence').textContent = '已加入'; $('remotePresence').textContent = s.peerJoined ? (pc?.connectionState === 'connected' ? '已连接' : '已加入，正在连接') : '等待加入';
    $('remoteAvatar').classList.toggle('online', s.peerJoined);
    $('localName').textContent = localProfile.displayName || '我';
    $('remoteName').textContent = s.peerName || '对方';
    for (const [prefix, name, avatar, fallback] of [['local', localProfile.displayName, localProfile.avatarData, '我'], ['remote', s.peerName, s.peerAvatar, '对']]) {
      const img = $(`${prefix}AvatarImage`), initial = $(`${prefix}Initial`);
      initial.textContent = Array.from(name || fallback)[0] || fallback;
      img.hidden = !avatar; initial.hidden = Boolean(avatar);
      if (avatar) img.src = avatar; else img.removeAttribute('src');
    }
    $('stageTitle').textContent = s.peer.sharing ? '对方正在共享' : localVideo ? '我正在共享 · 本地预览' : '共享画面';
    $('shareStatus').textContent = show ? (s.peer.sharing ? '正在接收共享画面' : '正在共享 · 本地预览静音') : '未共享';
    $('stageHint').textContent = s.inRoom ? (pc ? '点击下方屏幕按钮，或等待对方共享。' : '等待对方加入，也可以先共享屏幕。') : '';
  }
  function cancelRecovery() {
    recoveryGeneration++;
    clearTimeout(recoveryTimer); recoveryTimer = undefined; recoveryPending = false; recoveryAttempts = 0; recoveryReason = '';
  }
  function requestRecovery(reason, delay = 1000) {
    if (!s.inRoom || !s.peerJoined || signalReconnecting || recoveryTimer || recoveryPending || recoveryAttempts >= 6) return;
    recoveryReason = reason;
    const current = pc, token = ++recoveryGeneration;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (token !== recoveryGeneration || pc !== current || !s.inRoom || !s.peerJoined || signalReconnecting) return;
      signalQueue = signalQueue.then(async () => {
        if (token !== recoveryGeneration || pc !== current || !s.inRoom || signalReconnecting) return;
        recoveryPending = true;
        try {
          connection('正在恢复音视频连接');
          // One offerer coordinates recovery; older clients never initiate a
          // restart, so a desktop guest can safely offer to those clients.
          if (s.role !== 'host' && s.peer.recoveryVersion === 1) {
            await signal({ type: 'recovery', action: 'request', sessionId: peerSession });
          } else if (recoveryAttempts > 0 && s.peer.recoveryVersion === 1) {
            const attempts = recoveryAttempts;
            await buildPeer(true, true);
            clearTimeout(recoveryTimer); recoveryTimer = undefined;
            recoveryAttempts = attempts; recoveryPending = true; recoveryReason = reason;
          } else if (current && current.signalingState === 'stable') {
            await current.setLocalDescription(await current.createOffer({ iceRestart: true }));
            if (pc === current) await signal({ type: 'description', description: current.localDescription.toJSON(), sessionId: peerSession });
          }
        } catch (error) { notify(`恢复连接失败：${error.message}`, 'error'); }
        finally {
          if (token !== recoveryGeneration) return;
          recoveryPending = false;
          if (s.inRoom && s.peerJoined && !signalReconnecting) {
            recoveryAttempts++;
            if (recoveryAttempts >= 6) { connection('自动恢复未成功，请重新加入'); notify('音视频恢复失败，请检查网络后重新加入。', 'error'); }
            else requestRecovery(reason, Math.min(30000, 12000 + recoveryAttempts * 2000));
          }
        }
      }).catch(error => notify(error.message, 'error'));
    }, delay);
  }
  function closePeer() {
    cancelRecovery(); videoHealth.reset(); previousVideoSample = undefined; lastSentFrames = undefined; peerSession = '';
    if (pc) { pc.ontrack = pc.onconnectionstatechange = pc.onicecandidate = null; pc.close(); }
    pc = undefined; tx = undefined; s.candidates = [];
    remoteMic?.dispose(); remoteSystem?.dispose(); remoteMic = remoteSystem = remoteVideo = undefined;
    s.peer = { sharing: false, muted: false }; remoteGate.reset(); lastTarget = -1; refreshVideo();
  }
  function preferOpus(transceiver) {
    if (!transceiver?.setCodecPreferences || !window.RTCRtpReceiver?.getCapabilities) return;
    const codecs = window.RTCRtpReceiver.getCapabilities('audio')?.codecs?.filter(codec => codec.mimeType?.toLowerCase() === 'audio/opus');
    if (codecs?.length) transceiver.setCodecPreferences(codecs);
  }
  async function tuneAudioSender(sender, maxBitrate) {
    if (!sender?.getParameters || !sender?.setParameters) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    for (const encoding of parameters.encodings) {
      encoding.maxBitrate = maxBitrate;
      encoding.dtx = false;
    }
    try { await sender.setParameters(parameters); } catch {}
  }
  async function configureAudio() {
    if (!tx) return;
    await tuneAudioSender(tx.mic?.sender, 96000);
    await tuneAudioSender(tx.system?.sender, 256000);
  }
  async function buildPeer(initiator, recovering = false, sessionId = '') {
    const previousPeer = s.peer;
    closePeer();
    if (recovering) s.peer = previousPeer;
    peerSession = sessionId || (initiator ? crypto.randomUUID() : '');
    const current = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); pc = current;
    // Only the offerer creates slots. The answerer uses the offered transceivers;
    // pre-creating answerer slots creates extra m-lines and breaks two-way audio.
    if (initiator) {
      tx = { mic: current.addTransceiver('audio', { direction: 'sendrecv' }), system: current.addTransceiver('audio', { direction: 'sendrecv' }), video: current.addTransceiver('video', { direction: 'sendrecv' }) };
      preferOpus(tx.mic); preferOpus(tx.system);
    }
    current.onicecandidate = event => { if (current === pc && event.candidate) void signal({ type: 'candidate', candidate: event.candidate.toJSON(), sessionId: peerSession }); };
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
      if (current.connectionState === 'connected') { connection('通话已连接', true); refreshVideo(); void configureAudio(); void configureVideo().catch(error => notify(error.message, 'error')); notify('双方可以说话。共享电脑声音时，不会把对方的声音重新传回去。', 'success'); }
      else if (current.connectionState === 'failed') { connection('媒体连接失败，正在恢复'); requestRecovery('connection'); }
      else if (current.connectionState === 'disconnected') { connection('网络中断，正在尝试恢复'); requestRecovery('connection', 5000); }
    };
    if (tx) await attachTracks();
    if (initiator) { await current.setLocalDescription(await current.createOffer()); await signal({ type: 'description', description: current.localDescription.toJSON(), sessionId: peerSession, reset: recovering }); }
    await peerState(); await sendProfile(); connection('正在建立媒体连接'); refreshVideo();
    requestRecovery('connection', 15000);
  }
  async function attachTracks() {
    await tx.mic.sender.replaceTrack(micStream?.getAudioTracks()[0] || null);
    await tx.system.sender.replaceTrack(outgoingSystem?.getAudioTracks()[0] || null);
    await tx.video.sender.replaceTrack(localVideo?.getVideoTracks()[0] || null);
    await configureAudio();
    await configureVideo();
  }
  function configureVideo() {
    const sender = tx?.video?.sender, stream = localVideo;
    const update = videoConfiguration.catch(() => {}).then(async () => {
      if (!sender || !stream || tx?.video?.sender !== sender || localVideo !== stream) return;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) return;
      parameters.degradationPreference = 'maintain-resolution';
      for (const encoding of parameters.encodings) Object.assign(encoding, videoAdaptation.encoding(videoProfile));
      await sender.setParameters(parameters);
    });
    videoConfiguration = update;
    return update;
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
    if (direction === 'sending' && videoAdaptation.level) parts.push('已自动降低画质以保持流畅');
    if (direction === 'receiving' && ['first-frame-timeout', 'stalled'].includes(videoHealth.status)) parts.push('画面恢复中');
    $('quality').textContent = parts.join(' · ');
    $('quality').title = `所选档位 ${profile.label}。显示实际采集或传输分辨率；静止画面会减少帧率和码率。`;
  }
  let signalQueue = Promise.resolve();
  api.onSignal(message => {
    signalQueue = signalQueue.then(async () => {
      if (message.type === 'welcome') { s.role = message.role; signalReconnecting = false; }
      else if (message.type === 'peer-ready') { if (s.inRoom) { s.peerJoined = true; controls(); refreshVideo(); await buildPeer(s.role === 'host'); } }
      else if (message.type === 'description' && s.inRoom) {
        if (message.reset === true && message.description?.type === 'offer' && s.role === 'guest') await buildPeer(false, true, message.sessionId);
        if (!pc) await buildPeer(false);
        if (message.sessionId && peerSession && message.sessionId !== peerSession) return;
        if (message.sessionId) peerSession = message.sessionId;
        await pc.setRemoteDescription(message.description);
        for (const item of s.candidates.splice(0)) {
          if (!item.sessionId || item.sessionId === peerSession) await pc.addIceCandidate(item.candidate);
        }
        if (message.description.type === 'offer') {
          const slots = pc.getTransceivers(); tx = { mic: slots[0], system: slots[1], video: slots[2] };
          preferOpus(tx.mic); preferOpus(tx.system);
          for (const slot of slots) slot.direction = 'sendrecv';
          await attachTracks();
          await pc.setLocalDescription(await pc.createAnswer()); await signal({ type: 'description', description: pc.localDescription.toJSON(), sessionId: peerSession });
        }
      } else if (message.type === 'candidate' && s.inRoom) {
        if (message.sessionId && peerSession && message.sessionId !== peerSession) return;
        if (pc?.remoteDescription) await pc.addIceCandidate(message.candidate); else s.candidates.push({ candidate: message.candidate, sessionId: message.sessionId });
      } else if (message.type === 'recovery' && s.inRoom && s.peerJoined) {
        if (message.sessionId && message.sessionId !== peerSession) return;
        if (message.action === 'health') {
          videoHealth.sender(message.framesEncoded, performance.now());
          if (message.receivingHealthy === true && recoveryReason === 'remote-video' && pc?.connectionState === 'connected') cancelRecovery();
        }
        else if (message.action === 'request' && s.role === 'host' && performance.now() - lastRecoveryRequest > 10000) {
          lastRecoveryRequest = performance.now(); requestRecovery('remote-video');
        }
      } else if (message.type === 'reconnecting' && s.inRoom) {
        signalReconnecting = true; cancelRecovery(); connection('网络中断，正在重新加入房间');
      } else if (message.type === 'peer-state' && s.inRoom) {
        if (s.peer.sharing !== (message.sharing === true)) videoHealth.reset(videoStats.framesDecoded || 0);
        s.peer = { recoveryVersion: message.recoveryVersion === 1 ? 1 : 0, sharing: message.sharing === true, muted: message.muted === true, speaking: message.speaking === true && message.muted !== true, computerAudio: message.computerAudio === true, sourceDucked: message.sourceDucked === true, duckEnabled: message.duckEnabled === true, duckDepth: Number.isFinite(message.duckDepth) ? Math.max(4, Math.min(18, message.duckDepth)) : 9 }; controls(); refreshVideo();
      } else if (message.type === 'profile') {
        s.peerName = typeof message.displayName === 'string' ? message.displayName.trim().slice(0, 20) : '';
        s.peerAvatar = typeof message.avatarData === 'string' && message.avatarData.length <= 48000 && /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(message.avatarData) ? message.avatarData : '';
        refreshVideo();
      } else if (message.type === 'peer-left') {
        s.peerJoined = false; s.peerName = s.peerAvatar = ''; closePeer(); connection(s.role === 'host' ? '等待对方重新加入' : '对方已离开'); notify('对方已离开通话。');
      } else if (message.type === 'closed' && s.inRoom) { await endCall(); notify(message.message || '通话已断开。', 'error'); }
    }).catch(error => notify(`连接处理失败：${error.message}`, 'error'));
  });
  async function begin(kind) {
    if (s.busy || s.inRoom) return;
    if (kind === 'join' && !$('inviteInput').value.trim()) { notify('邀请链接无效。', 'error'); return; }
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
  async function stopSharedAudio() {
    const previous = outgoingSystem || pcmDestination?.stream; outgoingSystem = undefined; audioScope = undefined;
    previous?.getTracks().forEach(t => t.stop());
    if (pcmNode) { pcmNode.onprocessorerror = null; pcmNode.disconnect(); }
    pcmDestination?.disconnect(); pcmNode = pcmDestination = undefined;
    remainder = new Uint8Array(0);
    if (tx) await tx.system.sender.replaceTrack(null).catch(() => {});
    await api.stopAudio(); localGain = localGainTarget = lastLocalTarget = 1; lastGainTime = performance.now(); localDucked = false;
    await peerState(); controls(); refreshVideo();
  }
  async function startSharedAudio({ stream, appKey }, isCurrent) {
    const active = () => isCurrent() && s.inRoom && localVideo === stream;
    await audioContext();
    if (!active()) return;
    if (!moduleReady) moduleReady = ctx.audioWorklet.addModule('pcm-worklet.js').catch(error => { moduleReady = undefined; throw error; });
    await moduleReady;
    if (!active()) return;
    // Assign resources before starting the helper so startup failure cleanup
    // also releases the worklet and destination instead of leaking each retry.
    pcmNode = new AudioWorkletNode(ctx, 'clearcall-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    pcmDestination = ctx.createMediaStreamDestination(); pcmNode.connect(pcmDestination); pcmNode.connect(silence);
    const node = pcmNode, system = pcmDestination.stream;
    system.getAudioTracks()[0].contentHint = 'music';
    node.onprocessorerror = () => { if (active() && pcmNode === node) void audioRecovery.failed('声音处理异常'); };
    const result = await api.startAudio(appKey);
    if (!active()) return;
    outgoingSystem = system; audioScope = result.scope;
    if (tx) await tx.system.sender.replaceTrack(system.getAudioTracks()[0]);
    if (!active()) return;
    await configureAudio(); await peerState(); controls();
  }
  async function stopSharing() {
    const previous = localVideo; localVideo = undefined; sharedAudioError = '';
    videoStats = {}; previousVideoSample = undefined; videoAdaptation.reset();
    const audioStopped = audioRecovery.stop();
    if (tx) await tx.video.sender.replaceTrack(null).catch(() => {});
    previous?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    await audioStopped;
  }
  async function endCall() {
    s.inRoom = false; signalReconnecting = false; cancelRecovery(); s.peerJoined = false; s.peerName = s.peerAvatar = ''; s.generation++; $('sourceDialog').close(); await stopSharing(); closePeer();
    await stopMicrophone();
    await api.leaveRoom();
    if (ctx) { await ctx.close().catch(() => {}); ctx = undefined; }
    s.muted = true; s.speaking = false; s.role = ''; localGate.reset(); remoteGate.reset();
    $('inviteCard').classList.add('hidden'); $('inviteSelect').replaceChildren(); roomId = ''; setText('roomNumber', '------'); connection('尚未连接'); controls(); refreshVideo();
    await api.setWindowMode('connect');
  }
  function syncAudioPicker() {
    const needsApp = info.platform === 'linux' && selectedSourceKind === 'app' && $('includeAudio').checked && !$('includeAudio').disabled;
    $('linuxAudioPicker').hidden = !needsApp;
    $('confirmShare').disabled = !selectedSource || (needsApp && !$('audioApp').value);
  }
  async function refreshAudioApps() {
    const request = ++audioAppsGeneration, oldValue = $('audioApp').value;
    $('refreshAudioApps').disabled = true;
    try {
      const apps = await api.audioApps();
      if (request !== audioAppsGeneration) return;
      $('audioApp').replaceChildren(new Option(apps.length ? '请选择声音应用' : '请先播放声音并刷新', ''));
      for (const item of apps) $('audioApp').add(new Option(`${item.name}（${item.binary}）`, item.id));
      if (apps.some(item => item.id === oldValue)) $('audioApp').value = oldValue;
      setText('scopeHint', '请播放目标应用声音并选择；同一浏览器可能包含其他标签页。');
    } catch (error) {
      if (request !== audioAppsGeneration) return;
      $('audioApp').replaceChildren(new Option('声音应用不可用', ''));
      setText('scopeHint', error.message);
    } finally { if (request === audioAppsGeneration) { $('refreshAudioApps').disabled = false; syncAudioPicker(); } }
  }
  async function openSources() {
    s.busy = true; controls(); selectedSource = selectedSourceKind = undefined; audioAppsGeneration++; syncAudioPicker();
    try {
      info = await api.info();
      const sources = await api.sources(); $('sourceGrid').replaceChildren();
      for (const source of sources) {
        const button = document.createElement('button'); button.className = 'source-item'; button.type = 'button';
        const image = document.createElement('img'); image.src = source.thumbnail || 'icons/monitor.svg'; image.alt = '';
        const label = document.createElement('span'); label.textContent = source.name; button.append(image, label);
        button.addEventListener('click', () => {
          selectedSource = source.id; selectedSourceKind = source.kind; audioAppsGeneration++;
          for (const child of $('sourceGrid').children) child.classList.toggle('selected', child === button);
          setText('audioScopeLabel', source.kind === 'app' ? '同时共享所选应用的声音' : '同时共享其他所有应用的声音');
          setText('scopeHint', !info.nativeAudio ? '当前系统暂不支持共享应用声音，可以共享画面并使用麦克风。' : info.platform === 'linux' && source.kind === 'app' ? '请播放目标应用声音并选择；同一浏览器可能包含其他标签页。' : info.platform === 'linux' ? '共享可识别的其他应用声音，映伴通话声音会被排除。' : source.kind === 'app' ? '仅共享此应用的声音；同一浏览器可能包含其他标签页。' : '共享其他所有应用声音，映伴通话声音会被排除。');
          syncAudioPicker();
          if (!$('linuxAudioPicker').hidden) void refreshAudioApps();
        });
        $('sourceGrid').append(button);
      }
      if (!sources.length) throw new Error('没有找到可共享的屏幕或窗口。');
      $('includeAudio').disabled = !info.nativeAudio; if (!info.nativeAudio) { $('includeAudio').checked = false; setText('scopeHint', '当前系统暂不支持共享应用声音，可以共享画面并使用麦克风。'); }
      $('sourceDialog').showModal();
    } catch (error) { notify(error.message, 'error'); }
    finally { s.busy = false; controls(); }
  }
  async function startSharing() {
    if (!selectedSource || !s.inRoom || s.busy) return;
    const generation = s.generation, withAudio = $('includeAudio').checked;
    videoProfile = videoProfiles[$('videoQuality').value] || videoProfiles['4k'];
    s.busy = true; sharedAudioError = ''; videoAdaptation.reset(); $('sourceDialog').close(); controls();
    let operationVideo;
    try {
      await api.selectSource(selectedSource);
      operationVideo = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: videoProfile.width }, height: { max: videoProfile.height }, frameRate: { ideal: videoProfile.fps, max: videoProfile.fps } }, audio: false });
      localVideo = operationVideo;
      if (!s.inRoom || generation !== s.generation) { operationVideo.getTracks().forEach(t => { t.onended = null; t.stop(); }); if (localVideo === operationVideo) await stopSharing(); return; }
      const track = operationVideo.getVideoTracks()[0]; track.contentHint = 'detail'; track.onended = () => { if (localVideo === operationVideo) void stopSharing(); };
      const native = track.getCapabilities();
      const nativeWidth = native.width?.max || track.getSettings().width;
      const nativeHeight = native.height?.max || track.getSettings().height;
      // Request detail up to the chosen ceiling, without upscaling a small window.
      const scale = Math.min(1, videoProfile.width / nativeWidth, videoProfile.height / nativeHeight);
      await track.applyConstraints({ width: { ideal: Math.floor(nativeWidth * scale), max: videoProfile.width }, height: { ideal: Math.floor(nativeHeight * scale), max: videoProfile.height }, frameRate: { ideal: videoProfile.fps, max: videoProfile.fps } });
      if (!s.inRoom || generation !== s.generation) { operationVideo.getTracks().forEach(t => { t.onended = null; t.stop(); }); if (localVideo === operationVideo) await stopSharing(); return; }
      if (tx) {
        await tx.video.sender.replaceTrack(track); await tx.system.sender.replaceTrack(outgoingSystem?.getAudioTracks()[0] || null);
        await configureVideo();
      }
      await peerState(); refreshVideo();
      if (withAudio && localVideo === operationVideo && s.inRoom && generation === s.generation) await audioRecovery.begin({ stream: operationVideo, appKey: $('audioApp').value });
    } catch (error) {
      if (localVideo === operationVideo) await stopSharing();
      else operationVideo?.getTracks().forEach(t => { t.onended = null; t.stop(); });
      notify(`共享未启动：${error.message}`, 'error');
    }
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
  api.onAudioEnded(({ message } = {}) => { if (s.inRoom && localVideo) void audioRecovery.failed(message); });
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
    localGainTarget = localVideo && outgoingSystem && duck ? window.sharedGain(1, true, s.duckDepth) : 1;
    const elapsed = Math.max(0, now - lastGainTime); lastGainTime = now;
    localGain = window.rampGain(localGain, localGainTarget, elapsed);
    if (Math.abs(localGain - lastLocalTarget) > 0.002 || Math.abs(localGainTarget - lastLocalTarget) > 0.002) {
      lastLocalTarget = localGain;
      void api.duckLocal(localGain).catch(error => notify(`本机视频降音量失败：${error.message}`, 'error'));
    }
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
    if (statsBusy || pc?.connectionState !== 'connected') { refreshQualityLabel(); return; }
    const current = pc; statsBusy = true;
    try {
      const reports = await current.getStats();
      if (pc !== current) return;
      const now = performance.now(), receiving = s.peer.sharing;
      const rows = Array.from(reports.values());
      const inbound = rows.find(r => r.type === 'inbound-rtp' && r.kind === 'video' && !r.isRemote);
      const outbound = rows.find(r => r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote);
      const video = receiving ? inbound : outbound;
      const pair = rows.find(r => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated);
      const health = videoHealth.sample({ sharing: receiving, connected: true, framesDecoded: inbound?.framesDecoded }, now);
      if (health === 'first-frame-timeout' || health === 'stalled') requestRecovery('video');
      else if (recoveryReason !== 'remote-video' && (health === 'healthy' || !receiving)) cancelRecovery();
      if (s.peer.recoveryVersion === 1) void signal({ type: 'recovery', action: 'health', sessionId: peerSession, framesEncoded: localVideo ? outbound?.framesEncoded : undefined, receivingHealthy: receiving && health === 'healthy' });
      const active = localVideo && lastSentFrames !== undefined && outbound?.framesEncoded > lastSentFrames;
      lastSentFrames = localVideo ? outbound?.framesEncoded : undefined;
      const remote = outbound?.remoteId ? reports.get(outbound.remoteId) : undefined;
      if (videoAdaptation.sample({ active, limited: outbound?.qualityLimitationReason, loss: remote?.fractionLost, rtt: (pair?.currentRoundTripTime || 0) * 1000 }, now)) {
        await configureVideo().catch(error => notify(`自动画质调整失败：${error.message}`, 'error'));
      }
      if (video) {
        const bytes = receiving ? video.bytesReceived : video.bytesSent;
        const previous = previousVideoSample;
        const mbps = previous?.id === video.id && video.timestamp > previous.time ? Math.max(0, (bytes - previous.bytes) * 8 / (video.timestamp - previous.time) / 1000) : undefined;
        previousVideoSample = { id: video.id, time: video.timestamp, bytes };
        videoStats = { direction: receiving ? 'receiving' : 'sending', width: video.frameWidth, height: video.frameHeight, fps: video.framesPerSecond, mbps, rtt: pair ? Math.round((pair.currentRoundTripTime || 0) * 1000) : undefined, limitation: video.qualityLimitationReason, codec: reports.get(video.codecId)?.mimeType, framesDecoded: inbound?.framesDecoded, framesEncoded: outbound?.framesEncoded, health, adaptation: videoAdaptation.level };
      }
      const element = $('screenVideo');
      if (receiving && element.srcObject && element.paused && (!document.hidden || document.pictureInPictureElement)) void element.play().catch(() => {});
      refreshQualityLabel();
    } catch { }
    finally { statsBusy = false; }
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
  $('outputDevice').addEventListener('change', () => { void setOutputDevice($('outputDevice').value); });
  $('shareScreen').addEventListener('click', () => { void openSources(); });
  $('stopShare').addEventListener('click', () => { void stopSharing(); });
  $('retrySharedAudio').addEventListener('click', async () => {
    if (s.busy || !localVideo || !s.inRoom) return;
    s.busy = true; controls();
    try { await audioRecovery.retry(); }
    catch (error) { notify(error.message, 'error'); }
    finally { s.busy = false; controls(); }
  });
  $('closeDialog').addEventListener('click', () => $('sourceDialog').close());
  $('settingsButton').addEventListener('click', () => { void api.openSettings(); });
  $('homeSettings').addEventListener('click', () => { void api.openSettings(); });
  $('confirmShare').addEventListener('click', () => { void startSharing(); });
  $('audioApp').addEventListener('change', syncAudioPicker);
  $('refreshAudioApps').addEventListener('click', () => { void refreshAudioApps(); });
  $('includeAudio').addEventListener('change', () => { syncAudioPicker(); if (!$('linuxAudioPicker').hidden) void refreshAudioApps(); });
  $('videoQuality').addEventListener('change', () => {
    const profile = videoProfiles[$('videoQuality').value];
    $('qualityHint').textContent = `${profile.width}×${profile.height} 上限 · 最高 ${profile.fps} 帧/秒 · 码率上限 ${profile.bitrate / 1000000} Mbps。实际清晰度取决于共享源、网络与设备，静态内容用量更低。`;
  });
  $('copyInvite').addEventListener('click', async () => {
    if (!$('inviteSelect').value) return;
    const target = $('inviteSelect').value;
    const link = `https://baek-nanxun.github.io/yingban/join/?target=${encodeURIComponent(target)}`;
    await api.copy(`加入映伴通话\n点击链接：${link}\n房间号：${roomId}\n两台电脑需在同一局域网或同一 Tailscale 网络。`);
    notify('邀请信息已复制，包含链接和房间号', 'success');
  });
  $('copyRoom').addEventListener('click', async () => { if (roomId) { await api.copy(roomId); notify('房间号已复制', 'success'); } });
  $('duckDepth').addEventListener('input', () => { s.duckDepth = Number($('duckDepth').value); $('duckDepthLabel').textContent = `${s.duckDepth} dB`; void peerState(); });
  $('duckEnabled').addEventListener('change', () => { s.duckEnabled = $('duckEnabled').checked; void peerState(); });
  $('sharedVolume').addEventListener('input', () => { $('sharedVolumeLabel').textContent = `${$('sharedVolume').value}%`; });
  $('sensitivity').addEventListener('input', () => { const v = Number($('sensitivity').value); $('sensitivityLabel').textContent = v < 36 ? '偏低' : v > 49 ? '偏高' : '适中'; });
  $('fullscreen').addEventListener('click', () => { void (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error => notify(`全屏未能开启：${error.message}`, 'error')); });
  $('pictureInPicture').addEventListener('click', () => {
    const video = $('screenVideo');
    void (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(error => notify(`浮窗未能开启：${error.message}`, 'error'));
  });
  $('screenVideo').addEventListener('enterpictureinpicture', () => { $('pictureInPicture').title = $('pictureInPicture').ariaLabel = '退出浮窗'; $('pictureInPicture').querySelector('use').setAttribute('href', 'icons.svg#x'); });
  $('screenVideo').addEventListener('leavepictureinpicture', () => { $('pictureInPicture').title = $('pictureInPicture').ariaLabel = '浮窗'; $('pictureInPicture').querySelector('use').setAttribute('href', 'icons.svg#picture-in-picture'); });
  document.addEventListener('fullscreenchange', () => { $('fullscreen').title = $('fullscreen').ariaLabel = document.fullscreenElement ? '退出全屏' : '全屏'; $('fullscreen').querySelector('use').setAttribute('href', `icons.svg#${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}`); });
  function applyPreferences({ preferences: p }) {
    const restart = micStream && (inputMode !== p.inputMode || $('micDevice').value !== p.micDevice);
    s.duckEnabled = p.duckEnabled; s.duckDepth = p.duckDepth; inputMode = p.inputMode;
    const profileChanged = localProfile.displayName !== p.displayName || localProfile.avatarData !== p.avatarData;
    localProfile = { displayName: p.displayName || '', avatarData: p.avatarData || '' };
    if (outputDevice !== p.outputDevice) void setOutputDevice(p.outputDevice);
    $('sharedVolume').value = p.sharedVolume; $('sensitivity').value = p.sensitivity;
    if (Array.from($('micDevice').options).some(o => o.value === p.micDevice)) $('micDevice').value = p.micDevice;
    controls(); refreshVideo(); void peerState(); if (profileChanged && s.inRoom) void sendProfile();
    if (restart) void stopMicrophone().then(() => microphone()).catch(error => notify(error.message, 'error'));
  }
  function updateWindowState({ maximized = false } = {}) {
    const button = $('windowMaximize');
    if (!button) return;
    button.title = button.ariaLabel = maximized ? '还原' : '最大化';
  }
  $('windowMinimize').addEventListener('click', () => { void api.minimizeWindow(); });
  $('windowMaximize').addEventListener('click', () => { void api.toggleMaximizeWindow(); });
  $('windowClose').addEventListener('click', () => { void api.closeWindow(); });
  api.onWindowState(updateWindowState);
  api.onSettings(applyPreferences); api.onSettingsVisible(visible => { settingsVisible = visible; });
  api.onProtocolInvite(value => {
    if (typeof value !== 'string') return;
    $('inviteInput').value = value;
    if (!s.inRoom && !s.busy) void begin('join');
  });
  api.onMiniCommand(action => { if (action !== 'toggle-mic') return; void (micStream ? stopMicrophone() : microphone()).catch(error => notify(error.message, 'error')); });
  void api.getSettings().then(applyPreferences);
  setInterval(() => { if (settingsVisible) void api.reportStatus({ mic: Boolean(micStream), connected: pc?.connectionState === 'connected', speaking: s.speaking, remoteSpeaking: Boolean(s.peer.speaking), remoteMuted: s.peer.muted, localLevel: level(micMonitor), remoteLevel: level(remoteMic), sharing: Boolean(localVideo), peerSharing: s.peer.sharing, peerDuckEnabled: s.peer.duckEnabled, peerDuckDepth: s.peer.duckDepth, ducking: localDucked || s.peer.sourceDucked }); }, 200);
  api.info().then(result => { info = result; document.body.dataset.platform = result.platform; }).catch(() => {}); void devices().catch(() => {}); controls();
  navigator.mediaDevices.addEventListener('devicechange', () => { void devices().catch(() => {}); });
  window.clearcallDiagnostics = () => ({ inRoom: s.inRoom, role: s.role, connection: pc?.connectionState || 'none', mic: Boolean(micStream), muted: s.muted, sharing: Boolean(localVideo), computerAudio: Boolean(outgoingSystem), peerSharing: s.peer.sharing, localDucked, peerSourceDucked: s.peer.sourceDucked, localLevel: level(micMonitor), remoteLevel: level(remoteMic), sharedLevel: level(remoteSystem), context: ctx?.state, remoteTracks: pc?.getReceivers().map(x => ({ kind: x.track.kind, muted: x.track.muted, state: x.track.readyState })), sharedGain: remoteSystem?.gain.gain.value, screen: { width: $('screenVideo').videoWidth, height: $('screenVideo').videoHeight }, audioScope, audioRecovery: { state: sharedAudioStatus, attempts: audioRecovery.attempts, error: sharedAudioError }, capture: localVideo?.getVideoTracks()[0]?.getSettings(), videoProfile, videoStats, recovery: { attempts: recoveryAttempts, pending: recoveryPending || Boolean(recoveryTimer), reason: recoveryReason, sessionId: peerSession, health: videoHealth.status, signalReconnecting }, encoder: tx?.video.sender.getParameters(), audioEncodings: { mic: tx?.mic?.sender.getParameters().encodings, system: tx?.system?.sender.getParameters().encodings } });
  window.clearcallMediaStats = async () => pc ? Array.from((await pc.getStats()).values()).filter(r => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(r.type)).map(r => ({ type: r.type, kind: r.kind, mid: r.mid, audioLevel: r.audioLevel, totalAudioEnergy: r.totalAudioEnergy, packetsReceived: r.packetsReceived, packetsSent: r.packetsSent, bytesSent: r.bytesSent })) : [];
})();
