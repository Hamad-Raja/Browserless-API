import { Router } from 'express';
import { config } from '../config.js';
import { browserLimiter } from '../limiter.js';

export const healthRouter = Router();

export function buildHealthResponse({
  limiterState = browserLimiter.getState(),
  now = new Date(),
  uptimeSeconds = Math.floor(process.uptime()),
  memoryUsage = process.memoryUsage()
} = {}) {
  const remainingQueueSlots = Math.max(0, limiterState.maxQueuedRequests - limiterState.queuedRequests);
  const browserCapacityAvailable =
    limiterState.activeBrowsers < limiterState.maxConcurrentBrowsers || remainingQueueSlots > 0;

  return {
    success: true,
    service: 'browser-api',
    status: 'healthy',
    timestamp: now.toISOString(),
    nodeEnv: config.nodeEnv,
    nodeVersion: process.version,
    uptimeSeconds,
    activeBrowsers: limiterState.activeBrowsers,
    queuedRequests: limiterState.queuedRequests,
    maxConcurrentBrowsers: limiterState.maxConcurrentBrowsers,
    maxQueuedRequests: limiterState.maxQueuedRequests,
    checks: {
      api: 'ok',
      browserCapacity: browserCapacityAvailable ? 'available' : 'full'
    },
    capacity: {
      browserCapacityAvailable,
      activeBrowsers: limiterState.activeBrowsers,
      queuedRequests: limiterState.queuedRequests,
      maxConcurrentBrowsers: limiterState.maxConcurrentBrowsers,
      maxQueuedRequests: limiterState.maxQueuedRequests,
      remainingQueueSlots
    },
    memory: {
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal
    }
  };
}

healthRouter.get('/', (req, res) => {
  res.json(buildHealthResponse());
});
