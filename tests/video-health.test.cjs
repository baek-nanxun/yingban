const test = require('node:test');
const assert = require('node:assert/strict');
const { VideoHealth, VideoAdaptation } = require('../app/video-health.js');

test('missing first frame times out only while a peer is sharing and connected', () => {
  const health = new VideoHealth();
  assert.equal(health.sample({ sharing: false, connected: true }, 100000), 'idle');
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 0 }, 101000), 'waiting');
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 0 }, 116000), 'first-frame-timeout');
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 1 }, 117000), 'healthy');
  assert.equal(health.sample({ sharing: true, connected: false }, 200000), 'idle');
});

test('a static desktop never triggers recovery without fresh encoder progress', () => {
  const health = new VideoHealth();
  health.sample({ sharing: true, connected: true, framesDecoded: 1 }, 0);
  for (let now = 1000; now <= 60000; now += 1000) {
    health.sender(1, now);
    assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 1 }, now), 'healthy');
  }
  health.sender(2, 61000);
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 1 }, 61000), 'stalled');
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 2 }, 62000), 'healthy');
});

test('stale sender reports and old sessions cannot establish a stall', () => {
  const health = new VideoHealth();
  health.sender(1, 0); health.sender(2, 1000);
  health.sample({ sharing: true, connected: true, framesDecoded: 1 }, 1000);
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 1 }, 20000), 'healthy');
  health.reset();
  assert.equal(health.sample({ sharing: true, connected: true, framesDecoded: 0 }, 21000), 'waiting');
});

test('quality responds to sustained pressure, retains resolution first, and upgrades slowly', () => {
  const adaptation = new VideoAdaptation();
  const profile = { bitrate: 25000000, fps: 30 };
  const bad = { active: true, limited: 'bandwidth' }, good = { active: true, limited: 'none' };
  assert.equal(adaptation.sample(bad, 0), false);
  assert.equal(adaptation.sample(good, 2000), false);
  assert.equal(adaptation.sample(bad, 3000), false);
  assert.equal(adaptation.sample(bad, 8000), true);
  assert.deepEqual(adaptation.encoding(profile), { maxBitrate: 25000000, maxFramerate: 15, scaleResolutionDownBy: 1 });
  adaptation.sample(bad, 9000);
  assert.equal(adaptation.sample(bad, 15000), false);
  assert.equal(adaptation.sample(bad, 18000), true);
  assert.equal(adaptation.encoding(profile).scaleResolutionDownBy, 1.5);
  adaptation.sample(good, 19000);
  assert.equal(adaptation.sample(good, 48000), false);
  assert.equal(adaptation.sample(good, 49000), true);
  assert.equal(adaptation.level, 1);
  adaptation.reset(); assert.equal(adaptation.level, 0);
});

test('idle screens do not trigger quality oscillation from stale limitations', () => {
  const adaptation = new VideoAdaptation();
  adaptation.sample({ active: true, limited: 'cpu' }, 0);
  adaptation.sample({ active: false, limited: 'cpu' }, 3000);
  assert.equal(adaptation.sample({ active: true, limited: 'cpu' }, 60000), false);
  assert.equal(adaptation.level, 0);
});
