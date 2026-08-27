import { setTimeout as sleep } from 'node:timers/promises';
import { launchBrowser, safeCloseBrowser } from './browser.js';
import { authenticateProxy, checkExitIp } from './proxy.js';
import { config } from './config.js';
import {
  HardTimeoutError,
  TargetSiteForbiddenError,
  classifyBrowserError,
  sanitizeErrorMessage
} from './errors.js';
import {
  DEFAULT_FIELD_SELECTORS,
  FIELD_NAMES,
  PRODUCTION_SELECTOR_KEYS,
  mergeSelectors
} from './validation.js';

const SUCCESS_PHRASES = Object.freeze([
  'submission successful',
  'thank you',
  'success',
  'submitted',
  'request received',
  'quote submitted',
  'application received',
  'we received your',
  'your request has been',
  'submission complete',
  'thank you for your interest',
  'we will be in touch',
  'all set'
]);

const FAILURE_PHRASES = Object.freeze([
  'error',
  'fail',
  'invalid'
]);

const VALIDATION_ERROR_SELECTORS = Object.freeze([
  '.validation-error',
  '[class*="validation-error" i]'
]);

export const PRIMARY_HIDDEN_IP_SELECTORS = Object.freeze([
  'input[name="ip"]',
  'input[name="ip_address"]',
  'input[name="proxy_ip"]',
  'input[name="reported_ip"]',
  'input[name="user_ip"]',
  'input[name="client_ip"]'
]);

export const RETRY_HIDDEN_IP_SELECTORS = Object.freeze([
  'input[name="ip"]',
  'input[name="ip_address"]',
  'input[name="proxy_ip"]'
]);

export const PRIMARY_TRUSTEDFORM_SELECTORS = Object.freeze([
  '#TrustedFormCertUrl',
  'input[name="TrustedFormCertUrl"]',
  'input[name="xxTrustedFormCertUrl"]',
  '#xxTrustedFormCertUrl',
  'input[id*="CertUrl" i]',
  'input[name*="CertUrl" i]'
]);

export const RETRY_TRUSTEDFORM_SELECTORS = Object.freeze([
  '#TrustedFormCertUrl',
  'input[name="TrustedFormCertUrl"]',
  'input[name="xxTrustedFormCertUrl"]',
  '#xxTrustedFormCertUrl'
]);

const TRUSTEDFORM_PING_SELECTORS = Object.freeze([
  '#xxTrustedFormPingUrl',
  'input[name="xxTrustedFormPingUrl"]'
]);

export const PRIMARY_JORNAYA_SELECTORS = Object.freeze([
  '#leadid_token',
  'input[name="leadid_token"]',
  'input[id*="leadid" i]',
  'input[name*="leadid" i]'
]);

export const RETRY_JORNAYA_SELECTORS = Object.freeze([
  '#leadid_token',
  'input[name="leadid_token"]'
]);

export const RETRY_FIELD_SELECTORS = Object.freeze({ ...DEFAULT_FIELD_SELECTORS });

export const PRODUCTION_TEST_SELECTOR_ENTRIES = Object.freeze(
  FIELD_NAMES.map((fieldName) => Object.freeze({
    fieldName,
    key: PRODUCTION_SELECTOR_KEYS[fieldName],
    fallback: DEFAULT_FIELD_SELECTORS[fieldName]
  }))
);

const SUBMIT_BUTTON_SELECTOR =
  '#quoteForm button[type="submit"], #quoteForm input[type="submit"], button.submit-btn, #quoteForm .submit-btn';

const PRODUCTION_FORM_SELECTOR = '#quoteForm';
const PRIMARY_SUCCESS_DETECTION_TIMEOUT_MS = 45000;
const PRODUCTION_PAGE_TEXT_SNIPPET_LIMIT = 500;
const PRODUCTION_SUBMISSION_BODY_LIMIT = 300;
const PRODUCTION_CONSOLE_ERROR_LIMIT = 5;
const PRODUCTION_CONSOLE_ERROR_LENGTH = 200;
const SUCCESS_NOT_DETECTED_BODY_TEXT_LIMIT = 2000;
const DEBUG_POST_CAPTURE_LIMIT = 20;

const DEFAULT_RESPONSE_DATA = Object.freeze({
  success: false,
  failure_category: null,
  error: null,
  ipAddress: null,
  trustedform_token: null,
  trustedform_present: false,
  trustedform_ping_url: null,
  jornayaToken: null,
  validation_errors: 0,
  screenshotBase64: null,
  fieldValues: {},
  finalUrl: null,
  urlBeforeSubmit: null,
  submissionResponseStatus: null,
  submissionResponseBody: null,
  apps_script_post_fired: false,
  apps_script_post_status: null,
  console_errors: [],
  pageTextSnippet: '',
  successReason: null
});

const RETRY_RESPONSE_DATA = Object.freeze({
  success: false,
  failure_category: null,
  trustedform_token: null,
  trustedform_present: false,
  ipAddress: 'unknown',
  screenshotBase64: null,
  pageTextSnippet: ''
});

function truncateSubmissionResponseBody(submissionResponseBody) {
  if (!submissionResponseBody) {
    return null;
  }

  return String(submissionResponseBody).slice(0, PRODUCTION_SUBMISSION_BODY_LIMIT);
}

export function createBrowserlessCompatibleData(overrides = {}) {
  const data = {
    ...DEFAULT_RESPONSE_DATA,
    ...overrides,
    fieldValues: overrides.fieldValues ?? {},
    console_errors: overrides.console_errors ?? []
  };

  return {
    ...data,
    submissionResponseBody: truncateSubmissionResponseBody(data.submissionResponseBody)
  };
}

export function createRetryBrowserData(overrides = {}) {
  return {
    ...RETRY_RESPONSE_DATA,
    ...overrides
  };
}

export function createSubmitResponseData(data = {}) {
  return {
    success: data.success ?? false,
    failure_category: data.failure_category ?? null,
    successReason: data.successReason ?? null,
    trustedform_token: data.trustedform_token ?? null,
    trustedform_present: data.trustedform_present ?? false,
    trustedform_ping_url: data.trustedform_ping_url ?? '',
    jornayaToken: data.jornayaToken ?? '',
    jornaya_token: data.jornayaToken ?? '',
    validation_errors: data.validation_errors ?? 0,
    apps_script_post_fired: data.apps_script_post_fired ?? false,
    apps_script_post_status: data.apps_script_post_status ?? null,
    console_errors: Array.isArray(data.console_errors) ? data.console_errors : [],
    finalUrl: data.finalUrl ?? null,
    urlBeforeSubmit: data.urlBeforeSubmit ?? null,
    submissionResponseStatus: data.submissionResponseStatus ?? null,
    submissionResponseBody: truncateSubmissionResponseBody(data.submissionResponseBody),
    pageTextSnippet: data.pageTextSnippet ?? '',
    ipAddress: data.ipAddress ?? 'unknown',
    reported_ip: data.ipAddress ?? 'unknown',
    screenshotBase64: data.screenshotBase64 ?? null
  };
}

export function getAutomationProfileSpec(profile = 'primary', { selectors = {} } = {}) {
  if (profile === 'retry') {
    return {
      name: 'retry',
      selectors: RETRY_FIELD_SELECTORS,
      usesConfiguredSelectors: false,
      hiddenIpSelectors: RETRY_HIDDEN_IP_SELECTORS,
      trustedFormSelectors: RETRY_TRUSTEDFORM_SELECTORS,
      jornayaSelectors: RETRY_JORNAYA_SELECTORS,
      successDetectionTimeoutMs: 30000,
      includeFormResetDetection: false,
      responseContract: 'retry',
      browserExecutionsPerRequest: 1,
      automaticRetry: false
    };
  }

  return {
    name: 'primary',
    selectors: mergeSelectors(selectors),
    usesConfiguredSelectors: true,
    hiddenIpSelectors: PRIMARY_HIDDEN_IP_SELECTORS,
    trustedFormSelectors: PRIMARY_TRUSTEDFORM_SELECTORS,
    jornayaSelectors: PRIMARY_JORNAYA_SELECTORS,
    successDetectionTimeoutMs: PRIMARY_SUCCESS_DETECTION_TIMEOUT_MS,
    includeFormResetDetection: true,
    responseContract: 'primary',
    browserExecutionsPerRequest: 1,
    automaticRetry: false
  };
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function delay(ms, signal) {
  if (ms <= 0) {
    return;
  }

  throwIfAborted(signal);
  await sleep(ms, undefined, { signal });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new HardTimeoutError(0);
  }
}

export async function withHardTimeout(work, timeoutMs, onTimeout = undefined) {
  const controller = new AbortController();
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new HardTimeoutError(timeoutMs);
      controller.abort(error);
      try {
        void onTimeout?.(error);
      } catch {
        // Timeout cleanup should never mask the timeout result.
      }
      reject(error);
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

function truncateText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit);
}

async function setupPage(browser, proxy, timeoutMs) {
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  await authenticateProxy(page, proxy);
  return page;
}

export function createNetworkMonitor(page) {
  const state = {
    submissionResponseStatus: null,
    submissionResponseBody: null,
    apps_script_post_fired: false,
    apps_script_post_status: null,
    appsScriptPostUrl: '',
    console_errors: [],
    capturedPostRequests: [],
    postResponseStatusCodes: [],
    postResponseUrls: []
  };

  function pushConsoleError(message) {
    if (state.console_errors.length >= PRODUCTION_CONSOLE_ERROR_LIMIT) {
      return;
    }

    state.console_errors.push(message);
  }

  page.on('console', (message) => {
    if (message.type() === 'error') {
      pushConsoleError(message.text().slice(0, PRODUCTION_CONSOLE_ERROR_LENGTH));
    }
  });

  page.on('pageerror', (error) => {
    pushConsoleError(`PageError: ${(error.message || '').slice(0, PRODUCTION_CONSOLE_ERROR_LENGTH)}`);
  });

  page.on('request', (request) => {
    const url = request.url();

    if (request.method() === 'POST' && state.capturedPostRequests.length < DEBUG_POST_CAPTURE_LIMIT) {
      state.capturedPostRequests.push(url);
    }

    if (url.includes('script.google.com/macros')) {
      state.apps_script_post_fired = true;
      state.appsScriptPostUrl = url.slice(0, 120);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const isPost = response.request().method() === 'POST';

    if (isPost && state.postResponseUrls.length < DEBUG_POST_CAPTURE_LIMIT) {
      state.postResponseUrls.push(url);
      state.postResponseStatusCodes.push(response.status());
    }

    if (url.includes('script.google.com/macros')) {
      state.apps_script_post_status = response.status();
    }

    if (
      !isPost ||
      url.includes('ipify') ||
      url.includes('leadid') ||
      url.includes('jornaya')
    ) {
      return;
    }

    state.submissionResponseStatus = response.status();

    try {
      state.submissionResponseBody = await response.text();
    } catch {
      state.submissionResponseBody = null;
    }
  });

  return {
    getState() {
      return {
        submissionResponseStatus: state.submissionResponseStatus,
        submissionResponseBody: state.submissionResponseBody,
        apps_script_post_fired: state.apps_script_post_fired,
        apps_script_post_status: state.apps_script_post_status,
        console_errors: state.console_errors.slice(0, PRODUCTION_CONSOLE_ERROR_LIMIT),
        capturedPostRequests: state.capturedPostRequests.slice(0, DEBUG_POST_CAPTURE_LIMIT),
        postResponseStatusCodes: state.postResponseStatusCodes.slice(0, DEBUG_POST_CAPTURE_LIMIT),
        postResponseUrls: state.postResponseUrls.slice(0, DEBUG_POST_CAPTURE_LIMIT)
      };
    }
  };
}

async function navigateToTarget(page, targetUrl, runtimeConfig) {
  const response = await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: runtimeConfig.targetNavigationTimeoutMs
  });

  const status = response?.status();
  if (status === 401 || status === 403) {
    throw new TargetSiteForbiddenError(status);
  }

  return response;
}

async function waitForForm(page, selectors, runtimeConfig) {
  const formSelector = PRODUCTION_FORM_SELECTOR;
  await page.waitForSelector(formSelector, {
    timeout: runtimeConfig.formSelectorTimeoutMs
  });
  return formSelector;
}

async function pause(min, max, signal) {
  await delay(randomInt(min, max), signal);
}

async function thinkingPause(signal) {
  await pause(1500, 3000, signal);
}

export async function fillInput(page, selector, value, { signal } = {}) {
  throwIfAborted(signal);
  await pause(400, 900, signal);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, String(value || ''), { delay: randomInt(100, 220) });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, selector, String(value || ''));
  await pause(400, 900, signal);
}

export async function fillPhone(page, selector, value, { signal } = {}) {
  throwIfAborted(signal);
  await pause(400, 900, signal);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  const digits = String(value || '');
  let i = 0;
  while (i < digits.length) {
    throwIfAborted(signal);
    const chunkSize = randomInt(2, 4);
    await page.type(selector, digits.slice(i, i + chunkSize), { delay: randomInt(110, 210) });
    i += chunkSize;
    if (i < digits.length) {
      await pause(500, 1200, signal);
    }
  }
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, selector, digits);
  await pause(400, 800, signal);
}

export async function fillZip(page, selector, value, { signal } = {}) {
  throwIfAborted(signal);
  await pause(400, 1000, signal);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, String(value || ''), { delay: randomInt(120, 220) });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, selector, String(value || ''));
  await pause(400, 800, signal);
}

export async function selectEl(page, selector, value, { signal } = {}) {
  throwIfAborted(signal);
  await pause(800, 1500, signal);
  await page.focus(selector);
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, selector, value);
  await pause(500, 1000, signal);
}

export async function selectCoverage(page, selector, value, { signal } = {}) {
  throwIfAborted(signal);
  await pause(1500, 2500, signal);
  await page.focus(selector);
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, selector, value);
  await pause(600, 1200, signal);
}

export function hasGenderValue(lead = {}) {
  return lead.gender !== undefined && lead.gender !== null && String(lead.gender).trim() !== '';
}

export function submitFieldNamesForLead(lead = {}) {
  return FIELD_NAMES.filter((fieldName) => fieldName !== 'gender' || hasGenderValue(lead));
}

async function fillLeadFields(page, selectors, lead, signal) {
  await fillInput(page, selectors.firstName, lead.firstName, { signal });
  await fillInput(page, selectors.lastName, lead.lastName, { signal });
  await pause(1000, 2200, signal);
  await thinkingPause(signal);
  await fillPhone(page, selectors.phone, lead.phone, { signal });
  await fillZip(page, selectors.zip, lead.zip, { signal });
  await selectEl(page, selectors.state, lead.state, { signal });
  await pause(1000, 2200, signal);
  await pause(1000, 2000, signal);
  await fillInput(page, selectors.beneficiary, lead.beneficiary, { signal });
  await pause(500, 1000, signal);
  await fillInput(page, selectors.age, lead.age, { signal });
  if (hasGenderValue(lead)) {
    await selectEl(page, selectors.gender, lead.gender, { signal });
  }
  await pause(1000, 2200, signal);
  await thinkingPause(signal);
  await selectCoverage(page, selectors.coverage, lead.coverage, { signal });
}

async function readFieldValue(page, selector) {
  if (!selector) {
    return null;
  }

  try {
    return await page.$eval(selector, (element) => {
      if (element.tagName.toLowerCase() === 'select') {
        const selected = element.options[element.selectedIndex];
        return element.value || selected?.textContent?.trim() || '';
      }

      if ('value' in element) {
        return element.value ?? '';
      }

      return element.textContent?.trim() ?? '';
    });
  } catch {
    return null;
  }
}

export async function readFieldValues(page, selectors, fieldNames = FIELD_NAMES) {
  const values = {};

  for (const fieldName of fieldNames) {
    values[fieldName] = await readFieldValue(page, selectors[fieldName]);
  }

  return values;
}

async function injectIpAddress(page, ipAddress, hiddenIpSelectors = PRIMARY_HIDDEN_IP_SELECTORS) {
  try {
    await page.evaluate((ip) => {
      try { window.ipAddress = ip; } catch (e) {}
      try { window.reported_ip = ip; } catch (e) {}
    }, ipAddress);

    for (const selector of hiddenIpSelectors) {
      const found = await page.$(selector);
      if (found) {
        await page.evaluate((sel, ip) => {
          const el = document.querySelector(sel);
          if (el) {
            el.value = ip;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, selector, ipAddress);
      }
    }
  } catch {
    // Production Browserless code ignores IP injection failures.
  }
}

async function readFirstElementValue(page, selectors) {
  return page.evaluate((candidateSelectors) => {
    for (const selector of candidateSelectors) {
      try {
        const element = document.querySelector(selector);
        const value = element?.value ?? element?.getAttribute?.('value') ?? element?.textContent ?? '';
        if (String(value).trim()) {
          return String(value).trim();
        }
      } catch {
        // Ignore unsupported selector syntax in older browser builds.
      }
    }

    return null;
  }, selectors);
}

export async function readTrustedFormWithSelectors(
  page,
  trustedFormSelectors = PRIMARY_TRUSTEDFORM_SELECTORS,
  jornayaSelectors = PRIMARY_JORNAYA_SELECTORS
) {
  return page.evaluate(({ trustedFormSelectors, jornayaSelectors }) => {
    var c = '';
    try { if (window.TrustedForm && window.TrustedForm.certificate_url) c = window.TrustedForm.certificate_url; } catch (e) {}
    if (!c) {
      for (var i = 0; i < trustedFormSelectors.length; i++) {
        var el = document.querySelector(trustedFormSelectors[i]);
        if (el && el.value && String(el.value).indexOf('https://cert.trustedform.com/') === 0) {
          c = el.value;
          break;
        }
      }
    }
    var ok = c && String(c).indexOf('https://cert.trustedform.com/') === 0;
    var jt = '';
    for (var j = 0; j < jornayaSelectors.length; j++) {
      var jel = document.querySelector(jornayaSelectors[j]);
      if (jel && jel.value) {
        jt = jel.value;
        break;
      }
    }
    return { certUrl: c || '', present: !!ok, jornayaToken: jt };
  }, {
    trustedFormSelectors,
    jornayaSelectors
  });
}

export async function readTrustedForm(page) {
  return readTrustedFormWithSelectors(page);
}

async function waitForTrustedForm(
  page,
  runtimeConfig,
  signal,
  trustedFormSelectors = PRIMARY_TRUSTEDFORM_SELECTORS,
  jornayaSelectors = PRIMARY_JORNAYA_SELECTORS
) {
  const deadline = Date.now() + runtimeConfig.trustedFormPollMaxMs;

  while (Date.now() <= deadline) {
    throwIfAborted(signal);

    const trustedForm = await readTrustedFormWithSelectors(page, trustedFormSelectors, jornayaSelectors);
    if (trustedForm.present) {
      return trustedForm;
    }

    await delay(runtimeConfig.trustedFormPollIntervalMs, signal);
  }

  return readTrustedFormWithSelectors(page, trustedFormSelectors, jornayaSelectors);
}

async function ensureTcpaChecked(page, formSelector, selectors, signal) {
  const checkboxSelector = '#quoteForm input[type="checkbox"]';

  const checkbox = await page.$(checkboxSelector);
  if (!checkbox) {
    return false;
  }

  const checked = await checkbox.evaluate((element) => Boolean(element.checked));
  if (checked) {
    return true;
  }

  await checkbox.click();
  await delay(500, signal);
  return true;
}

async function findSubmitElement(page) {
  return page.$(SUBMIT_BUTTON_SELECTOR);
}

async function getBodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText ?? '');
  } catch {
    return '';
  }
}

export async function countValidationErrors(page) {
  try {
    return await page.evaluate((selector) => {
      var els = document.querySelectorAll(selector);
      var visible = 0;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (el.offsetParent === null && s.position !== 'fixed') continue;
        var text = (el.innerText || el.textContent || el.value || '').trim();
        if (text.length > 0) visible++;
      }
      return visible;
    }, VALIDATION_ERROR_SELECTORS.join(', '));
  } catch {
    return 0;
  }
}

export async function waitForSuccessSignal(page, {
  selectors,
  urlBeforeSubmit,
  monitor,
  runtimeConfig,
  timeoutMs = PRIMARY_SUCCESS_DETECTION_TIMEOUT_MS,
  includeFormResetDetection = true,
  waitSuccessReason = 'success_text_or_form_reset'
}) {
  const formResetSelectors = [
    selectors.firstName,
    selectors.lastName,
    selectors.phone,
    selectors.zip,
    selectors.state,
    selectors.beneficiary,
    selectors.age,
    selectors.coverage
  ];

  let hasSuccess = false;
  let successReason = null;

  try {
    await page.waitForFunction((phrases, resetSelectors, includeReset) => {
      var b = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
      if (b && phrases.some(function(p) { return b.includes(p); })) return true;
      var f = document.querySelector('#quoteForm');
      if (f) {
        var s = window.getComputedStyle(f);
        if (s.display === 'none' || s.visibility === 'hidden' || (f.offsetParent === null && s.position !== 'fixed')) {
          if (b && b.length > 50) return true;
        }
        if (includeReset && resetSelectors && resetSelectors.length > 0) {
          var found = 0, cleared = 0;
          for (var i = 0; i < resetSelectors.length; i++) {
            var el = document.querySelector(resetSelectors[i]);
            if (el) {
              found++;
              if (!el.value || !String(el.value).trim()) cleared++;
            }
          }
          if (found >= 3 && cleared === found && b && b.length > 50) return true;
        }
      } else {
        return true;
      }
      return false;
    }, { timeout: timeoutMs }, SUCCESS_PHRASES, formResetSelectors, includeFormResetDetection);
    hasSuccess = true;
    successReason = waitSuccessReason;
  } catch {
    hasSuccess = false;
  }

  const finalUrl = page.url();
  const networkState = monitor.getState();

  if (!hasSuccess && finalUrl !== urlBeforeSubmit) {
    hasSuccess = true;
    successReason = 'url_navigation';
  }

  if (
    !hasSuccess &&
    (
      networkState.submissionResponseStatus === 200 ||
      networkState.submissionResponseStatus === 201 ||
      networkState.submissionResponseStatus === 204
    )
  ) {
    const bodyLower = (networkState.submissionResponseBody || '').toLowerCase();
    if (!FAILURE_PHRASES.some((phrase) => bodyLower.includes(phrase))) {
      hasSuccess = true;
      successReason = 'post_response_200';
    }
  }

  if (hasSuccess) {
    return {
      success: true,
      successReason
    };
  }

  return {
    success: false,
    successReason: null
  };
}

async function captureFailureScreenshot(page) {
  try {
    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 60,
      fullPage: false
    });

    return Buffer.from(screenshot).toString('base64');
  } catch {
    return null;
  }
}

async function capturePageTextSnippet(page, runtimeConfig) {
  const bodyText = await getBodyText(page);
  return truncateText(bodyText, PRODUCTION_PAGE_TEXT_SNIPPET_LIMIT);
}

async function captureBodyInnerText(page, limit = SUCCESS_NOT_DETECTED_BODY_TEXT_LIMIT) {
  const bodyText = await getBodyText(page);
  return truncateText(bodyText, limit);
}

async function captureVisibleValidationErrorText(page) {
  try {
    return await page.evaluate(() => {
      var els = document.querySelectorAll('.validation-error');
      var texts = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (el.offsetParent === null && s.position !== 'fixed') continue;
        var text = (el.innerText || el.textContent || el.value || '').trim();
        if (text.length > 0) texts.push(text);
      }
      return texts;
    });
  } catch {
    return [];
  }
}

async function captureHtmlSnapshot(page) {
  try {
    return await page.evaluate(() => document.documentElement ? document.documentElement.outerHTML : '');
  } catch {
    return '';
  }
}

async function capturePageTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

function getResetFieldSelectors(selectors = {}) {
  return [
    selectors.firstName,
    selectors.lastName,
    selectors.phone,
    selectors.zip,
    selectors.state,
    selectors.beneficiary,
    selectors.age,
    selectors.coverage
  ].filter(Boolean);
}

function detectSuccessPhrases(bodyText) {
  const lowerBodyText = String(bodyText || '').toLowerCase();
  return SUCCESS_PHRASES.filter((phrase) => lowerBodyText.includes(phrase));
}

function getDebugNetworkState(monitor) {
  try {
    return monitor?.getState?.() ?? {};
  } catch {
    return {};
  }
}

async function captureFormState(page, resetFieldSelectors = []) {
  try {
    return await page.evaluate((selectors) => {
      var reset = {
        total: selectors.length,
        found: 0,
        cleared: 0
      };

      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
          reset.found++;
          if (!el.value || !String(el.value).trim()) reset.cleared++;
        }
      }

      var form = document.querySelector('#quoteForm');
      if (!form) {
        return {
          formExistenceState: 'missing',
          formVisibilityState: 'missing',
          resetFieldCount: reset.cleared,
          resetFieldState: reset
        };
      }

      var style = window.getComputedStyle(form);
      var hidden = style.display === 'none' ||
        style.visibility === 'hidden' ||
        (form.offsetParent === null && style.position !== 'fixed');

      return {
        formExistenceState: 'present',
        formVisibilityState: hidden ? 'hidden' : 'visible',
        resetFieldCount: reset.cleared,
        resetFieldState: reset
      };
    }, resetFieldSelectors);
  } catch {
    return {
      formExistenceState: 'unknown',
      formVisibilityState: 'unknown',
      resetFieldCount: 0,
      resetFieldState: {
        total: resetFieldSelectors.length,
        found: 0,
        cleared: 0
      }
    };
  }
}

export async function captureSuccessNotDetectedDebug(page, runtimeConfig = config, debugContext = {}) {
  const networkState = getDebugNetworkState(debugContext.monitor);
  const resetFieldSelectors = getResetFieldSelectors(debugContext.selectors);

  if (!page) {
    return {
      finalUrl: null,
      pageTitle: '',
      bodyTextFirst500: '',
      capturedPostRequests: networkState.capturedPostRequests ?? [],
      postResponseStatusCodes: networkState.postResponseStatusCodes ?? [],
      postResponseUrls: networkState.postResponseUrls ?? [],
      detectedSuccessPhrases: [],
      formVisibilityState: 'unknown',
      formExistenceState: 'unknown',
      resetFieldCount: 0,
      resetFieldState: {
        total: resetFieldSelectors.length,
        found: 0,
        cleared: 0
      },
      bodyInnerText: '',
      visibleValidationErrorText: [],
      screenshotBase64: null,
      htmlSnapshot: '',
      pageTextSnippet: ''
    };
  }

  const bodyInnerText = await captureBodyInnerText(page);
  const bodyTextFirst500 = truncateText(bodyInnerText, PRODUCTION_PAGE_TEXT_SNIPPET_LIMIT);
  const formState = await captureFormState(page, resetFieldSelectors);

  return {
    finalUrl: safePageUrl(page),
    pageTitle: await capturePageTitle(page),
    bodyTextFirst500,
    capturedPostRequests: networkState.capturedPostRequests ?? [],
    postResponseStatusCodes: networkState.postResponseStatusCodes ?? [],
    postResponseUrls: networkState.postResponseUrls ?? [],
    detectedSuccessPhrases: detectSuccessPhrases(bodyInnerText),
    formVisibilityState: formState.formVisibilityState,
    formExistenceState: formState.formExistenceState,
    resetFieldCount: formState.resetFieldCount,
    resetFieldState: formState.resetFieldState,
    bodyInnerText,
    visibleValidationErrorText: await captureVisibleValidationErrorText(page),
    screenshotBase64: await captureFailureScreenshot(page),
    htmlSnapshot: await captureHtmlSnapshot(page),
    pageTextSnippet: await capturePageTextSnippet(page, runtimeConfig)
  };
}

async function buildFailureData(page, partialData, runtimeConfig, startedAt, overrides = {}, debugContext = {}) {
  const debugData = await captureSuccessNotDetectedDebug(page, runtimeConfig, debugContext);

  return createBrowserlessCompatibleData({
    ...partialData,
    ...overrides,
    finalUrl: overrides.finalUrl ?? debugData.finalUrl ?? partialData.finalUrl,
    screenshotBase64: overrides.screenshotBase64 ?? debugData.screenshotBase64,
    pageTextSnippet: overrides.pageTextSnippet ?? debugData.pageTextSnippet,
    bodyInnerText: overrides.bodyInnerText ?? debugData.bodyInnerText,
    visibleValidationErrorText: overrides.visibleValidationErrorText ?? debugData.visibleValidationErrorText,
    htmlSnapshot: overrides.htmlSnapshot ?? debugData.htmlSnapshot,
    pageTitle: overrides.pageTitle ?? debugData.pageTitle,
    bodyTextFirst500: overrides.bodyTextFirst500 ?? debugData.bodyTextFirst500,
    capturedPostRequests: overrides.capturedPostRequests ?? debugData.capturedPostRequests,
    postResponseStatusCodes: overrides.postResponseStatusCodes ?? debugData.postResponseStatusCodes,
    postResponseUrls: overrides.postResponseUrls ?? debugData.postResponseUrls,
    detectedSuccessPhrases: overrides.detectedSuccessPhrases ?? debugData.detectedSuccessPhrases,
    formVisibilityState: overrides.formVisibilityState ?? debugData.formVisibilityState,
    formExistenceState: overrides.formExistenceState ?? debugData.formExistenceState,
    resetFieldCount: overrides.resetFieldCount ?? debugData.resetFieldCount,
    resetFieldState: overrides.resetFieldState ?? debugData.resetFieldState
  });
}

function safePageUrl(page) {
  try {
    return page?.url?.() ?? null;
  } catch {
    return null;
  }
}

export async function verifySelectors(page, selectors, fieldNames = FIELD_NAMES) {
  const results = {};

  for (const fieldName of fieldNames) {
    const selector = selectors[fieldName];
    results[fieldName] = await page
      .$eval(selector, (element) => {
        const style = window.getComputedStyle(element);
        return {
          selector: element.id ? `#${element.id}` : null,
          exists: true,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0,
          tagName: element.tagName.toLowerCase(),
          type: element.getAttribute('type') ?? null
        };
      })
      .catch(() => ({
        selector,
        exists: false,
        visible: false,
        tagName: null,
        type: null
      }));
  }

  return results;
}

export async function checkTestExitIp(page) {
  let ipAddress = 'unknown';
  let proxyOk = true;

  try {
    const response = await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    const ipData = await response.json();
    ipAddress = ipData && ipData.ip ? String(ipData.ip) : 'unknown';
  } catch {
    proxyOk = false;
    ipAddress = 'proxy_check_failed';
  }

  return { ipAddress, proxyOk };
}

export async function verifyProductionTestSelectors(page, selectors = {}) {
  const results = {};

  for (const entry of PRODUCTION_TEST_SELECTOR_ENTRIES) {
    const selector = selectors?.[entry.key] || entry.fallback;
    let present = false;

    try {
      present = Boolean(await page.$(selector));
    } catch {
      present = false;
    }

    results[entry.key] = {
      selector,
      present
    };
  }

  return results;
}

export async function runProductionTestPageChecks(page, targetUrl, selectors = {}, signal = undefined) {
  const results = {
    targetLoaded: false,
    formPresent: false,
    selectors: {}
  };

  throwIfAborted(signal);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    results.targetLoaded = true;
  } catch {
    results.targetLoaded = false;
  }

  throwIfAborted(signal);
  try {
    results.formPresent = Boolean(await page.waitForSelector(PRODUCTION_FORM_SELECTOR, { timeout: 15000 }));
  } catch {
    results.formPresent = false;
  }

  results.selectors = await verifyProductionTestSelectors(page, selectors);
  return results;
}

export async function runTestJob(payload, { runtimeConfig = config, log = undefined, startedAt = Date.now() } = {}) {
  let browser;
  let page;
  const partialData = {
    ipAddress: 'unknown',
    proxyOk: false,
    targetLoaded: false,
    formPresent: false,
    selectors: {}
  };

  try {
    return await withHardTimeout(async (signal) => {
      browser = await launchBrowser(payload.proxy, { timeoutMs: runtimeConfig.browserTimeoutMs });
      page = await setupPage(browser, payload.proxy, runtimeConfig.browserTimeoutMs);
      const ipCheck = await checkTestExitIp(page);
      partialData.ipAddress = ipCheck.ipAddress;
      partialData.proxyOk = ipCheck.proxyOk;

      const pageChecks = await runProductionTestPageChecks(page, payload.targetUrl, payload.selectors, signal);
      partialData.targetLoaded = pageChecks.targetLoaded;
      partialData.formPresent = pageChecks.formPresent;
      partialData.selectors = pageChecks.selectors;
      return {
        ipAddress: partialData.ipAddress,
        proxyOk: partialData.proxyOk,
        targetLoaded: partialData.targetLoaded,
        formPresent: partialData.formPresent,
        selectors: partialData.selectors
      };
    }, runtimeConfig.browserTimeoutMs, () => safeCloseBrowser(browser, log));
  } catch (error) {
    const failureCategory = classifyBrowserError(error);
    return {
      success: false,
      failure_category: failureCategory,
      error: sanitizeErrorMessage(error),
      ipAddress: partialData.ipAddress,
      proxyOk: partialData.proxyOk,
      targetLoaded: partialData.targetLoaded,
      formPresent: partialData.formPresent,
      selectors: partialData.selectors
    };
  } finally {
    const browserClosed = await safeCloseBrowser(browser, log);
    log?.info?.({
      duration_ms: elapsedSince(startedAt),
      ipAddress: partialData.ipAddress,
      browser_closed: browserClosed
    }, 'Browser test job finished');
  }
}

export async function runSubmitJob(payload, options = {}) {
  if ((payload.automationProfile ?? 'primary') === 'retry') {
    return runRetrySubmitJob(payload, options);
  }

  return runPrimarySubmitJob(payload, options);
}

function createRetryNetworkMonitor(page) {
  const state = {
    submissionResponseStatus: null,
    submissionResponseBody: null,
    capturedPostRequests: [],
    postResponseStatusCodes: [],
    postResponseUrls: []
  };

  page.on('request', (request) => {
    if (request.method() === 'POST' && state.capturedPostRequests.length < DEBUG_POST_CAPTURE_LIMIT) {
      state.capturedPostRequests.push(request.url());
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const isPost = response.request().method() === 'POST';

    if (isPost && state.postResponseUrls.length < DEBUG_POST_CAPTURE_LIMIT) {
      state.postResponseUrls.push(url);
      state.postResponseStatusCodes.push(response.status());
    }

    if (isPost && !url.includes('ipify') && !url.includes('leadid') && !url.includes('jornaya')) {
      state.submissionResponseStatus = response.status();
      try {
        state.submissionResponseBody = await response.text();
      } catch {
        state.submissionResponseBody = null;
      }
    }
  });

  return {
    getState() {
      return {
        submissionResponseStatus: state.submissionResponseStatus,
        submissionResponseBody: state.submissionResponseBody,
        capturedPostRequests: state.capturedPostRequests.slice(0, DEBUG_POST_CAPTURE_LIMIT),
        postResponseStatusCodes: state.postResponseStatusCodes.slice(0, DEBUG_POST_CAPTURE_LIMIT),
        postResponseUrls: state.postResponseUrls.slice(0, DEBUG_POST_CAPTURE_LIMIT)
      };
    }
  };
}

async function runPrimarySubmitJob(payload, { runtimeConfig = config, log = undefined, startedAt = Date.now() } = {}) {
  let browser;
  let page;
  const selectors = mergeSelectors(payload.selectors);
  const timeoutMs = Math.min(payload.timeoutMs ?? runtimeConfig.browserTimeoutMs, runtimeConfig.browserTimeoutMs);
  const partialData = createBrowserlessCompatibleData();
  let finalData = null;
  let monitor = null;

  try {
    const data = await withHardTimeout(async (signal) => {
      browser = await launchBrowser(payload.proxy, { timeoutMs });
      page = await setupPage(browser, payload.proxy, timeoutMs);

      partialData.ipAddress = await checkExitIp(page, { timeoutMs: runtimeConfig.ipCheckTimeoutMs });
      await navigateToTarget(page, payload.targetUrl, runtimeConfig);
      let formSelector;
      try {
        formSelector = await waitForForm(page, selectors, runtimeConfig);
      } catch {
        const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
        return createBrowserlessCompatibleData({
          success: false,
          error: `Form #quoteForm not found. ${pageText.slice(0, 200)}`,
          failure_category: 'infrastructure',
          ipAddress: partialData.ipAddress,
          fieldValues: {},
          trustedform_token: '',
          trustedform_present: false,
          finalUrl: safePageUrl(page)
        });
      }
      partialData.finalUrl = page.url();

      await delay(2000, signal);
      const trustedFormStart = Date.now();

      await fillLeadFields(page, selectors, payload.lead, signal);
      partialData.fieldValues = await readFieldValues(page, selectors, FIELD_NAMES);
      await pause(3000, 5000, signal);
      await injectIpAddress(page, partialData.ipAddress);

      const trustedFormElapsed = Date.now() - trustedFormStart;
      await delay(Math.max(0, runtimeConfig.trustedFormMinimumMs - trustedFormElapsed), signal);

      const trustedForm = await waitForTrustedForm(page, runtimeConfig, signal);
      partialData.trustedform_token = trustedForm.certUrl;
      partialData.trustedform_present = trustedForm.present;
      partialData.jornayaToken = trustedForm.jornayaToken;

      if (!trustedForm.present) {
        return createBrowserlessCompatibleData({
          ...partialData,
          success: false,
          failure_category: 'trustedform_missing',
          error: 'TrustedForm certificate URL not generated',
          trustedform_token: trustedForm.jornayaToken || '',
          trustedform_present: false,
          finalUrl: safePageUrl(page)
        });
      }

      await ensureTcpaChecked(page, formSelector, selectors, signal);
      monitor = createNetworkMonitor(page);

      const submitElement = await findSubmitElement(page);
      if (!submitElement) {
        return createBrowserlessCompatibleData({
          ...partialData,
          success: false,
          failure_category: 'form_submission',
          error: 'Submit button not found',
          finalUrl: safePageUrl(page)
        });
      }

      const elapsedBeforeSubmit = Date.now() - trustedFormStart;
      const waitedBeforeSubmitMs = elapsedBeforeSubmit < runtimeConfig.trustedFormMinimumMs
        ? runtimeConfig.trustedFormMinimumMs - elapsedBeforeSubmit
        : 0;
      if (waitedBeforeSubmitMs > 0) {
        await delay(waitedBeforeSubmitMs, signal);
      }

      partialData.urlBeforeSubmit = page.url();
      await submitElement.click();

      const successDetection = await waitForSuccessSignal(page, {
        selectors,
        urlBeforeSubmit: partialData.urlBeforeSubmit,
        monitor,
        runtimeConfig,
        timeoutMs: PRIMARY_SUCCESS_DETECTION_TIMEOUT_MS
      });

      const monitorState = monitor.getState();
      partialData.submissionResponseStatus = monitorState.submissionResponseStatus;
      partialData.submissionResponseBody = monitorState.submissionResponseBody;
      partialData.apps_script_post_fired = monitorState.apps_script_post_fired;
      partialData.apps_script_post_status = monitorState.apps_script_post_status;
      partialData.console_errors = monitorState.console_errors;
      partialData.validation_errors = await countValidationErrors(page);
      partialData.trustedform_ping_url = (await readFirstElementValue(page, TRUSTEDFORM_PING_SELECTORS).catch(() => '')) ?? '';
      partialData.finalUrl = page.url();

      if (!successDetection.success) {
        return buildFailureData(page, partialData, runtimeConfig, startedAt, {
          failure_category: 'success_not_detected',
          error: null
        }, {
          selectors,
          monitor
        });
      }

      return createBrowserlessCompatibleData({
        ...partialData,
        success: true,
        failure_category: null,
        error: null,
        screenshotBase64: null,
        pageTextSnippet: '',
        successReason: successDetection.successReason
      });
    }, timeoutMs, () => safeCloseBrowser(browser, log));

    finalData = data;
    return data;
  } catch (error) {
    const failureCategory = classifyBrowserError(error);
    const monitorState = monitor?.getState?.() ?? {};

    const failureData = createBrowserlessCompatibleData({
      ...partialData,
      submissionResponseStatus: monitorState.submissionResponseStatus ?? partialData.submissionResponseStatus,
      submissionResponseBody: monitorState.submissionResponseBody ?? partialData.submissionResponseBody,
      apps_script_post_fired: monitorState.apps_script_post_fired ?? partialData.apps_script_post_fired,
      apps_script_post_status: monitorState.apps_script_post_status ?? partialData.apps_script_post_status,
      console_errors: monitorState.console_errors ?? partialData.console_errors,
      failure_category: failureCategory,
      error: sanitizeErrorMessage(error),
      finalUrl: safePageUrl(page) ?? partialData.finalUrl
    });

    finalData = failureData;
    return failureData;
  } finally {
    const browserClosed = await safeCloseBrowser(browser, log);
    const logData = finalData ?? partialData;
    log?.info?.({
      target_hostname: safeHostname(payload.targetUrl),
      proxy_hostname: payload.proxy.host,
      duration_ms: elapsedSince(startedAt),
      ipAddress: logData.ipAddress,
      trustedform_present: logData.trustedform_present,
      jornaya_present: Boolean(logData.jornayaToken),
      success: logData.success,
      failure_category: logData.failure_category,
      browser_closed: browserClosed
    }, 'Browser submit job finished');
  }
}

async function runRetrySubmitJob(payload, { runtimeConfig = config, log = undefined, startedAt = Date.now() } = {}) {
  let browser;
  let page;
  const profile = getAutomationProfileSpec('retry', { runtimeConfig });
  const selectors = profile.selectors;
  const timeoutMs = Math.min(payload.timeoutMs ?? runtimeConfig.browserTimeoutMs, runtimeConfig.browserTimeoutMs);
  const partialData = {
    success: false,
    failure_category: null,
    error: null,
    ipAddress: 'unknown',
    trustedform_token: null,
    trustedform_present: false
  };
  let finalData = null;
  let monitor = null;

  try {
    const data = await withHardTimeout(async (signal) => {
      browser = await launchBrowser(payload.proxy, { timeoutMs });
      page = await setupPage(browser, payload.proxy, timeoutMs);

      partialData.ipAddress = await checkExitIp(page, { timeoutMs: 10000 });
      await page.goto(payload.targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

      try {
        await page.waitForSelector(PRODUCTION_FORM_SELECTOR, { timeout: 30000 });
      } catch {
        return {
          success: false,
          error: 'Form not found',
          failure_category: 'infrastructure',
          ipAddress: partialData.ipAddress,
          trustedform_present: false
        };
      }

      await delay(2000, signal);
      const trustedFormStart = Date.now();

      await fillLeadFields(page, selectors, payload.lead, signal);
      const fieldValues = await readFieldValues(page, selectors, FIELD_NAMES);
      await pause(3000, 5000, signal);
      await injectIpAddress(page, partialData.ipAddress, profile.hiddenIpSelectors);

      const trustedFormElapsed = Date.now() - trustedFormStart;
      await delay(Math.max(0, runtimeConfig.trustedFormMinimumMs - trustedFormElapsed), signal);

      const trustedForm = await waitForTrustedForm(
        page,
        runtimeConfig,
        signal,
        profile.trustedFormSelectors,
        profile.jornayaSelectors
      );
      partialData.trustedform_token = trustedForm.certUrl;
      partialData.trustedform_present = trustedForm.present;

      if (!trustedForm.present) {
        return {
          success: false,
          error: 'TrustedForm not generated',
          failure_category: 'trustedform_missing',
          ipAddress: partialData.ipAddress,
          fieldValues,
          trustedform_token: trustedForm.jornayaToken || '',
          trustedform_present: false
        };
      }

      await ensureTcpaChecked(page, PRODUCTION_FORM_SELECTOR, selectors, signal);
      monitor = createRetryNetworkMonitor(page);

      const submitElement = await findSubmitElement(page);
      if (!submitElement) {
        return {
          success: false,
          error: 'Submit button not found',
          failure_category: 'form_submission',
          fieldValues,
          ipAddress: partialData.ipAddress,
          trustedform_token: trustedForm.certUrl,
          trustedform_present: true
        };
      }

      const elapsedBeforeSubmit = Date.now() - trustedFormStart;
      const waitedBeforeSubmitMs = elapsedBeforeSubmit < runtimeConfig.trustedFormMinimumMs
        ? runtimeConfig.trustedFormMinimumMs - elapsedBeforeSubmit
        : 0;
      if (waitedBeforeSubmitMs > 0) {
        await delay(waitedBeforeSubmitMs, signal);
      }

      const urlBeforeSubmit = page.url();
      await submitElement.click();

      const successDetection = await waitForSuccessSignal(page, {
        selectors,
        urlBeforeSubmit,
        monitor,
        runtimeConfig,
        timeoutMs: profile.successDetectionTimeoutMs,
        includeFormResetDetection: profile.includeFormResetDetection,
        waitSuccessReason: 'success_text_or_form_hidden'
      });

      let screenshotBase64 = null;
      let pageTextSnippet = '';
      let successNotDetectedDebug = {};
      if (!successDetection.success) {
        const debugData = await captureSuccessNotDetectedDebug(page, runtimeConfig, {
          selectors,
          monitor
        });
        pageTextSnippet = debugData.pageTextSnippet;
        screenshotBase64 = debugData.screenshotBase64;
        successNotDetectedDebug = {
          finalUrl: debugData.finalUrl,
          pageTitle: debugData.pageTitle,
          bodyTextFirst500: debugData.bodyTextFirst500,
          capturedPostRequests: debugData.capturedPostRequests,
          postResponseStatusCodes: debugData.postResponseStatusCodes,
          postResponseUrls: debugData.postResponseUrls,
          detectedSuccessPhrases: debugData.detectedSuccessPhrases,
          formVisibilityState: debugData.formVisibilityState,
          formExistenceState: debugData.formExistenceState,
          resetFieldCount: debugData.resetFieldCount,
          resetFieldState: debugData.resetFieldState,
          bodyInnerText: debugData.bodyInnerText,
          visibleValidationErrorText: debugData.visibleValidationErrorText,
          htmlSnapshot: debugData.htmlSnapshot
        };
      }

      return createRetryBrowserData({
        success: successDetection.success,
        failure_category: successDetection.success ? null : 'success_not_detected',
        trustedform_token: trustedForm.certUrl,
        trustedform_present: true,
        ipAddress: partialData.ipAddress || 'unknown',
        screenshotBase64,
        pageTextSnippet,
        ...successNotDetectedDebug
      });
    }, timeoutMs, () => safeCloseBrowser(browser, log));

    finalData = data;
    return data;
  } catch (error) {
    const failureData = {
      success: false,
      failure_category: classifyBrowserError(error),
      error: sanitizeErrorMessage(error),
      ipAddress: partialData.ipAddress || 'unknown',
      trustedform_present: false
    };

    finalData = failureData;
    return failureData;
  } finally {
    const browserClosed = await safeCloseBrowser(browser, log);
    const logData = finalData ?? partialData;
    log?.info?.({
      target_hostname: safeHostname(payload.targetUrl),
      proxy_hostname: payload.proxy.host,
      automation_profile: 'retry',
      duration_ms: elapsedSince(startedAt),
      ipAddress: logData.ipAddress,
      trustedform_present: logData.trustedform_present,
      success: logData.success,
      failure_category: logData.failure_category,
      browser_closed: browserClosed
    }, 'Browser retry submit job finished');
  }
}

function safeHostname(targetUrl) {
  try {
    return new URL(targetUrl).hostname;
  } catch {
    return null;
  }
}
