import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { buildHealthResponse } from '../src/routes/health.js';
import { createApp } from '../src/server.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test('GET /health is public and does not launch a browser', async (t) => {
  const { server, baseUrl } = await listen(createApp());
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.service, 'browser-api');
  assert.equal(body.status, 'healthy');
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.nodeEnv, config.nodeEnv);
  assert.equal(typeof body.nodeVersion, 'string');
  assert.equal(body.activeBrowsers, 0);
  assert.equal(body.checks.api, 'ok');
  assert.equal(body.checks.browserCapacity, 'available');
  assert.equal(body.capacity.browserCapacityAvailable, true);
  assert.equal(typeof body.memory.rssBytes, 'number');
});

test('health response reports full browser capacity without exposing secrets', () => {
  const body = buildHealthResponse({
    limiterState: {
      activeBrowsers: 2,
      queuedRequests: 3,
      maxConcurrentBrowsers: 2,
      maxQueuedRequests: 3
    },
    now: new Date('2026-08-28T00:00:00.000Z'),
    uptimeSeconds: 42,
    memoryUsage: {
      rss: 100,
      heapUsed: 50,
      heapTotal: 75
    }
  });

  assert.equal(body.timestamp, '2026-08-28T00:00:00.000Z');
  assert.equal(body.uptimeSeconds, 42);
  assert.equal(body.checks.browserCapacity, 'full');
  assert.equal(body.capacity.browserCapacityAvailable, false);
  assert.equal(body.capacity.remainingQueueSlots, 0);
  assert.equal(JSON.stringify(body).includes('API_KEY'), false);
  assert.equal(JSON.stringify(body).includes('password'), false);
});

test('POST /test rejects missing API key before validation or browser work', async (t) => {
  const { server, baseUrl } = await listen(createApp());
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/test`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({})
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    success: false,
    error: 'unauthorized'
  });
});

test('POST /submit rejects executable-code style payloads', async (t) => {
  const { server, baseUrl } = await listen(createApp());
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey
    },
    body: JSON.stringify({
      code: 'await page.goto("https://example.com")'
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error, 'invalid_request');
});

test('POST /submit rejects omitted proxy before browser work', async (t) => {
  const allowedHost = (config.allowedTargetHosts[0] || 'example.com').replace(/^\*\./, '');

  const { server, baseUrl } = await listen(createApp());
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey
    },
    body: JSON.stringify({
      requestId: 'payload-proxy-required-test',
      targetUrl: `https://${allowedHost}/form`,
      lead: {
        firstName: 'John',
        lastName: 'Doe',
        phone: '5551234567',
        zip: '44149',
        state: 'Ohio',
        beneficiary: 'son',
        age: '65',
        coverage: '15000'
      }
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error, 'invalid_request');
});
