import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserJobError, HardTimeoutError, classifyBrowserError, sanitizeErrorMessage } from '../src/errors.js';
import { REDACT_PATHS } from '../src/logger.js';

test('error classifier maps proxy failures', () => {
  assert.equal(classifyBrowserError(new Error('net::ERR_PROXY_CONNECTION_FAILED')), 'proxy_forbidden');
  assert.equal(classifyBrowserError(new Error('407 Proxy Authentication Required')), 'proxy_forbidden');
});

test('error classifier maps timeout failures', () => {
  assert.equal(classifyBrowserError(new HardTimeoutError(120000)), 'browserless_timeout_hung');
  assert.equal(classifyBrowserError(new Error('navigation timeout of 90000 ms exceeded')), 'timeout');
});

test('error classifier preserves explicit browser job category', () => {
  assert.equal(classifyBrowserError(new BrowserJobError('Missing TrustedForm', 'trustedform_missing')), 'trustedform_missing');
});

test('sanitizeErrorMessage removes credential-like content', () => {
  const sanitized = sanitizeErrorMessage(new Error('https://user:secret@example.com/path?password=hunter2&api_key=abc'));

  assert.equal(sanitized.includes('secret'), false);
  assert.equal(sanitized.includes('hunter2'), false);
  assert.equal(sanitized.includes('abc'), false);
});

test('logger redaction covers API keys, proxy secrets, lead PII, and token aliases', () => {
  for (const path of [
    'req.headers["x-api-key"]',
    'headers["x-api-key"]',
    'req.headers.authorization',
    'apiKey',
    'api_key',
    'proxy.username',
    'proxy.password',
    'lead',
    'trustedform_token',
    'jornayaToken',
    'jornaya_token'
  ]) {
    assert.equal(REDACT_PATHS.includes(path), true, `${path} should be redacted`);
  }
});
