import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { toApiErrorResponse } from './errors.js';
import { closeActiveBrowsers } from './browser.js';
import { healthRouter } from './routes/health.js';
import { testRouter } from './routes/test.js';
import { submitRouter } from './routes/submit.js';

const shutdownHandlerTargets = new WeakSet();

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: 'rate_limited'
      }
    })
  );

  app.use('/health', healthRouter);
  app.use('/test', testRouter);
  app.use('/submit', submitRouter);

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: 'not_found'
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    const { statusCode, body } = toApiErrorResponse(error);

    if (statusCode >= 500) {
      logger.error({ err: error }, 'Unhandled API error');
    }

    return res.status(statusCode).json(body);
  });

  return app;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close((error) => {
      resolve(error);
    });
  });
}

export function installShutdownHandlers(server, { processRef = process } = {}) {
  if (shutdownHandlerTargets.has(processRef)) {
    return false;
  }

  shutdownHandlerTargets.add(processRef);
  let shuttingDown = false;

  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ reason }, 'Browser API shutting down');

    const forceExitTimer = setTimeout(() => {
      logger.error({ reason }, 'Forced shutdown after cleanup timeout');
      processRef.exit(exitCode || 1);
    }, 15000);
    forceExitTimer.unref?.();

    const serverCloseError = await closeServer(server);
    if (serverCloseError) {
      logger.warn({ err: serverCloseError }, 'HTTP server close returned an error');
    }

    const closedBrowsers = await closeActiveBrowsers(logger, { timeoutMs: 5000 });
    logger.info({ reason, closedBrowsers }, 'Browser API shutdown cleanup complete');
    clearTimeout(forceExitTimer);
    processRef.exit(exitCode);
  }

  processRef.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  processRef.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  processRef.once('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  processRef.once('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  return true;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile && currentFile === invokedFile) {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info({
      service: 'browser-api',
      host: config.host,
      port: config.port,
      maxConcurrentBrowsers: config.maxConcurrentBrowsers,
      maxQueuedRequests: config.maxQueuedRequests
    }, 'Browser API listening');
  });
  installShutdownHandlers(server);
}
