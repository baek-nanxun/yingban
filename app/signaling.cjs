const { WebSocket: DefaultWebSocket } = require('ws');

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 10000];
const DEFAULT_RECONNECT_WINDOW_MS = 60_000;
const DEFAULT_SOCKET_OPTIONS = { maxPayload: 128 * 1024, handshakeTimeout: 8000 };

function closeMessage(code, reason, opened = true) {
  if (!opened) return '无法连接到对方。';
  if (String(reason) === 'Room full') return '通话已满，只支持两台电脑。';
  return '连接已断开，请重新加入。';
}

function createSignalingConnection(endpoint, {
  WebSocket = DefaultWebSocket,
  timers = globalThis,
  now = () => Date.now(),
  reconnectWindowMs = DEFAULT_RECONNECT_WINDOW_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  socketOptions = DEFAULT_SOCKET_OPTIONS,
  onSignal = () => {},
  onSocket = () => {}
} = {}) {
  let current;
  let role;
  let closed = false;
  let initialSettled = false;
  let reconnectStartedAt;
  let reconnectAttempt = 0;
  let reconnectCode;
  let reconnectReason;
  let retryTimer;
  let deadlineTimer;
  let connectPromise;
  let resolveInitial;
  let rejectInitial;

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const clearDeadline = () => {
    if (deadlineTimer !== undefined) {
      timers.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  };

  const emit = signal => {
    try { onSignal(signal); } catch {}
  };

  const setSocket = socket => {
    current = socket;
    try { onSocket(socket); } catch {}
  };

  const settleInitial = (error, opened = false) => {
    if (initialSettled) return;
    initialSettled = true;
    if (error) rejectInitial(error);
    else resolveInitial();
    if (!opened) setSocket(undefined);
  };

  const canRetry = (code, reason) => {
    if (role !== 'guest' || code === 1000) return false;
    if (code === 1001 && String(reason) === 'Host left') return false;
    if (code === 1008 && String(reason) !== 'Room full') return false;
    return true;
  };

  const endReconnect = (code, reason) => {
    clearRetry();
    clearDeadline();
    reconnectStartedAt = undefined;
    reconnectAttempt = 0;
    reconnectCode = reconnectReason = undefined;
    emit({ type: 'closed', message: closeMessage(code, reason) });
  };

  const scheduleRetry = (lastCode, lastReason) => {
    if (closed) return;
    const elapsed = now() - reconnectStartedAt;
    const remaining = reconnectWindowMs - elapsed;
    if (remaining <= 0) {
      endReconnect(lastCode, lastReason);
      return;
    }
    const nextDelay = backoffMs.length ? backoffMs[Math.min(reconnectAttempt++, backoffMs.length - 1)] : 0;
    const delay = Math.min(nextDelay, remaining);
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      if (closed || now() - reconnectStartedAt >= reconnectWindowMs) {
        endReconnect(lastCode, lastReason);
        return;
      }
      openSocket(false);
    }, delay);
  };

  const beginReconnect = (code, reason) => {
    if (closed || reconnectStartedAt !== undefined) return;
    reconnectStartedAt = now();
    reconnectAttempt = 0;
    reconnectCode = code;
    reconnectReason = reason;
    emit({ type: 'reconnecting' });
    deadlineTimer = timers.setTimeout(() => {
      if (closed || reconnectStartedAt === undefined) return;
      const socket = current;
      if (socket) {
        setSocket(undefined);
        try { socket.close(1000, 'Reconnect timeout'); } catch {}
      }
      endReconnect(reconnectCode, reconnectReason);
    }, reconnectWindowMs);
    deadlineTimer?.unref?.();
    scheduleRetry(code, reason);
  };

  const handleClose = (socket, isInitial, opened, code, reason) => {
    if (current !== socket) return;
    setSocket(undefined);
    if (isInitial && !opened) {
      settleInitial(new Error('连接被拒绝。'));
      return;
    }
    if (closed) return;
    if (canRetry(code, reason)) {
      if (reconnectStartedAt === undefined) beginReconnect(code, reason);
      else scheduleRetry(code, reason);
      return;
    }
    endReconnect(code, reason);
  };

  function openSocket(isInitial) {
    if (closed) return;
    let socket;
    let opened = false;
    try {
      socket = new WebSocket(endpoint, socketOptions);
    } catch (error) {
      if (isInitial) settleInitial(error);
      else scheduleRetry(undefined, '');
      return;
    }
    setSocket(socket);
    socket.on('message', raw => {
      if (current !== socket) return;
      let signal;
      try { signal = JSON.parse(raw.toString()); } catch { return; }
      if (signal?.type === 'welcome') role = signal.role;
      emit(signal);
      if (signal?.type === 'welcome' && reconnectStartedAt !== undefined) {
        clearRetry();
        clearDeadline();
        reconnectStartedAt = undefined;
        reconnectAttempt = 0;
        reconnectCode = reconnectReason = undefined;
      }
    });
    socket.on('error', () => {
      if (isInitial && !opened) settleInitial(new Error('连接失败。请确认对方在线、地址正确，并允许 Windows 防火墙通过。'));
    });
    socket.on('open', () => {
      if (current !== socket || closed) return;
      opened = true;
      if (isInitial) settleInitial(undefined, true);
    });
    socket.on('close', (code, rawReason) => {
      const reason = rawReason?.toString() || '';
      handleClose(socket, isInitial, opened, code, reason);
    });
  }

  return {
    connect() {
      if (connectPromise) return connectPromise;
      connectPromise = new Promise((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
        openSocket(true);
      });
      return connectPromise;
    },
    close(code = 1000, reason = 'Left') {
      if (closed) return;
      closed = true;
      clearRetry();
      clearDeadline();
      reconnectStartedAt = undefined;
      const socket = current;
      setSocket(undefined);
      if (!initialSettled) settleInitial(new Error('连接被拒绝。'));
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try { socket.close(code, reason); } catch {}
      }
    },
    send(signal) {
      if (!current || current.readyState !== WebSocket.OPEN) return false;
      current.send(JSON.stringify(signal));
      return true;
    },
    get socket() { return current; },
    get role() { return role; }
  };
}

module.exports = { createSignalingConnection, closeMessage };
