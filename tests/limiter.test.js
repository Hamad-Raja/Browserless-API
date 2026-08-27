import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createBrowserLimiter } from '../src/limiter.js';
import { CapacityError } from '../src/errors.js';

test('concurrency limiter caps active jobs and rejects excess queued jobs', async () => {
  const limiter = createBrowserLimiter({
    maxConcurrentBrowsers: 1,
    maxQueuedRequests: 1
  });

  let releaseFirst;
  const first = limiter.run(
    () =>
      new Promise((resolve) => {
        releaseFirst = resolve;
      })
  );

  const second = limiter.run(() => Promise.resolve('second'));

  await setImmediate();

  assert.equal(limiter.getState().activeBrowsers, 1);
  assert.equal(limiter.getState().queuedRequests, 1);
  assert.throws(() => limiter.run(() => Promise.resolve('third')), CapacityError);

  releaseFirst('first');

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(limiter.getState().activeBrowsers, 0);
  assert.equal(limiter.getState().queuedRequests, 0);
});
