const DEFAULT_GRACE_MS = 5000;

export function isChildProcessRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export function terminateChildProcess(child, options = {}) {
  const graceMs = Number(options.graceMs) >= 0 ? Number(options.graceMs) : DEFAULT_GRACE_MS;
  if (!isChildProcessRunning(child)) return Promise.resolve(false);

  return new Promise(resolve => {
    let settled = false;
    let killTimer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      child.removeListener?.('exit', onExit);
      child.removeListener?.('close', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);

    const sendSignal = signal => {
      if (options.processGroup && process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return true; } catch (_) {}
      }
      try { return child.kill(signal); } catch (_) { return false; }
    };

    if (!sendSignal('SIGTERM')) return finish(false);

    killTimer = setTimeout(() => {
      if (isChildProcessRunning(child)) {
        sendSignal('SIGKILL');
      }
      // close normally follows SIGKILL; this fallback prevents a broken mock or
      // platform-specific child handle from blocking queue shutdown forever.
      setTimeout(() => finish(!isChildProcessRunning(child)), 100).unref?.();
    }, graceMs);
    killTimer.unref?.();
  });
}

export function bindAbortSignal(child, signal, options = {}) {
  if (!signal) return () => {};
  const onAbort = () => { void terminateChildProcess(child, options); };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function abortError(signal, fallback = 'TASK_ABORTED') {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : fallback);
  error.name = 'AbortError';
  return error;
}
