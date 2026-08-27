import net from 'node:net';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { config } from './config.js';

export const FIELD_NAMES = Object.freeze([
  'firstName',
  'lastName',
  'phone',
  'zip',
  'state',
  'beneficiary',
  'age',
  'gender',
  'coverage'
]);

export const DEFAULT_FIELD_SELECTORS = Object.freeze({
  firstName: '#firstName',
  lastName: '#lastName',
  phone: '#phone',
  zip: '#zip-code',
  state: '#state',
  beneficiary: '#beneficiary',
  age: '#age',
  gender: '#gender',
  coverage: '#coverage'
});

export const PRODUCTION_SELECTOR_KEYS = Object.freeze({
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  zip: 'zip',
  state: 'state',
  beneficiary: 'beneficiary',
  age: 'age',
  gender: 'gender',
  coverage: 'coverage'
});

const nonEmptyString = z.string().trim().min(1);
const nonEmptyUnmodifiedString = z.string().min(1);
const optionalSelector = z.string().trim().min(1).optional();
const optionalGender = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().trim().optional()
);
export const automationProfileSchema = z.enum(['primary', 'retry']).default('primary');

export const selectorsSchema = z
  .object({
    first_name: optionalSelector,
    last_name: optionalSelector,
    firstName: optionalSelector,
    lastName: optionalSelector,
    phone: optionalSelector,
    zip: optionalSelector,
    state: optionalSelector,
    beneficiary: optionalSelector,
    age: optionalSelector,
    gender: optionalSelector,
    coverage: optionalSelector,
    form: optionalSelector,
    tcpaCheckbox: optionalSelector,
    submitButton: optionalSelector
  })
  .strict();

export const proxySchema = z
  .object({
    host: nonEmptyString,
    port: z.coerce.number().int().min(1).max(65535),
    username: nonEmptyUnmodifiedString,
    password: nonEmptyUnmodifiedString,
    stateCode: z.string().nullable().optional(),
    stateName: z.string().nullable().optional()
  })
  .strict();

export const leadSchema = z
  .object({
    firstName: nonEmptyString,
    lastName: nonEmptyString,
    phone: nonEmptyString,
    zip: nonEmptyString,
    state: nonEmptyString,
    beneficiary: nonEmptyString,
    age: nonEmptyString,
    gender: optionalGender,
    coverage: nonEmptyString
  })
  .strict();

export const testRequestSchema = z
  .object({
    targetUrl: z.string().url(),
    selectors: selectorsSchema.optional().default({}),
    proxy: proxySchema
  })
  .strict();

export const submitRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(200).optional(),
    targetUrl: z.string().url(),
    lead: leadSchema,
    selectors: selectorsSchema.optional().default({}),
    proxy: proxySchema,
    automationProfile: automationProfileSchema,
    timeoutMs: z.coerce.number().int().min(1000).optional()
  })
  .strict();

export function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        details: parsed.error.flatten()
      });
    }

    req.validatedBody = parsed.data;
    return next();
  };
}

export function mergeSelectors(selectors = {}) {
  return FIELD_NAMES.reduce((merged, fieldName) => {
    const productionKey = PRODUCTION_SELECTOR_KEYS[fieldName];
    merged[fieldName] =
      selectors[productionKey] ??
      selectors[fieldName] ??
      DEFAULT_FIELD_SELECTORS[fieldName];
    return merged;
  }, {
    form: selectors.form,
    tcpaCheckbox: selectors.tcpaCheckbox,
    submitButton: selectors.submitButton
  });
}

export function wasSelectorSupplied(selectors = {}, fieldName) {
  const productionKey = PRODUCTION_SELECTOR_KEYS[fieldName];
  return (
    Object.hasOwn(selectors, productionKey) ||
    Object.hasOwn(selectors, fieldName)
  );
}

export function suppliedSelectorFieldNames(selectors = {}) {
  return FIELD_NAMES.filter((fieldName) => wasSelectorSupplied(selectors, fieldName));
}

function normalizeHost(host) {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function isBlockedHostname(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'localdomain' ||
    host.endsWith('.localdomain') ||
    host.endsWith('.internal')
  );
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host) {
  const normalized = host.toLowerCase();

  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.replace('::ffff:', ''));
  }

  return false;
}

export function isPrivateOrLocalAddress(host) {
  const normalized = normalizeHost(host);

  if (isBlockedHostname(normalized)) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function hostMatchesAllowed(host, allowedHost) {
  const normalizedAllowed = normalizeHost(allowedHost).replace(/^\*\./, '');

  if (!normalizedAllowed) {
    return false;
  }

  return host === normalizedAllowed || host.endsWith(`.${normalizedAllowed}`);
}

export function assertAllowedTargetUrl(targetUrl, allowedHosts = config.allowedTargetHosts) {
  let parsed;

  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new ApiError(400, 'invalid_target_url', 'targetUrl must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_target_url', 'targetUrl must use HTTPS');
  }

  const hostname = normalizeHost(parsed.hostname);

  if (isPrivateOrLocalAddress(hostname)) {
    throw new ApiError(400, 'target_host_forbidden', 'targetUrl points to a private or local address');
  }

  if (!allowedHosts.length || !allowedHosts.some((allowedHost) => hostMatchesAllowed(hostname, allowedHost))) {
    throw new ApiError(400, 'target_host_not_allowed', 'targetUrl host is not allowed');
  }

  return parsed;
}

export function assertAllowedProxyHost(proxy, allowedHosts = config.allowedProxyHosts) {
  const hostname = normalizeHost(proxy?.host);

  if (!hostname || isPrivateOrLocalAddress(hostname)) {
    throw new ApiError(400, 'proxy_host_forbidden', 'proxy host is not allowed');
  }

  if (!allowedHosts.length || !allowedHosts.some((allowedHost) => normalizeHost(allowedHost) === hostname)) {
    throw new ApiError(400, 'proxy_host_not_allowed', 'proxy host is not allowed');
  }

  return hostname;
}
