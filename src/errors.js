export class ApiError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class CapacityError extends ApiError {
  constructor() {
    super(429, 'browser_capacity_reached', 'Browser capacity reached');
    this.name = 'CapacityError';
  }
}

export class BrowserJobError extends Error {
  constructor(message, failureCategory = 'infrastructure') {
    super(message);
    this.name = 'BrowserJobError';
    this.failureCategory = failureCategory;
  }
}

export class HardTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Browser job exceeded hard timeout of ${timeoutMs} ms`);
    this.name = 'HardTimeoutError';
    this.timeoutMs = timeoutMs;
    this.failureCategory = 'browserless_timeout_hung';
  }
}

export class TargetSiteForbiddenError extends BrowserJobError {
  constructor(status) {
    super(`Target site returned HTTP ${status}`, 'target_site_forbidden');
    this.name = 'TargetSiteForbiddenError';
    this.status = status;
  }
}

export function classifyBrowserError(error) {
  if (!error) {
    return 'infrastructure';
  }

  if (error.failureCategory) {
    return error.failureCategory;
  }

  const message = String(error.message ?? error).toLowerCase();
  const name = String(error.name ?? '').toLowerCase();

  if (
    name.includes('timeout') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('navigation timeout')
  ) {
    return 'timeout';
  }

  if (
    message.includes('err_tunnel_connection_failed') ||
    message.includes('err_proxy_connection_failed') ||
    message.includes('407 proxy authentication required') ||
    message.includes('proxy authentication') ||
    message.includes('net::err_no_supported_proxies')
  ) {
    return 'proxy_forbidden';
  }

  if (
    message.includes('403') ||
    message.includes('401') ||
    message.includes('forbidden') ||
    message.includes('access denied')
  ) {
    return 'target_site_forbidden';
  }

  if (
    message.includes('browser disconnected') ||
    message.includes('target closed') ||
    message.includes('protocol error') ||
    message.includes('session closed') ||
    message.includes('websocket') ||
    message.includes('net::')
  ) {
    return 'infrastructure';
  }

  return 'infrastructure';
}

export function sanitizeErrorMessage(error) {
  const original = String(error?.message ?? error ?? 'Unexpected browser error');
  return original
    .replace(/\/\/[^:\s/]+:[^@\s/]+@/g, '//[REDACTED]@')
    .replace(/(password|passwd|pwd)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/(api[_-]?key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/(authorization:\s*)(.+)/gi, '$1[REDACTED]')
    .slice(0, 500);
}

export function toApiErrorResponse(error) {
  if (error instanceof ApiError) {
    const response = {
      success: false,
      error: error.code
    };

    if (error.details) {
      response.details = error.details;
    }

    return {
      statusCode: error.statusCode,
      body: response
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: 'internal_error'
    }
  };
}
