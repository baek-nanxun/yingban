// Read-only device and responsiveness probe. No recording and no speaker playback.
const { _electron } = require('playwright');
const { join } = require('node:path');
const { writeFileSync, mkdirSync } = require('node:fs');
const root = join(__dirname, '..');
const out = join(root, 'test-results'); mkdirSync(out, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const app = await _electron.launch({ executablePath: join(root, 'dist/YingBan-Windows/YingBan.exe'), args: [`--user-data-dir=${join(out, 'diagnose-old')}`] });
  const result = { version: '1.0.0', phases: [] };
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => window.clearcallDiagnostics);
    result.devices = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: d.label })));
    await page.locator('#fullscreen').click();
    result.fullscreen = await page.evaluate(() => ({ allowed: document.fullscreenEnabled, active: !!document.fullscreenElement }));
    result.nativeFullscreen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    async function sample(name) {
      await app.evaluate(({ app }) => app.getAppMetrics());
      const timing = await page.evaluate(async () => {
        const gaps = [], tasks = []; let previous = performance.now();
        const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration))); observer.observe({ type: 'longtask' });
        const id = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 16);
        await new Promise(r => setTimeout(r, 4000)); clearInterval(id); observer.disconnect();
        gaps.sort((a,b) => a-b);
        return { p95TimerMs: gaps[Math.floor(gaps.length * 0.95)], maxTimerMs: Math.max(...gaps), longTasks: tasks };
      });
      result.phases.push({ name, timing, processes: await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage }))) });
    }
    await sample('idle');
    const opened = await page.evaluate(async () => {
      const start = performance.now();
      window.probeAudioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await window.probeAudioContext.resume();
      const gain = window.probeAudioContext.createGain(); gain.gain.value = 0; gain.connect(window.probeAudioContext.destination);
      return { durationMs: performance.now() - start, baseLatency: window.probeAudioContext.baseLatency };
    }); result.audioContext = opened;
    await sample('audio-output-open');
    result.microphone = await page.evaluate(async () => {
      const start = performance.now(); let timedOut = false;
      const pending = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }).then(stream => {
        if (timedOut) { stream.getTracks().forEach(t => t.stop()); return { error: 'late response' }; }
        window.probeMic = stream;
        const source = window.probeAudioContext.createMediaStreamSource(stream), analyser = window.probeAudioContext.createAnalyser(), zero = window.probeAudioContext.createGain();
        zero.gain.value = 0; source.connect(analyser); analyser.connect(zero); zero.connect(window.probeAudioContext.destination);
        return { durationMs: performance.now() - start, settings: stream.getAudioTracks()[0].getSettings() };
      }).catch(e => ({ error: e.name, message: e.message }));
      return Promise.race([pending, new Promise(resolve => setTimeout(() => { timedOut = true; resolve({ error: 'timeout' }); }, 10000))]);
    });
    await sample('microphone-open');
    await page.evaluate(async () => { window.probeMic?.getTracks().forEach(t => t.stop()); await window.probeAudioContext.close(); });
    await sample('devices-closed');
    writeFileSync(join(out, 'startup-before.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
