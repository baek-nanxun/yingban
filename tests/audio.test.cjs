const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechGate, sharedGain, rampGain } = require('../app/audio-logic.js');
test('a transient does not duck; sustained speech does; silence restores after hangover', () => {
  const gate = new SpeechGate();
  assert.equal(gate.update(0.1, 100), false);
  assert.equal(gate.update(0, 150), false);
  assert.equal(gate.update(0.1, 300), false);
  assert.equal(gate.update(0.1, 350), false);
  assert.equal(gate.update(0.1, 400), false);
  assert.equal(gate.update(0.1, 450), true);
  assert.equal(gate.update(0, 800), true);
  assert.equal(gate.update(0, 1100), false);
});
test('background noise stays below the gate and reset clears speech', () => {
  const gate = new SpeechGate();
  for (let t = 50; t < 3000; t += 50) assert.equal(gate.update(0.002, t), false);
  gate.update(0.1, 3100); assert.equal(gate.update(0.1, 3250), true);
  gate.reset(); assert.equal(gate.update(0, 3250), false);
});
test('ducking preserves user volume and silence, with no amplification', () => {
  assert.equal(sharedGain(0.8, false, 15), 0.8);
  assert(Math.abs(sharedGain(0.8, true, 20) - 0.08) < 1e-8);
  assert.equal(sharedGain(0, true, 20), 0);
  assert.equal(sharedGain(2, false, 10), 1);
});

test('ducking ramps toward the target instead of jumping between levels', () => {
  const down = rampGain(1, 0.35, 260), up = rampGain(0.35, 1, 520);
  assert(down < 0.8 && down > 0.55);
  assert(up > 0.55 && up < 0.8);
  assert.equal(rampGain(0.5, 0.2, 0), 0.5);
});
