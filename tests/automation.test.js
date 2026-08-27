import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMARY_JORNAYA_SELECTORS,
  RETRY_FIELD_SELECTORS,
  RETRY_HIDDEN_IP_SELECTORS,
  RETRY_JORNAYA_SELECTORS,
  RETRY_TRUSTEDFORM_SELECTORS,
  captureSuccessNotDetectedDebug,
  checkTestExitIp,
  createBrowserlessCompatibleData,
  createNetworkMonitor,
  createRetryBrowserData,
  createSubmitResponseData,
  delay,
  getAutomationProfileSpec,
  readFieldValues,
  readTrustedForm,
  runProductionTestPageChecks,
  submitFieldNamesForLead,
  verifyProductionTestSelectors,
  waitForSuccessSignal,
  withHardTimeout
} from '../src/automation.js';
import { safeCloseBrowser } from '../src/browser.js';
import { HardTimeoutError } from '../src/errors.js';
import { authenticateProxy, checkExitIp } from '../src/proxy.js';
import { mergeSelectors } from '../src/validation.js';

test('submit response contract temporarily includes debug fields', () => {
  const data = createSubmitResponseData({
    success: true,
    ipAddress: '203.0.113.10',
    trustedform_token: 'https://cert.trustedform.com/example',
    trustedform_present: true,
    trustedform_ping_url: 'https://cert.trustedform.com/ping',
    jornayaToken: 'leadid-123',
    validation_errors: 2,
    apps_script_post_fired: true,
    apps_script_post_status: 204,
    console_errors: ['console problem'],
    screenshotBase64: 'jpeg',
    successReason: 'post_response_200',
    error: 'not part of public data',
    fieldValues: {},
    finalUrl: 'https://example.com/thank-you',
    urlBeforeSubmit: 'https://example.com/form',
    submissionResponseStatus: 200,
    submissionResponseBody: 'x'.repeat(350),
    pageTextSnippet: 'debug snippet'
  });

  assert.deepEqual(Object.keys(data), [
    'success',
    'failure_category',
    'successReason',
    'trustedform_token',
    'trustedform_present',
    'trustedform_ping_url',
    'jornayaToken',
    'jornaya_token',
    'validation_errors',
    'apps_script_post_fired',
    'apps_script_post_status',
    'console_errors',
    'finalUrl',
    'urlBeforeSubmit',
    'submissionResponseStatus',
    'submissionResponseBody',
    'pageTextSnippet',
    'ipAddress',
    'reported_ip',
    'screenshotBase64'
  ]);

  assert.equal(data.success, true);
  assert.equal(data.ipAddress, '203.0.113.10');
  assert.equal(data.trustedform_token, 'https://cert.trustedform.com/example');
  assert.equal(data.trustedform_present, true);
  assert.equal(data.trustedform_ping_url, 'https://cert.trustedform.com/ping');
  assert.equal(data.jornayaToken, 'leadid-123');
  assert.equal(data.jornaya_token, 'leadid-123');
  assert.equal(data.validation_errors, 2);
  assert.equal(data.apps_script_post_fired, true);
  assert.equal(data.apps_script_post_status, 204);
  assert.deepEqual(data.console_errors, ['console problem']);
  assert.equal(data.successReason, 'post_response_200');
  assert.equal(data.finalUrl, 'https://example.com/thank-you');
  assert.equal(data.urlBeforeSubmit, 'https://example.com/form');
  assert.equal(data.submissionResponseStatus, 200);
  assert.equal(data.submissionResponseBody.length, 300);
  assert.equal(data.pageTextSnippet, 'debug snippet');
  assert.equal(data.reported_ip, '203.0.113.10');
  assert.equal(data.screenshotBase64, 'jpeg');
  assert.equal(Object.hasOwn(data, 'error'), false);
  assert.equal(Object.hasOwn(data, 'fieldValues'), false);
  assert.equal(Object.hasOwn(data, 'duration_ms'), false);
});

test('hard timeout aborts slow work', async () => {
  await assert.rejects(
    () =>
      withHardTimeout(async (signal) => {
        await delay(100, signal);
      }, 10),
    HardTimeoutError
  );
});

test('hard timeout invokes immediate cleanup callback', async () => {
  let cleaned = false;

  await assert.rejects(
    () =>
      withHardTimeout(async (signal) => {
        await delay(100, signal);
      }, 10, () => {
        cleaned = true;
      }),
    HardTimeoutError
  );

  assert.equal(cleaned, true);
});

test('ipify failure is tolerated as unknown', async () => {
  const page = {
    async goto() {
      throw new Error('ipify unavailable');
    }
  };

  assert.equal(await checkExitIp(page, { timeoutMs: 1 }), 'unknown');
});

test('proxy authentication passes username and password through unchanged', async () => {
  const credentials = {};
  const password = ' pass_country-us_state-ohio_session-abcd1234 ';
  const page = {
    async authenticate(value) {
      Object.assign(credentials, value);
    }
  };

  await authenticateProxy(page, {
    host: 'geo.iproyal.com',
    port: 12321,
    username: 'user',
    password,
    stateCode: 'OH',
    stateName: 'Ohio'
  });

  assert.deepEqual(credentials, {
    username: 'user',
    password
  });
});

test('/test ipify failure reports proxy_check_failed', async () => {
  const page = {
    async goto(url, options) {
      assert.equal(url, 'https://api.ipify.org?format=json');
      assert.deepEqual(options, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      throw new Error('ipify unavailable');
    }
  };

  assert.deepEqual(await checkTestExitIp(page), {
    ipAddress: 'proxy_check_failed',
    proxyOk: false
  });
});

test('TrustedForm read captures Jornaya in the same browser evaluation', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;

  try {
    global.window = {
      TrustedForm: {
        certificate_url: ''
      }
    };
    global.document = {
      querySelector(selector) {
        if (selector === 'input[name="TrustedFormCertUrl"]') {
          return {
            value: 'https://cert.trustedform.com/example'
          };
        }
        if (selector === 'input[name="leadid_token"]') {
          return {
            value: 'leadid-123'
          };
        }
        return null;
      }
    };

    const page = {
      async evaluate(fn, args) {
        return fn(args);
      }
    };

    const result = await readTrustedForm(page);

    assert.deepEqual(result, {
      certUrl: 'https://cert.trustedform.com/example',
      present: true,
      jornayaToken: 'leadid-123'
    });
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});

test('/test selector verification checks all production keys with fallbacks', async () => {
  const supplied = {
    first_name: '#firstName',
    phone: '#phoneCustom'
  };
  const queriedSelectors = [];
  const page = {
    async $(selector) {
      queriedSelectors.push(selector);
      return selector === '#gender' ? null : {};
    }
  };

  const results = await verifyProductionTestSelectors(page, supplied);

  assert.deepEqual(Object.keys(results), [
    'first_name',
    'last_name',
    'phone',
    'zip',
    'state',
    'beneficiary',
    'age',
    'gender',
    'coverage'
  ]);
  assert.equal(results.first_name.selector, '#firstName');
  assert.equal(results.last_name.selector, '#lastName');
  assert.equal(results.phone.selector, '#phoneCustom');
  assert.deepEqual(results.gender, {
    selector: '#gender',
    present: false
  });
  assert.equal(queriedSelectors.includes('#gender'), true);
});

test('/test page checks tolerate target and quoteForm failures without filling or submitting', async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push(['goto', url, options.timeout]);
      throw new Error('target timeout');
    },
    async waitForSelector(selector, options) {
      calls.push(['waitForSelector', selector, options.timeout]);
      throw new Error('missing form');
    },
    async $(selector) {
      calls.push(['$', selector]);
      return null;
    },
    async click() {
      throw new Error('should not click');
    },
    async type() {
      throw new Error('should not type');
    }
  };

  const result = await runProductionTestPageChecks(page, 'https://example.com/form', {});

  assert.equal(result.targetLoaded, false);
  assert.equal(result.formPresent, false);
  assert.equal(Object.keys(result.selectors).length, 9);
  assert.deepEqual(calls.slice(0, 2), [
    ['goto', 'https://example.com/form', 60000],
    ['waitForSelector', '#quoteForm', 15000]
  ]);
});

test('/submit fill plan skips gender when no gender value exists', () => {
  const fieldNames = submitFieldNamesForLead({
    firstName: 'John',
    lastName: 'Doe',
    phone: '5551234567',
    zip: '44149',
    state: 'Ohio',
    beneficiary: 'son',
    age: '65',
    gender: '',
    coverage: '15000'
  });

  assert.equal(fieldNames.includes('gender'), false);
});

test('/submit primary field readback keeps structural gender compatibility', async () => {
  const selectors = mergeSelectors({});
  const queriedSelectors = [];
  const page = {
    async $eval(selector) {
      queriedSelectors.push(selector);
      if (selector === '#gender') {
        throw new Error('missing gender element');
      }
      return 'value';
    }
  };

  const values = await readFieldValues(page, selectors);

  assert.equal(queriedSelectors.includes('#gender'), true);
  assert.equal(Object.hasOwn(values, 'gender'), true);
  assert.equal(values.gender, null);
});

test('primary automation profile keeps full production behavior knobs', () => {
  const spec = getAutomationProfileSpec('primary', {
    selectors: {
      first_name: '#configuredFirst'
    },
    runtimeConfig: {
      successDetectionTimeoutMs: 9999
    }
  });

  assert.equal(spec.name, 'primary');
  assert.equal(spec.usesConfiguredSelectors, true);
  assert.equal(spec.selectors.firstName, '#configuredFirst');
  assert.equal(spec.hiddenIpSelectors.length, 6);
  assert.deepEqual(PRIMARY_JORNAYA_SELECTORS, [
    '#leadid_token',
    'input[name="leadid_token"]',
    'input[id*="leadid" i]',
    'input[name*="leadid" i]'
  ]);
  assert.equal(spec.jornayaSelectors, PRIMARY_JORNAYA_SELECTORS);
  assert.equal(spec.successDetectionTimeoutMs, 45000);
  assert.equal(spec.includeFormResetDetection, true);
  assert.equal(spec.responseContract, 'primary');
});

test('retry automation profile preserves retryFailed CODE differences', () => {
  const spec = getAutomationProfileSpec('retry', {
    selectors: {
      first_name: '#shouldBeIgnored'
    }
  });

  assert.equal(spec.name, 'retry');
  assert.equal(spec.usesConfiguredSelectors, false);
  assert.equal(spec.selectors, RETRY_FIELD_SELECTORS);
  assert.equal(spec.selectors.firstName, '#firstName');
  assert.deepEqual(RETRY_HIDDEN_IP_SELECTORS, [
    'input[name="ip"]',
    'input[name="ip_address"]',
    'input[name="proxy_ip"]'
  ]);
  assert.deepEqual(RETRY_TRUSTEDFORM_SELECTORS, [
    '#TrustedFormCertUrl',
    'input[name="TrustedFormCertUrl"]',
    'input[name="xxTrustedFormCertUrl"]',
    '#xxTrustedFormCertUrl'
  ]);
  assert.deepEqual(RETRY_JORNAYA_SELECTORS, [
    '#leadid_token',
    'input[name="leadid_token"]'
  ]);
  assert.equal(spec.successDetectionTimeoutMs, 30000);
  assert.equal(spec.includeFormResetDetection, false);
  assert.equal(spec.responseContract, 'retry');
});

test('retry response contract stays smaller than primary response', () => {
  const data = createRetryBrowserData({
    success: true,
    trustedform_token: 'https://cert.trustedform.com/example',
    trustedform_present: true,
    ipAddress: '203.0.113.10'
  });

  assert.deepEqual(Object.keys(data), [
    'success',
    'failure_category',
    'trustedform_token',
    'trustedform_present',
    'ipAddress',
    'screenshotBase64',
    'pageTextSnippet'
  ]);
  assert.equal(Object.hasOwn(data, 'fieldValues'), false);
  assert.equal(Object.hasOwn(data, 'validation_errors'), false);
  assert.equal(Object.hasOwn(data, 'successReason'), false);
});

test('automation profiles execute one browser run and do not own retries', () => {
  for (const profile of ['primary', 'retry']) {
    const spec = getAutomationProfileSpec(profile);

    assert.equal(spec.browserExecutionsPerRequest, 1);
    assert.equal(spec.automaticRetry, false);
  }
});

test('browser lifecycle close helper closes the browser', async () => {
  let closeCalls = 0;
  const browser = {
    async close() {
      closeCalls++;
    }
  };

  assert.equal(await safeCloseBrowser(browser), true);
  assert.equal(closeCalls, 1);
});

test('success detection checks complete POST body before response truncation', async () => {
  const handlers = {};
  let waitTimeout;
  const responseBody = `${'x'.repeat(301)} error`;
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
    async waitForFunction(_fn, options) {
      waitTimeout = options.timeout;
      throw new Error('timed out waiting for DOM success signal');
    },
    url() {
      return 'https://example.com/form';
    }
  };

  const monitor = createNetworkMonitor(page);
  await handlers.response({
    url() {
      return 'https://example.com/submit';
    },
    status() {
      return 200;
    },
    request() {
      return {
        method() {
          return 'POST';
        }
      };
    },
    async text() {
      return responseBody;
    }
  });

  const detection = await waitForSuccessSignal(page, {
    selectors: {},
    urlBeforeSubmit: 'https://example.com/form',
    monitor,
    runtimeConfig: {
      successDetectionTimeoutMs: 9999
    }
  });

  assert.deepEqual(detection, {
    success: false,
    successReason: null
  });
  assert.equal(waitTimeout, 45000);
  assert.equal(monitor.getState().submissionResponseBody, responseBody);

  const finalData = createBrowserlessCompatibleData({
    submissionResponseBody: monitor.getState().submissionResponseBody
  });
  assert.equal(finalData.submissionResponseBody.length, 300);
  assert.equal(finalData.submissionResponseBody.includes('error'), false);
});

test('success detection still accepts clean POST success response', async () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
    async waitForFunction() {
      throw new Error('timed out waiting for DOM success signal');
    },
    url() {
      return 'https://example.com/form';
    }
  };

  const monitor = createNetworkMonitor(page);
  await handlers.response({
    url() {
      return 'https://example.com/submit';
    },
    status() {
      return 200;
    },
    request() {
      return {
        method() {
          return 'POST';
        }
      };
    },
    async text() {
      return 'ok';
    }
  });

  const detection = await waitForSuccessSignal(page, {
    selectors: {},
    urlBeforeSubmit: 'https://example.com/form',
    monitor,
    runtimeConfig: {
      successDetectionTimeoutMs: 9999
    }
  });

  assert.deepEqual(detection, {
    success: true,
    successReason: 'post_response_200'
  });
});

test('success detection accepts POST 204 no content response', async () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
    async waitForFunction() {
      throw new Error('timed out waiting for DOM success signal');
    },
    url() {
      return 'https://example.com/form';
    }
  };

  const monitor = createNetworkMonitor(page);
  await handlers.response({
    url() {
      return 'https://example.com/submit';
    },
    status() {
      return 204;
    },
    request() {
      return {
        method() {
          return 'POST';
        }
      };
    },
    async text() {
      return '';
    }
  });

  const detection = await waitForSuccessSignal(page, {
    selectors: {},
    urlBeforeSubmit: 'https://example.com/form',
    monitor,
    runtimeConfig: {
      successDetectionTimeoutMs: 9999
    }
  });

  assert.deepEqual(detection, {
    success: true,
    successReason: 'post_response_200'
  });
});

test('success_not_detected debug captures page state without changing detection logic', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  let screenshotOptions;
  const bodyText = 'x'.repeat(2500);

  try {
    const form = {
      offsetParent: {}
    };
    const fields = {
      '#firstName': { value: '' },
      '#lastName': { value: 'Doe' },
      '#phone': { value: '5555555555' }
    };
    const visibleError = {
      innerText: 'Visible validation problem',
      textContent: '',
      value: '',
      offsetParent: {}
    };
    const hiddenError = {
      innerText: 'Hidden validation problem',
      textContent: '',
      value: '',
      offsetParent: {}
    };

    global.window = {
      getComputedStyle(element) {
        if (element === hiddenError) {
          return { display: 'none', visibility: 'visible', position: 'static' };
        }
        return { display: 'block', visibility: 'visible', position: 'static' };
      }
    };
    global.document = {
      body: {
        innerText: bodyText
      },
      documentElement: {
        outerHTML: '<html><body>Snapshot</body></html>'
      },
      querySelector(selector) {
        if (selector === '#quoteForm') {
          return form;
        }
        return fields[selector] ?? null;
      },
      querySelectorAll(selector) {
        assert.equal(selector, '.validation-error');
        return [visibleError, hiddenError];
      }
    };

    const page = {
      url() {
        return 'https://example.com/final';
      },
      async title() {
        return 'Debug title';
      },
      async evaluate(fn, args) {
        return fn(args);
      },
      async screenshot(options) {
        screenshotOptions = options;
        return Buffer.from('jpeg');
      }
    };
    const monitor = {
      getState() {
        return {
          capturedPostRequests: ['https://example.com/submit'],
          postResponseStatusCodes: [422],
          postResponseUrls: ['https://example.com/submit']
        };
      }
    };

    const debug = await captureSuccessNotDetectedDebug(page, undefined, {
      selectors: {
        firstName: '#firstName',
        lastName: '#lastName',
        phone: '#phone'
      },
      monitor
    });

    assert.equal(debug.finalUrl, 'https://example.com/final');
    assert.equal(debug.pageTitle, 'Debug title');
    assert.equal(debug.bodyInnerText.length, 2000);
    assert.equal(debug.bodyTextFirst500.length, 500);
    assert.equal(debug.pageTextSnippet.length, 500);
    assert.deepEqual(debug.capturedPostRequests, ['https://example.com/submit']);
    assert.deepEqual(debug.postResponseStatusCodes, [422]);
    assert.deepEqual(debug.postResponseUrls, ['https://example.com/submit']);
    assert.deepEqual(debug.detectedSuccessPhrases, []);
    assert.equal(debug.formVisibilityState, 'visible');
    assert.equal(debug.formExistenceState, 'present');
    assert.equal(debug.resetFieldCount, 1);
    assert.deepEqual(debug.resetFieldState, {
      total: 3,
      found: 3,
      cleared: 1
    });
    assert.deepEqual(debug.visibleValidationErrorText, ['Visible validation problem']);
    assert.equal(debug.screenshotBase64, Buffer.from('jpeg').toString('base64'));
    assert.deepEqual(screenshotOptions, {
      type: 'jpeg',
      quality: 60,
      fullPage: false
    });
    assert.equal(debug.htmlSnapshot, '<html><body>Snapshot</body></html>');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});
