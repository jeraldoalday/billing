import { describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS, createShutdownHandler } from './index';

/** A close() that only completes when the test says so. */
function pendingClose() {
  let finish!: (err?: Error) => void;
  const closeServer = vi.fn((callback: (err?: Error) => void) => {
    finish = callback;
  });
  return { closeServer, finish: (err?: Error) => finish(err) };
}

describe('createShutdownHandler', () => {
  it('closes the server, disconnects, then exits cleanly', async () => {
    const { closeServer, finish } = pendingClose();
    const disconnect = vi.fn(async () => undefined);
    const exit = vi.fn();

    createShutdownHandler({ closeServer, disconnect, exit })('SIGTERM');

    expect(closeServer).toHaveBeenCalledOnce();
    // Nothing has exited yet: the in-flight requests are still finishing.
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects only after the server has closed', async () => {
    const order: string[] = [];
    const { closeServer, finish } = pendingClose();
    const disconnect = vi.fn(async () => {
      order.push('disconnect');
    });
    const exit = vi.fn(() => {
      order.push('exit');
    });

    createShutdownHandler({ closeServer, disconnect, exit })('SIGTERM');
    expect(order).toEqual([]);

    finish();
    await vi.waitFor(() => expect(order).toEqual(['disconnect', 'exit']));
  });

  it('ignores a second signal while a shutdown is already running', () => {
    const { closeServer } = pendingClose();
    const shutdown = createShutdownHandler({
      closeServer,
      disconnect: async () => undefined,
      exit: vi.fn(),
    });

    shutdown('SIGINT');
    shutdown('SIGINT');
    shutdown('SIGTERM');

    expect(closeServer).toHaveBeenCalledOnce();
  });

  it('exits non-zero when the server fails to close', async () => {
    const { closeServer, finish } = pendingClose();
    const exit = vi.fn();

    createShutdownHandler({ closeServer, disconnect: async () => undefined, exit })('SIGTERM');
    finish(new Error('not running'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  // Losing the database connection on the way out is not a reason to hang;
  // the requests are already done.
  it('still exits when disconnecting throws', async () => {
    const { closeServer, finish } = pendingClose();
    const exit = vi.fn();

    createShutdownHandler({
      closeServer,
      disconnect: async () => {
        throw new Error('connection already gone');
      },
      exit,
    })('SIGTERM');
    finish();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('gives up on a request that never finishes', () => {
    vi.useFakeTimers();
    const { closeServer } = pendingClose();
    const exit = vi.fn();

    createShutdownHandler({
      closeServer,
      disconnect: async () => undefined,
      exit,
      graceMs: 1_000,
    })('SIGTERM');

    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(exit).toHaveBeenCalledWith(1);

    vi.useRealTimers();
  });

  it('does not force an exit once the shutdown has completed', async () => {
    vi.useFakeTimers();
    const { closeServer, finish } = pendingClose();
    const exit = vi.fn();

    createShutdownHandler({
      closeServer,
      disconnect: async () => undefined,
      exit,
      graceMs: 1_000,
    })('SIGTERM');
    finish();
    await vi.runAllTimersAsync();

    // Exactly one exit, the clean one — the timeout was cleared.
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    vi.useRealTimers();
  });

  it('defaults to a grace period inside a typical orchestrator timeout', () => {
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(30_000);
  });
});
