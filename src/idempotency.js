import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const IDEMPOTENCY_STATUSES = Object.freeze({
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED_PRE_BROWSER: 'failed_pre_browser',
  FAILED_POST_BROWSER: 'failed_post_browser',
  UNKNOWN_OUTCOME: 'unknown_outcome'
});

let defaultStore;

function nowIso() {
  return new Date().toISOString();
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    attemptId: row.attempt_id,
    agentLeadId: row.agent_lead_id ?? null,
    status: row.status,
    browserStarted: Boolean(row.browser_started),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
    responseCode: row.response_code ?? null,
    resultJson: row.result_json ?? null,
    errorMessage: row.error_message ?? null
  };
}

export function createIdempotencyResponse(record, { duplicate = true, replayed = false } = {}) {
  const storedResult = safeJsonParse(record?.resultJson);

  if (storedResult && record.status === IDEMPOTENCY_STATUSES.SUCCESS) {
    return {
      ...storedResult,
      duplicate,
      replayed,
      idempotencyStatus: record.status,
      agentLeadId: record.agentLeadId,
      attemptId: record.attemptId
    };
  }

  return {
    success: false,
    duplicate,
    replayed,
    idempotencyStatus: record?.status ?? IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME,
    agentLeadId: record?.agentLeadId ?? null,
    attemptId: record?.attemptId ?? null,
    browserStarted: Boolean(record?.browserStarted),
    failure_category: record?.status ?? IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME,
    error: record?.errorMessage ?? null
  };
}

export function createIdempotencyStore({
  dbPath = config.idempotencyDbPath,
  ttlDays = config.idempotencyTtlDays,
  staleProcessingMs = config.idempotencyStaleProcessingMs,
  logger = undefined
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_attempts (
      attempt_id TEXT PRIMARY KEY,
      agent_lead_id TEXT,
      status TEXT NOT NULL,
      browser_started INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      response_code INTEGER,
      result_json TEXT,
      error_message TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_browser_attempts_finished_at ON browser_attempts(finished_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_browser_attempts_status_created_at ON browser_attempts(status, created_at)');
  let closed = false;

  const selectAttempt = db.prepare('SELECT * FROM browser_attempts WHERE attempt_id = ?');
  const insertAttempt = db.prepare(`
    INSERT INTO browser_attempts (
      attempt_id,
      agent_lead_id,
      status,
      browser_started,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(attempt_id) DO NOTHING
  `);
  const markBrowserStartedStatement = db.prepare(`
    UPDATE browser_attempts
    SET browser_started = 1,
        updated_at = ?
    WHERE attempt_id = ?
  `);
  const completeAttemptStatement = db.prepare(`
    UPDATE browser_attempts
    SET status = ?,
        browser_started = ?,
        updated_at = ?,
        finished_at = ?,
        response_code = ?,
        result_json = ?,
        error_message = ?
    WHERE attempt_id = ?
  `);
  const markStaleStatement = db.prepare(`
    UPDATE browser_attempts
    SET status = ?,
        updated_at = ?,
        finished_at = ?,
        response_code = ?,
        result_json = ?,
        error_message = ?
    WHERE attempt_id = ?
      AND status = ?
  `);
  const cleanupStatement = db.prepare(`
    DELETE FROM browser_attempts
    WHERE status IN (?, ?, ?, ?)
      AND finished_at IS NOT NULL
      AND finished_at < ?
  `);

  function getAttempt(attemptId) {
    return normalizeRow(selectAttempt.get(attemptId));
  }

  function transitionIfStale(record) {
    if (!record || record.status !== IDEMPOTENCY_STATUSES.PROCESSING) {
      return record;
    }

    const ageMs = Date.now() - Date.parse(record.createdAt);
    if (!Number.isFinite(ageMs) || ageMs < staleProcessingMs) {
      return record;
    }

    const timestamp = nowIso();
    const staleRecord = {
      ...record,
      status: IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME,
      finishedAt: timestamp,
      updatedAt: timestamp,
      responseCode: 200,
      errorMessage: 'stale_processing'
    };
    const resultJson = JSON.stringify(createIdempotencyResponse(staleRecord, {
      duplicate: true,
      replayed: false
    }));

    markStaleStatement.run(
      IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME,
      timestamp,
      timestamp,
      200,
      resultJson,
      'stale_processing',
      record.attemptId,
      IDEMPOTENCY_STATUSES.PROCESSING
    );

    logger?.warn?.({
      attemptId: record.attemptId,
      agentLeadId: record.agentLeadId,
      idempotency_status: IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME
    }, '[IDEMPOTENCY] unknown outcome');

    return getAttempt(record.attemptId);
  }

  return {
    reserveAttempt({ attemptId, agentLeadId = null }) {
      const timestamp = nowIso();
      const result = insertAttempt.run(
        attemptId,
        agentLeadId,
        IDEMPOTENCY_STATUSES.PROCESSING,
        timestamp,
        timestamp
      );

      if (result.changes === 1) {
        logger?.info?.({
          attemptId,
          agentLeadId,
          idempotency_status: IDEMPOTENCY_STATUSES.PROCESSING
        }, '[IDEMPOTENCY] reserved attempt');

        return {
          reserved: true,
          record: getAttempt(attemptId)
        };
      }

      return {
        reserved: false,
        record: transitionIfStale(getAttempt(attemptId))
      };
    },

    markBrowserStarted(attemptId) {
      markBrowserStartedStatement.run(nowIso(), attemptId);
    },

    completeAttempt({
      attemptId,
      status,
      browserStarted,
      responseCode,
      result,
      errorMessage = null
    }) {
      const timestamp = nowIso();
      completeAttemptStatement.run(
        status,
        browserStarted ? 1 : 0,
        timestamp,
        timestamp,
        responseCode,
        JSON.stringify(result),
        errorMessage,
        attemptId
      );

      logger?.info?.({
        attemptId,
        idempotency_status: status
      }, status === IDEMPOTENCY_STATUSES.SUCCESS
        ? '[IDEMPOTENCY] stored success'
        : '[IDEMPOTENCY] stored result');

      return getAttempt(attemptId);
    },

    cleanup() {
      const cutoff = daysAgoIso(ttlDays);
      const result = cleanupStatement.run(
        IDEMPOTENCY_STATUSES.SUCCESS,
        IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER,
        IDEMPOTENCY_STATUSES.FAILED_POST_BROWSER,
        IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME,
        cutoff
      );

      if (result.changes > 0) {
        logger?.info?.({
          deleted: result.changes,
          cutoff
        }, '[IDEMPOTENCY] cleanup');
      }

      return result.changes;
    },

    getAttempt,

    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    }
  };
}

export function getIdempotencyStore(logger = undefined) {
  if (!defaultStore) {
    defaultStore = createIdempotencyStore({ logger });
  }

  return defaultStore;
}
