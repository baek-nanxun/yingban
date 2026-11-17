/* The prototype uses a band-limited energy gate with onset/hangover, not an ML speech classifier. */
(function (root) {
  class SpeechGate {
    constructor() { this.reset(); }
    reset() { this.floor = 0.001; this.onset = 0; this.lastVoice = -Infinity; }
    update(rms, now, thresholdDb = -42) {
      const threshold = Math.max(10 ** (thresholdDb / 20), this.floor * 2.8);
      if (rms > threshold) {
        if (!this.onset) this.onset = now;
        if (now - this.onset >= 80) this.lastVoice = now;
      } else {
        this.onset = 0;
        if (now - this.lastVoice > 650) this.floor = Math.max(0.0003, Math.min(0.01, this.floor * 0.98 + rms * 0.02));
      }
      return now - this.lastVoice < 650;
    }
  }
  const sharedGain = (volume, duck, depthDb) => Math.max(0, Math.min(1, volume)) * (duck ? 10 ** (-Math.max(0, depthDb) / 20) : 1);
  if (typeof module !== 'undefined') module.exports = { SpeechGate, sharedGain };
  else { root.SpeechGate = SpeechGate; root.sharedGain = sharedGain; }
})(typeof window === 'undefined' ? globalThis : window);
