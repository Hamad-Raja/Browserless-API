import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedProxyHost,
  assertAllowedTargetUrl,
  isPrivateOrLocalAddress,
  mergeSelectors,
  submitRequestSchema
} from '../src/validation.js';
import { ApiError } from '../src/errors.js';

test('submit schema rejects unknown code field', () => {
  const result = submitRequestSchema.safeParse({
    code: 'new Function("return process.env")'
  });

  assert.equal(result.success, false);
});

test('selector normalization accepts production snake_case keys', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '33101',
      state: 'Florida',
      beneficiary: 'Spouse',
      age: '65',
      coverage: '10000'
    },
    selectors: {
      first_name: '#first_name_prod',
      last_name: '#last_name_prod',
      phone: '#phone_prod'
    },
    proxy: {
      host: 'geo.iproyal.com',
      port: 12321,
      username: 'user',
      password: 'pass'
    }
  });

  assert.equal(result.success, true);

  const selectors = mergeSelectors(result.data.selectors);
  assert.equal(selectors.firstName, '#first_name_prod');
  assert.equal(selectors.lastName, '#last_name_prod');
  assert.equal(selectors.phone, '#phone_prod');
  assert.equal(selectors.zip, '#zip-code');
});

test('selector normalization lets production snake_case win over camelCase aliases', () => {
  const selectors = mergeSelectors({
    first_name: '#production-first',
    firstName: '#api-first',
    last_name: '#production-last',
    lastName: '#api-last'
  });

  assert.equal(selectors.firstName, '#production-first');
  assert.equal(selectors.lastName, '#production-last');
});

test('submit payload without gender is valid', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '44149',
      state: 'Ohio',
      beneficiary: 'son',
      age: '65',
      coverage: '15000'
    },
    selectors: {
      first_name: '#firstName',
      last_name: '#lastName',
      phone: '#phone',
      zip: '#zip-code',
      state: '#state',
      beneficiary: '#beneficiary',
      age: '#age',
      coverage: '#coverage'
    },
    proxy: {
      host: 'geo.iproyal.com',
      port: 12321,
      username: 'user',
      password: 'pass'
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.lead.gender, undefined);
});

test('submit automationProfile defaults to primary', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '44149',
      state: 'Ohio',
      beneficiary: 'son',
      age: '65',
      coverage: '15000'
    },
    proxy: {
      host: 'geo.iproyal.com',
      port: 12321,
      username: 'user',
      password: 'pass'
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data.automationProfile, 'primary');
});

test('submit schema requires proxy from payload', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
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
  });

  assert.equal(result.success, false);
});

test('submit schema rejects partial proxy instead of applying environment fallback', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '44149',
      state: 'Ohio',
      beneficiary: 'son',
      age: '65',
      coverage: '15000'
    },
    proxy: {
      username: 'request-user'
    }
  });

  assert.equal(result.success, false);
});

test('submit schema accepts Base44 proxy metadata and preserves password exactly', () => {
  const password = ' pass_country-us_state-ohio_session-abcd1234 ';
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '44149',
      state: 'Ohio',
      beneficiary: 'son',
      age: '65',
      coverage: '15000'
    },
    proxy: {
      host: 'geo.iproyal.com',
      port: '12321',
      username: 'user',
      password,
      stateCode: 'OH',
      stateName: 'Ohio'
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.proxy, {
    host: 'geo.iproyal.com',
    port: 12321,
    username: 'user',
    password,
    stateCode: 'OH',
    stateName: 'Ohio'
  });
});

test('submit automationProfile accepts primary and retry', () => {
  for (const automationProfile of ['primary', 'retry']) {
    const result = submitRequestSchema.safeParse({
      targetUrl: 'https://example.com/form',
      automationProfile,
      lead: {
        firstName: 'John',
        lastName: 'Doe',
        phone: '5551234567',
        zip: '44149',
        state: 'Ohio',
        beneficiary: 'son',
        age: '65',
        gender: null,
        coverage: '15000'
      },
      proxy: {
        host: 'geo.iproyal.com',
        port: 12321,
        username: 'user',
        password: 'pass'
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.data.automationProfile, automationProfile);
    assert.equal(result.data.lead.gender, undefined);
  }
});

test('submit automationProfile rejects invalid values', () => {
  const result = submitRequestSchema.safeParse({
    targetUrl: 'https://example.com/form',
    automationProfile: 'new Function("return process.env")',
    lead: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5551234567',
      zip: '44149',
      state: 'Ohio',
      beneficiary: 'son',
      age: '65',
      coverage: '15000'
    },
    proxy: {
      host: 'geo.iproyal.com',
      port: 12321,
      username: 'user',
      password: 'pass'
    }
  });

  assert.equal(result.success, false);
});

test('target URL allowlist accepts HTTPS production host and subdomains', () => {
  const parsed = assertAllowedTargetUrl('https://forms.example.com/quote', ['example.com']);
  assert.equal(parsed.hostname, 'forms.example.com');
});

test('target URL allowlist rejects non-HTTPS and local addresses', () => {
  assert.throws(() => assertAllowedTargetUrl('http://example.com/form', ['example.com']), ApiError);
  assert.throws(() => assertAllowedTargetUrl('https://127.0.0.1/form', ['127.0.0.1']), ApiError);
  assert.throws(() => assertAllowedTargetUrl('file:///etc/passwd', ['example.com']), ApiError);
});

test('target URL allowlist rejects hosts outside configured list', () => {
  assert.throws(() => assertAllowedTargetUrl('https://attacker.example.net/form', ['example.com']), ApiError);
});

test('private address helper covers common private ranges', () => {
  assert.equal(isPrivateOrLocalAddress('localhost'), true);
  assert.equal(isPrivateOrLocalAddress('10.0.0.1'), true);
  assert.equal(isPrivateOrLocalAddress('172.16.0.1'), true);
  assert.equal(isPrivateOrLocalAddress('192.168.1.1'), true);
  assert.equal(isPrivateOrLocalAddress('::1'), true);
  assert.equal(isPrivateOrLocalAddress('8.8.8.8'), false);
});

test('proxy allowlist rejects arbitrary proxy hosts', () => {
  assert.equal(
    assertAllowedProxyHost(
      {
        host: 'geo.iproyal.com',
        port: 12321,
        username: 'user',
        password: 'pass'
      },
      ['geo.iproyal.com']
    ),
    'geo.iproyal.com'
  );

  assert.throws(
    () =>
      assertAllowedProxyHost(
        {
          host: 'proxy.attacker.test',
          port: 8080,
          username: 'user',
          password: 'pass'
        },
        ['geo.iproyal.com']
      ),
    ApiError
  );
});
