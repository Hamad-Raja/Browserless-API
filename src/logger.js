import pino from 'pino';
import { config } from './config.js';

export const REDACT_PATHS = Object.freeze([
  'req.headers["x-api-key"]',
  'headers["x-api-key"]',
  '*.headers["x-api-key"]',
  'req.headers.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'authorization',
  '*.authorization',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'proxy.username',
  '*.proxy.username',
  'proxy.password',
  '*.proxy.password',
  'lead',
  '*.lead',
  'password',
  '*.password',
  'trustedform_token',
  '*.trustedform_token',
  'jornayaToken',
  '*.jornayaToken',
  'jornaya_token',
  '*.jornaya_token'
]);

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]'
  }
});

export function createRequestLogger(context = {}) {
  return logger.child(context);
}
