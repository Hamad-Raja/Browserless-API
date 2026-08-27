import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { apiKeyAuth } from '../auth.js';
import { browserLimiter } from '../limiter.js';
import { runTestJob } from '../automation.js';
import { testRequestSchema, validateBody, assertAllowedTargetUrl, assertAllowedProxyHost } from '../validation.js';
import { CapacityError } from '../errors.js';
import { createRequestLogger } from '../logger.js';

export const testRouter = Router();

testRouter.post('/', apiKeyAuth, validateBody(testRequestSchema), async (req, res, next) => {
  const payload = req.validatedBody;
  const startedAt = Date.now();
  const requestId = req.get('X-Request-ID') ?? randomUUID();
  const log = createRequestLogger({ requestId, route: 'test' });

  try {
    assertAllowedTargetUrl(payload.targetUrl);
    assertAllowedProxyHost(payload.proxy);

    const data = await browserLimiter.run(() => runTestJob(payload, { log, startedAt }));
    return res.json({
      data,
      meta: {
        duration_ms: Date.now() - startedAt
      }
    });
  } catch (error) {
    if (error instanceof CapacityError) {
      return res.status(429).json({
        success: false,
        error: 'browser_capacity_reached'
      });
    }

    return next(error);
  }
});
