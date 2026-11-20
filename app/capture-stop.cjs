'use strict';

// Wait for the helper to restore source volumes before another capture starts.
function stopCaptureProcess(child, graceMs = 1000, terminateMs = 4000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let timer, forceTimer;
    const done = () => {
      clearTimeout(timer); clearTimeout(forceTimer);
      child.removeListener('exit', done); child.removeListener('close', done);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
    timer = setTimeout(() => {
      forceTimer = setTimeout(() => child.kill('SIGKILL'), terminateMs);
      child.kill('SIGTERM');
    }, graceMs);
    // A closed pipe still needs the exit barrier: restoration may be in progress.
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end('\n');
  });
}
module.exports = { stopCaptureProcess };
