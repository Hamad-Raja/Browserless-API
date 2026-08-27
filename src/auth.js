import crypto from 'node:crypto';
import { config } from './config.js';

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function apiKeyAuth(req, res, next) {
  const suppliedKey = req.get('X-API-Key');

  if (!suppliedKey || !safeEquals(suppliedKey, config.apiKey)) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized'
    });
  }

  return next();
}
