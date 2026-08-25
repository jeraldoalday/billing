import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

/**
 * The HTTP entry point.
 *
 * The worker (src/worker.ts) has always shut down cleanly on a signal; this
 * process did not, so a deploy or a container stop killed whatever requests
 * were mid-flight and left the database connection to be reaped. Both now
 * behave the same way: stop accepting connections, let the requests already
 * in progress finish, disconnect Prisma, exit.
 */

// How long in-flight requests get to finish before the process stops
// waiting. An orchestrator's own grace period is usually 30s, so this is
// comfortably inside it — a hung request must not turn a rolling deploy
// into a SIGKILL.
export const SHUTDOWN_GRACE_MS = 10_000;

export interface ShutdownDeps {
  closeServer: (callback: (err?: Error) => void) => void;
  disconnect: () => Promise<unknown>;
  exit: (code: number) => void;
  graceMs?: number;
}

/**
 * Builds the signal handler. Everything it touches is injected so the
 * sequence can be tested without listening on a port or ending the test
 * runner's own process.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS;
  let shuttingDown = false;

  return function shutdown(signal: string) {
    // A second Ctrl-C, or a SIGTERM arriving right behind a SIGINT, must
    // not start a second shutdown on top of the first.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'Server shutting down');

    // A request that never finishes would otherwise keep the process alive
    // forever. Unref'd so that this timer is not itself a reason to stay up.
    const forceExit = setTimeout(() => {
      logger.warn({ graceMs }, 'Shutdown timed out, exiting anyway');
      deps.exit(1);
    }, graceMs);
    forceExit.unref?.();

    deps.closeServer((err) => {
      if (err) {
        logger.error({ err }, 'Error while closing the HTTP server');
      }

      void deps
        .disconnect()
        .catch((disconnectError: unknown) => {
          logger.error({ err: disconnectError }, 'Error while disconnecting from the database');
        })
        .finally(() => {
          clearTimeout(forceExit);
          deps.exit(err ? 1 : 0);
        });
    });
  };
}

export function startServer(port: number = env.PORT): Server {
  const app = createApp();

  const server = app.listen(port, () => {
    logger.info(`Server listening on port ${port} (${env.NODE_ENV})`);
  });

  const shutdown = createShutdownHandler({
    closeServer: (callback) => server.close(callback),
    disconnect: () => prisma.$disconnect(),
    exit: (code) => process.exit(code),
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  startServer();
}
