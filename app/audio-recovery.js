((root) => {
  'use strict';
  // Serialize helper teardown/startup, including a cancelled startup that has
  // not resolved yet. A retry always uses the original selected source.
  class AudioRecovery {
    constructor({ start, stop, status, timers = globalThis, now = () => Date.now() }) {
      Object.assign(this, { startCapture: start, stopCapture: stop, status, timers, now });
      this.queue = Promise.resolve(); this.session = null; this.timer = undefined;
      this.pending = false; this.attempts = 0; this.startedAt = undefined;
    }
    enqueue(work) {
      const next = this.queue.then(work);
      this.queue = next.catch(() => {});
      return next;
    }
    clearTimer() { this.timers.clearTimeout(this.timer); this.timer = undefined; }
    begin(source) {
      this.clearTimer(); this.session = { source }; this.attempts = 0;
      this.startedAt = undefined; this.pending = false;
      return this.retry();
    }
    retry() {
      const session = this.session;
      if (!session || this.pending) return this.queue;
      this.clearTimer(); this.pending = true;
      return this.enqueue(async () => {
        if (this.session !== session) return;
        session.failure = null;
        try {
          this.status('starting');
          await this.stopCapture();
          if (this.session !== session) return;
          await this.startCapture(session.source, () => this.session === session && !session.failure);
          if (this.session !== session) return;
          if (session.failure) throw session.failure;
          this.pending = false; this.startedAt = this.now(); this.status('running');
        } catch (error) {
          // Cleanup must finish before the next helper may start.
          try { await this.stopCapture(); } catch (cleanupError) { error = cleanupError; }
          if (this.session !== session) return;
          this.pending = false; this.schedule(error);
        }
      });
    }
    failed(error) {
      if (!this.session) return;
      const failure = error instanceof Error ? error : new Error(error || '共享声音中断');
      if (this.pending) { this.session.failure = failure; return; }
      if (this.timer !== undefined) return;
      if (this.startedAt !== undefined && this.now() - this.startedAt >= 30000) this.attempts = 0;
      const session = this.session;
      this.pending = true;
      return this.enqueue(async () => {
        if (this.session !== session) return;
        try { await this.stopCapture(); } catch (error) { if (this.session === session) { this.pending = false; this.schedule(error); } return; }
        if (this.session !== session) return;
        this.pending = false; this.schedule(failure);
      });
    }
    schedule(error) {
      if (!this.session) return;
      const session = this.session, delay = Math.min(1000 * 2 ** Math.min(this.attempts++, 4), 10000);
      this.status('retrying', error.message, delay);
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        if (this.session === session) void this.retry();
      }, delay);
    }
    stop() {
      this.session = null; this.clearTimer(); this.pending = false; this.startedAt = undefined;
      return this.enqueue(async () => { await this.stopCapture(); if (!this.session) this.status('stopped'); });
    }
  }
  if (typeof module !== 'undefined') module.exports = { AudioRecovery };
  else root.AudioRecovery = AudioRecovery;
})(globalThis);
