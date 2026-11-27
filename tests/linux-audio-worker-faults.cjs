'use strict';
// Test-only preload for the real worker in the private PipeWire session. Keep
// faults inside this process so the test can still inspect the real audio server.
const assert = require('node:assert/strict');
const audio = require('../app/linux-audio.cjs');
const childProcess = require('node:child_process');
const captures = new Map();
let metadataFailures = 0, volumeFailures = 0;
const notify = message => { if (process.connected) process.send(message); };
const listStreams = audio.listStreams;
audio.listStreams = async (...args) => {
  if (metadataFailures > 0) {
    metadataFailures--;
    notify({ event: 'metadata-failure' });
    throw new Error('Injected metadata lookup failure');
  }
  return listStreams(...args);
};
const pactl = audio.pactl;
audio.pactl = async (...args) => {
  if (volumeFailures > 0 && args[0] === 'set-sink-input-volume') {
    volumeFailures--;
    notify({ event: 'volume-failure' });
    throw new Error('Injected stream volume failure');
  }
  return pactl(...args);
};
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0] === 'parec') {
    const index = Number(args[1].find(arg => arg.startsWith('--monitor-stream=')).split('=')[1]);
    captures.set(index, child);
    notify({ event: 'capture-start', index });
    child.on('exit', () => {
      if (captures.get(index) === child) captures.delete(index);
      notify({ event: 'capture-exit', index });
    });
  }
  return child;
};
process.on('message', async message => {
  try {
    if (message.command === 'faults') {
      metadataFailures = message.metadata || 0;
      volumeFailures = message.volume || 0;
    } else if (message.command === 'kill-capture') {
      const child = captures.get(message.index);
      assert(child, `No capture for stream ${message.index}`);
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    } else throw new Error(`Unknown test command: ${message.command}`);
    notify({ reply: message.id });
  } catch (error) { notify({ reply: message.id, error: error.message }); }
});
