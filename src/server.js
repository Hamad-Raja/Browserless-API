import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { toApiErrorResponse } from './errors.js';
import { healthRouter } from './routes/health.js';
import { testRouter } from './routes/test.js';
import { submitRouter } from './routes/submit.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
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

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile && currentFile === invokedFile) {
  const app = createApp();
  app.listen(config.port, config.host, () => {
    logger.info({
      service: 'browser-api',
      host: config.host,
      port: config.port,
      maxConcurrentBrowsers: config.maxConcurrentBrowsers,
      maxQueuedRequests: config.maxQueuedRequests
    }, 'Browser API listening');
  });
}
