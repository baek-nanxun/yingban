((root) => {
  'use strict';
  class VideoHealth {
    constructor() { this.reset(); }
    reset(framesDecoded = 0) { this.started = undefined; this.lastDecoded = undefined; this.decoded = framesDecoded; this.senderFrames = undefined; this.senderActive = -Infinity; this.status = 'idle'; }
    sender(frames, now) {
      if (Number.isFinite(frames)) {
        if (this.senderFrames !== undefined && frames > this.senderFrames) this.senderActive = now;
        this.senderFrames = frames;
      }
    }
    sample({ sharing, connected, framesDecoded }, now) {
      if (!sharing || !connected) { this.started = undefined; this.lastDecoded = undefined; this.decoded = framesDecoded || 0; return this.status = 'idle'; }
      if (this.started === undefined) this.started = now;
      if (Number.isFinite(framesDecoded)) {
        if (framesDecoded > 0 && (this.decoded === undefined || framesDecoded > this.decoded)) this.lastDecoded = now;
        this.decoded = framesDecoded;
      }
      if (this.lastDecoded === undefined) return this.status = now - this.started >= 15000 ? 'first-frame-timeout' : 'waiting';
      // Static screen capture is allowed to stop producing frames. Only a fresh
      // sender report showing encoded-frame progress can establish a stall.
      return this.status = now - this.lastDecoded >= 10000 && now - this.senderActive < 4000 ? 'stalled' : 'healthy';
    }
  }
  class VideoAdaptation {
    constructor() { this.reset(); }
    reset() { this.level = 0; this.badSince = this.goodSince = undefined; this.changedAt = -Infinity; }
    sample({ active, limited, loss = 0, rtt = 0 }, now) {
      if (!active) { this.badSince = this.goodSince = undefined; return false; }
      const bad = limited === 'cpu' || limited === 'bandwidth' || loss > 0.08 || rtt > 600;
      if (bad) {
        this.goodSince = undefined;
        if (this.badSince === undefined) this.badSince = now;
        if (this.level < 3 && now - this.badSince >= 5000 && now - this.changedAt >= 10000) {
          this.level++; this.changedAt = now; this.badSince = undefined; return true;
        }
      } else {
        this.badSince = undefined;
        if (this.goodSince === undefined) this.goodSince = now;
        if (this.level > 0 && now - this.goodSince >= 30000 && now - this.changedAt >= 30000) {
          this.level--; this.changedAt = now; this.goodSince = undefined; return true;
        }
      }
      return false;
    }
    encoding(profile) {
      const scale = this.level < 2 ? 1 : this.level === 2 ? 1.5 : 2;
      return { maxBitrate: Math.round(profile.bitrate / (scale * scale)), maxFramerate: this.level ? Math.min(profile.fps, 15) : profile.fps, scaleResolutionDownBy: scale };
    }
  }
  const exports = { VideoHealth, VideoAdaptation };
  if (typeof module !== 'undefined') module.exports = exports;
  else Object.assign(root, exports);
})(globalThis);
