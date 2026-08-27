import pLimit from 'p-limit';
import { config } from './config.js';
import { CapacityError } from './errors.js';

export function createBrowserLimiter({
  maxConcurrentBrowsers = config.maxConcurrentBrowsers,
  maxQueuedRequests = config.maxQueuedRequests
} = {}) {
  const limit = pLimit(maxConcurrentBrowsers);

  return {
    run(task) {
      const totalScheduled = limit.activeCount + limit.pendingCount;
      const totalCapacity = maxConcurrentBrowsers + maxQueuedRequests;

      if (totalScheduled >= totalCapacity) {
        throw new CapacityError();
      }

      return limit(task);
    },

    getState() {
      return {
        activeBrowsers: limit.activeCount,
        queuedRequests: limit.pendingCount,
        maxConcurrentBrowsers,
        maxQueuedRequests
      };
    }
  };
}

export const browserLimiter = createBrowserLimiter();
