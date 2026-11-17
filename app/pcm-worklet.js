class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = sampleRate;
    this.ring = new Float32Array(this.capacity * 2);
    this.read = 0; this.write = 0; this.count = 0; this.started = false;
    this.port.onmessage = ({ data }) => {
      const frames = data.length / 2;
      // Bound latency rather than accumulating a backlog after a UI/process stall.
      if (this.count + frames > sampleRate * 0.2) { this.read = this.write; this.count = 0; this.started = false; }
      for (let f = 0; f < frames; f++) {
        this.ring[this.write * 2] = data[f * 2];
        this.ring[this.write * 2 + 1] = data[f * 2 + 1];
        this.write = (this.write + 1) % this.capacity;
        this.count++;
      }
    };
  }
  process(inputs, outputs) {
    const channels = outputs[0];
    if (!this.started && this.count >= sampleRate * 0.03) this.started = true;
    if (!this.started) return true;
    for (let f = 0; f < channels[0].length; f++) {
      if (this.count === 0) { this.started = false; break; }
      channels[0][f] = this.ring[this.read * 2];
      if (channels[1]) channels[1][f] = this.ring[this.read * 2 + 1];
      this.read = (this.read + 1) % this.capacity; this.count--;
    }
    return true;
  }
}
registerProcessor('clearcall-pcm', PCMPlayer);
