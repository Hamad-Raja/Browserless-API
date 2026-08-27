import dotenv from 'dotenv';

dotenv.config();

function parseIntegerEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

export function parseHostList(value) {
  return String(value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: parseIntegerEnv('PORT', 3000, { min: 1, max: 65535 }),
  apiKey: process.env.API_KEY ?? 'CHANGE_ME',
  maxConcurrentBrowsers: parseIntegerEnv('MAX_CONCURRENT_BROWSERS', 4, { min: 1, max: 32 }),
  maxQueuedRequests: parseIntegerEnv('MAX_QUEUED_REQUESTS', 20, { min: 0, max: 1000 }),
  browserTimeoutMs: parseIntegerEnv('BROWSER_TIMEOUT_MS', 120000, { min: 1000 }),
  ipCheckTimeoutMs: parseIntegerEnv('IP_CHECK_TIMEOUT_MS', 10000, { min: 1000 }),
  targetNavigationTimeoutMs: parseIntegerEnv('TARGET_NAVIGATION_TIMEOUT_MS', 90000, { min: 1000 }),
  formSelectorTimeoutMs: parseIntegerEnv('FORM_SELECTOR_TIMEOUT_MS', 30000, { min: 1000 }),
  successDetectionTimeoutMs: parseIntegerEnv('SUCCESS_DETECTION_TIMEOUT_MS', 45000, { min: 1000 }),
  trustedFormMinimumMs: parseIntegerEnv('TRUSTEDFORM_MINIMUM_MS', 35000, { min: 0 }),
  trustedFormPollIntervalMs: parseIntegerEnv('TRUSTEDFORM_POLL_INTERVAL_MS', 2000, { min: 250 }),
  trustedFormPollMaxMs: parseIntegerEnv('TRUSTEDFORM_POLL_MAX_MS', 60000, { min: 1000 }),
  responseBodyByteLimit: parseIntegerEnv('RESPONSE_BODY_BYTE_LIMIT', 300, { min: 100 }),
  pageTextSnippetLimit: parseIntegerEnv('PAGE_TEXT_SNIPPET_LIMIT', 500, { min: 100 }),
  consoleErrorLimit: parseIntegerEnv('CONSOLE_ERROR_LIMIT', 5, { min: 1, max: 200 }),
  consoleErrorMaxLength: parseIntegerEnv('CONSOLE_ERROR_MAX_LENGTH', 200, { min: 50, max: 5000 }),
  allowedTargetHosts: parseHostList(process.env.ALLOWED_TARGET_HOSTS ?? 'example.com'),
  allowedProxyHosts: parseHostList(process.env.ALLOWED_PROXY_HOSTS ?? 'geo.iproyal.com'),
  defaultFormSelector: process.env.DEFAULT_FORM_SELECTOR ?? '#quoteForm',
  logLevel: process.env.LOG_LEVEL ?? 'info'
});
