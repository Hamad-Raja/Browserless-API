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
import {
  IDEMPOTENCY_STATUSES,
  createIdempotencyResponse,
  getIdempotencyStore
} from '../idempotency.js';

export const submitRouter = Router();

function classifyIdempotencyStatus(data = {}, browserStarted = false) {
  if (data.success) {
    return IDEMPOTENCY_STATUSES.SUCCESS;
  }

  if (!browserStarted) {
    return IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER;
  }

  if ([
    'browserless_timeout_hung',
    'timeout',
    'infrastructure'
  ].includes(data.failure_category)) {
    return IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME;
  }

  return IDEMPOTENCY_STATUSES.FAILED_POST_BROWSER;
}

function duplicateResponseFor(record, log) {
  if (record.status === IDEMPOTENCY_STATUSES.PROCESSING) {
    log.info?.({
      attemptId: record.attemptId,
      agentLeadId: record.agentLeadId,
      idempotency_status: record.status
    }, '[IDEMPOTENCY] duplicate processing blocked');
  } else if (record.status === IDEMPOTENCY_STATUSES.SUCCESS) {
    log.info?.({
      attemptId: record.attemptId,
      agentLeadId: record.agentLeadId,
      idempotency_status: record.status
    }, '[IDEMPOTENCY] stored success replayed');
  }

  return createIdempotencyResponse(record, {
    duplicate: true,
    replayed: record.status === IDEMPOTENCY_STATUSES.SUCCESS
  });
}

function scheduleIdempotencyCleanup(store) {
  setImmediate(() => {
    try {
      store.cleanup();
    } catch (error) {
      // Cleanup must never affect request handling.
    }
  });
}

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

  const hasIdempotency = Boolean(payload.attemptId);
  const idempotencyStore = hasIdempotency ? getIdempotencyStore(log) : null;
  let browserStarted = false;
  let attemptReserved = false;

  try {
    if (hasIdempotency) {
      const reservation = idempotencyStore.reserveAttempt({
        attemptId: payload.attemptId,
        agentLeadId: payload.agentLeadId ?? null
      });

      if (!reservation.reserved) {
        return res.status(200).json(duplicateResponseFor(reservation.record, log));
      }

      attemptReserved = true;
    }

    assertAllowedTargetUrl(payload.targetUrl);
    assertAllowedProxyHost(payload.proxy);

    const data = await browserLimiter.run(() => runSubmitJob({
      ...payload
    }, {
      log,
      startedAt,
      onBrowserLaunchStart() {
        browserStarted = true;
        if (hasIdempotency) {
          idempotencyStore.markBrowserStarted(payload.attemptId);
        }
      }
    }));
    const responseBody = {
      data: createSubmitResponseData(data)
    };

    if (hasIdempotency) {
      const status = classifyIdempotencyStatus(data, browserStarted);
      idempotencyStore.completeAttempt({
        attemptId: payload.attemptId,
        status,
        browserStarted,
        responseCode: 200,
        result: responseBody,
        errorMessage: data.error ?? data.failure_category ?? null
      });
      scheduleIdempotencyCleanup(idempotencyStore);
    }

    return res.json(responseBody);
  } catch (error) {
    if (error instanceof CapacityError) {
      const responseBody = {
        success: false,
        error: 'browser_capacity_reached'
      };

      if (hasIdempotency && attemptReserved) {
        idempotencyStore.completeAttempt({
          attemptId: payload.attemptId,
          status: browserStarted
            ? IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME
            : IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER,
          browserStarted,
          responseCode: 429,
          result: responseBody,
          errorMessage: 'browser_capacity_reached'
        });
        scheduleIdempotencyCleanup(idempotencyStore);
      }

      return res.status(429).json(responseBody);
    }

    if (hasIdempotency && attemptReserved) {
      const responseBody = {
        success: false,
        error: error.code ?? 'internal_error'
      };
      idempotencyStore.completeAttempt({
        attemptId: payload.attemptId,
        status: browserStarted
          ? IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME
          : IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER,
        browserStarted,
        responseCode: error.statusCode ?? 500,
        result: responseBody,
        errorMessage: error.code ?? error.message ?? 'internal_error'
      });
      scheduleIdempotencyCleanup(idempotencyStore);
    }

    return next(error);
  }
});
