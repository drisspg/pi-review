type ShutdownDeps = {
  stop: (signal: string) => Promise<void>;
  stopped: () => void;
  failed: (error: unknown, signal: string) => void;
  holdOpen?: (retry: () => void) => () => void;
};

/** Keep ownership alive after failed teardown; repeated signals may retry, never force release. */
export function createShutdownRequest(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let stopping = false;
  let releaseHold: (() => void) | undefined;
  let lastFailure: string | undefined;
  const holdOpen = deps.holdOpen ?? ((retry: () => void) => {
    const timer = setInterval(retry, 5_000);
    return () => clearInterval(timer);
  });
  const request = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await deps.stop(signal);
      releaseHold?.();
      releaseHold = undefined;
      deps.stopped();
    } catch (error) {
      releaseHold ??= holdOpen(() => { void request("retry"); });
      stopping = false;
      const message = error instanceof Error ? error.message : String(error);
      if (signal !== "retry" || message !== lastFailure) deps.failed(error, signal);
      lastFailure = message;
    }
  };
  return request;
}
