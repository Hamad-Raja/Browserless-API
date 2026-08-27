import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { apiKeyAuth } from '../auth.js';
import { browserLimiter } from '../limiter.js';
import { createSubmitResponseData, runSubmitJob } from '../automation.js';
import {
  submitRequestSchema,
  validateBody,
  assertAllowedTargetUrl,
  assertAllowedProxyHost
} from '../validation.js';
import { CapacityError } from '../errors.js';
import { createRequestLogger } from '../logger.js';

export const submitRouter = Router();

submitRouter.post('/', apiKeyAuth, validateBody(submitRequestSchema), async (req, res, next) => {
  const payload = req.validatedBody;
  const startedAt = Date.now();
  const requestId = payload.requestId ?? req.get('X-Request-ID') ?? randomUUID();
  const targetHostname = new URL(payload.targetUrl).hostname;
  const log = createRequestLogger({
    requestId,
    route: 'submit',
    target_hostname: targetHostname,
    start_timestamp: new Date(startedAt).toISOString()
  });

  try {
    assertAllowedTargetUrl(payload.targetUrl);
    assertAllowedProxyHost(payload.proxy);

    const data = await browserLimiter.run(() => runSubmitJob({
      ...payload
    }, { log, startedAt }));
    return res.json({
      data: createSubmitResponseData(data)
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
