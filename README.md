# Browser API

Self-hosted Node.js API for one-shot Puppeteer browser automation. It launches a fresh Chrome/Chromium process per request, authenticates an IPRoyal-style proxy, verifies the proxy exit IP, opens a runtime-supplied target URL, fills a form from data, waits for TrustedForm, reads Jornaya when present, handles TCPA, submits the form, detects success or failure, returns Browserless-compatible JSON, and always closes the browser.

This project is only the browser API. It does not implement Base44, queues, retries, TrackDrive, Google Apps Script posting, provider switching, Nginx, PM2, Docker, DNS, SSL, or VPS deployment.

## Architecture

```text
External app
  -> POST /submit
  -> Express API
  -> Puppeteer
  -> fresh Chrome / Chromium
  -> request proxy
  -> target website
  -> JSON result
```

The API receives data only. It does not accept executable JavaScript, and it does not use `eval`, `new Function`, or `vm`.

## Requirements

- Node.js 20 or newer
- Chrome/Chromium available through the `puppeteer` package or `PUPPETEER_EXECUTABLE_PATH`
- Valid target host allowlist
- Valid proxy credentials in each `/submit` request

## Install

```bash
npm install
```

## Environment

Copy `.env.example` to `.env` and set production values:

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
API_KEY=CHANGE_ME
MAX_CONCURRENT_BROWSERS=4
MAX_QUEUED_REQUESTS=20
BROWSER_TIMEOUT_MS=120000
IP_CHECK_TIMEOUT_MS=10000
TARGET_NAVIGATION_TIMEOUT_MS=90000
FORM_SELECTOR_TIMEOUT_MS=30000
SUCCESS_DETECTION_TIMEOUT_MS=45000
TRUSTEDFORM_MINIMUM_MS=35000
TRUSTEDFORM_POLL_INTERVAL_MS=2000
TRUSTEDFORM_POLL_MAX_MS=60000
ALLOWED_TARGET_HOSTS=example.com
ALLOWED_PROXY_HOSTS=geo.iproyal.com
LOG_LEVEL=info
```

`ALLOWED_TARGET_HOSTS` is required for SSRF protection. Only HTTPS URLs whose host matches the configured list are accepted. Localhost, private IPs, `file://`, `ftp://`, and non-HTTPS targets are rejected.

`ALLOWED_PROXY_HOSTS` defaults to `geo.iproyal.com`; arbitrary proxy hosts are rejected.

`POST /submit` and `POST /test` require an explicit proxy object in the request payload.

## Start

```bash
npm start
```

The default local URL is:

```text
http://127.0.0.1:3000
```

## GET /health

Public status endpoint. It does not launch Chrome.

```bash
curl http://127.0.0.1:3000/health
```

Example response:

```json
{
  "success": true,
  "service": "browser-api",
  "status": "healthy",
  "activeBrowsers": 0,
  "queuedRequests": 0,
  "maxConcurrentBrowsers": 4,
  "uptimeSeconds": 10
}
```

## POST /test

Protected by `X-API-Key`. Launches a fresh browser, authenticates the proxy, checks `api.ipify.org`, opens the target URL, waits for the form, verifies selectors, and closes the browser. It does not fill, click TCPA, or submit.

```bash
curl -X POST http://127.0.0.1:3000/test \
  -H "Content-Type: application/json" \
  -H "X-API-Key: CHANGE_ME" \
  -d '{
    "targetUrl": "https://example.com/form",
    "selectors": {
      "first_name": "#firstName",
      "last_name": "#lastName",
      "phone": "#phone",
      "zip": "#zip-code",
      "state": "#state",
      "beneficiary": "#beneficiary",
      "age": "#age",
      "gender": "#gender",
      "coverage": "#coverage"
    },
    "proxy": {
      "host": "geo.iproyal.com",
      "port": 12321,
      "username": "USERNAME",
      "password": "PASSWORD"
    }
  }'
```

## POST /submit

Protected by `X-API-Key`. Performs one browser execution for one lead. There are no internal business retries.

```bash
curl -X POST http://127.0.0.1:3000/submit \
  -H "Content-Type: application/json" \
  -H "X-API-Key: CHANGE_ME" \
  -d '{
    "requestId": "optional-id",
    "targetUrl": "https://example.com/form",
    "automationProfile": "primary",
    "lead": {
      "firstName": "John",
      "lastName": "Doe",
      "phone": "5551234567",
      "zip": "33101",
      "state": "Florida",
      "beneficiary": "Spouse",
      "age": "65",
      "gender": "male",
      "coverage": "10000"
    },
    "selectors": {
      "first_name": "#firstName",
      "last_name": "#lastName",
      "phone": "#phone",
      "zip": "#zip-code",
      "state": "#state",
      "beneficiary": "#beneficiary",
      "age": "#age",
      "gender": "#gender",
      "coverage": "#coverage"
    },
    "proxy": {
      "host": "geo.iproyal.com",
      "port": 12321,
      "username": "USERNAME",
      "password": "PASSWORD_country-us_state-florida_session-a1b2c3d4",
      "stateCode": "FL",
      "stateName": "Florida"
    },
    "timeoutMs": 120000
  }'
```

`automationProfile` is optional and defaults to `primary`. `primary` matches `processPendingAgentLeads -> PUPPETEER_CODE`. `retry` runs the smaller `retryFailed -> CODE` browser profile once; it does not retry internally and it ignores caller field mappings, matching the active Base44 retry automation.

The `/submit` `proxy` object must be supplied in the request. `stateCode` and `stateName` are accepted for Base44 compatibility but are not used or modified by this API. Proxy passwords are passed through unchanged.

## Response Contract

`/submit` returns HTTP 200 when the browser job ran, even if the form failed. API/service errors use HTTP 400, 401, 429, 500, or 503.

```json
{
  "data": {
    "success": true,
    "failure_category": null,
    "trustedform_token": "https://cert.trustedform.com/example",
    "trustedform_present": true,
    "trustedform_ping_url": "...",
    "jornayaToken": "...",
    "validation_errors": 0,
    "apps_script_post_fired": false,
    "apps_script_post_status": null,
    "console_errors": [],
    "ipAddress": "104.28.x.x",
    "screenshotBase64": null
  }
}
```

`data` is kept to the Base44 Browserless-compatible fields that Base44 consumes.

## Browser Behavior

Every `/submit` launches a fresh browser, fresh page, and fresh profile. Cookies, localStorage, sessionStorage, pages, and contexts are never reused between leads.

The proxy is configured at browser launch with `--proxy-server=http://host:port`, then authenticated with `page.authenticate`. The same page and proxy are used for the `api.ipify.org` IP check and the target site.

TrustedForm and Jornaya are not installed or injected by this API. The target page must load them. The API waits for an existing TrustedForm certificate URL beginning with `https://cert.trustedform.com/`; missing TrustedForm prevents submission. Jornaya is captured when present but does not fail the job when absent.

## Concurrency And Timeout

`MAX_CONCURRENT_BROWSERS` limits active Chrome jobs. `MAX_QUEUED_REQUESTS` limits pending in-memory requests. When capacity is exceeded, the API returns HTTP 429 with `browser_capacity_reached`.

`BROWSER_TIMEOUT_MS` is a hard watchdog around the whole browser workflow. On timeout, work is aborted, the browser is closed, and the result is classified as `timeout`.

## Logging

Pino structured logs include safe operational fields such as request ID, target hostname, proxy hostname, duration, IP address, TrustedForm presence, Jornaya presence, success, failure category, and browser cleanup status.

Logs do not include API keys, proxy passwords, full lead names, full phone numbers, full TrustedForm tokens, full Jornaya tokens, or full request bodies.

## Error Categories

Supported browser failure categories:

- `infrastructure`
- `trustedform_missing`
- `form_submission`
- `success_not_detected`
- `proxy_forbidden`
- `target_site_forbidden`
- `timeout`

## Tests

```bash
npm test
npm run check
```

Unit tests cover authentication, validation, target URL allowlisting, proxy allowlisting, error mapping, response contract, concurrency limiting, and the timeout helper. They do not submit real production leads.

Live browser testing requires real `ALLOWED_TARGET_HOSTS`, target selectors, and proxy credentials. Keep those tests separate from unit tests and disabled by default.
