import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  IDEMPOTENCY_STATUSES,
  createIdempotencyResponse,
  createIdempotencyStore
} from '../src/idempotency.js';

async function withTempStore(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-api-idempotency-'));
  const dbPath = path.join(dir, 'idempotency.db');
  const store = createIdempotencyStore({
    dbPath,
    ttlDays: 14,
    staleProcessingMs: 1000,
    ...options
  });

  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { store, dbPath };
}

test('idempotency absent leaves legacy requests outside the store', async (t) => {
  const { store } = await withTempStore(t);

  assert.equal(store.getAttempt('missing-attempt'), null);
});

test('first attempt reserves and stores one browser result', async (t) => {
  const { store } = await withTempStore(t);
  const first = store.reserveAttempt({
    attemptId: 'attempt-a',
    agentLeadId: 'lead-a'
  });

  assert.equal(first.reserved, true);
  assert.equal(first.record.status, IDEMPOTENCY_STATUSES.PROCESSING);
  assert.equal(first.record.browserStarted, false);

  store.markBrowserStarted('attempt-a');
  const completed = store.completeAttempt({
    attemptId: 'attempt-a',
    status: IDEMPOTENCY_STATUSES.SUCCESS,
    browserStarted: true,
    responseCode: 200,
    result: {
      data: {
        success: true,
        ipAddress: '203.0.113.10'
      }
    }
  });

  assert.equal(completed.status, IDEMPOTENCY_STATUSES.SUCCESS);
  assert.equal(completed.browserStarted, true);
});

test('duplicate after success is replayed without reserving another attempt', async (t) => {
  const { store } = await withTempStore(t);

  assert.equal(store.reserveAttempt({ attemptId: 'attempt-success', agentLeadId: 'lead-a' }).reserved, true);
  store.markBrowserStarted('attempt-success');
  store.completeAttempt({
    attemptId: 'attempt-success',
    status: IDEMPOTENCY_STATUSES.SUCCESS,
    browserStarted: true,
    responseCode: 200,
    result: {
      data: {
        success: true,
        trustedform_present: true
      }
    }
  });

  const duplicate = store.reserveAttempt({
    attemptId: 'attempt-success',
    agentLeadId: 'lead-a'
  });
  const response = createIdempotencyResponse(duplicate.record, {
    duplicate: true,
    replayed: true
  });

  assert.equal(duplicate.reserved, false);
  assert.equal(response.data.success, true);
  assert.equal(response.duplicate, true);
  assert.equal(response.replayed, true);
  assert.equal(response.idempotencyStatus, IDEMPOTENCY_STATUSES.SUCCESS);
});

test('concurrent duplicate reservation allows exactly one owner', async (t) => {
  const { store } = await withTempStore(t);

  const reservations = await Promise.all([
    Promise.resolve().then(() => store.reserveAttempt({ attemptId: 'attempt-b', agentLeadId: 'lead-b' })),
    Promise.resolve().then(() => store.reserveAttempt({ attemptId: 'attempt-b', agentLeadId: 'lead-b' }))
  ]);

  assert.equal(reservations.filter((item) => item.reserved).length, 1);
  assert.equal(reservations.filter((item) => !item.reserved).length, 1);
});

test('same agentLeadId with a new attemptId is allowed', async (t) => {
  const { store } = await withTempStore(t);

  const first = store.reserveAttempt({ attemptId: 'attempt-c1', agentLeadId: 'lead-c' });
  const second = store.reserveAttempt({ attemptId: 'attempt-c2', agentLeadId: 'lead-c' });

  assert.equal(first.reserved, true);
  assert.equal(second.reserved, true);
});

test('same agentLeadId and old successful attemptId is blocked and replayed', async (t) => {
  const { store } = await withTempStore(t);

  store.reserveAttempt({ attemptId: 'attempt-f', agentLeadId: 'lead-f' });
  store.markBrowserStarted('attempt-f');
  store.completeAttempt({
    attemptId: 'attempt-f',
    status: IDEMPOTENCY_STATUSES.SUCCESS,
    browserStarted: true,
    responseCode: 200,
    result: {
      data: {
        success: true
      }
    }
  });

  const duplicate = store.reserveAttempt({ attemptId: 'attempt-f', agentLeadId: 'lead-f' });

  assert.equal(duplicate.reserved, false);
  assert.equal(duplicate.record.status, IDEMPOTENCY_STATUSES.SUCCESS);
});

test('idempotency result survives store recreation', async (t) => {
  const { store, dbPath } = await withTempStore(t);

  store.reserveAttempt({ attemptId: 'attempt-g', agentLeadId: 'lead-g' });
  store.markBrowserStarted('attempt-g');
  store.completeAttempt({
    attemptId: 'attempt-g',
    status: IDEMPOTENCY_STATUSES.SUCCESS,
    browserStarted: true,
    responseCode: 200,
    result: {
      data: {
        success: true,
        ipAddress: '198.51.100.5'
      }
    }
  });
  store.close();

  const reopened = createIdempotencyStore({ dbPath });

  try {
    const duplicate = reopened.reserveAttempt({ attemptId: 'attempt-g', agentLeadId: 'lead-g' });

    assert.equal(duplicate.reserved, false);
    assert.equal(duplicate.record.status, IDEMPOTENCY_STATUSES.SUCCESS);
    assert.equal(createIdempotencyResponse(duplicate.record, { replayed: true }).data.ipAddress, '198.51.100.5');
  } finally {
    reopened.close();
  }
});

test('stale processing transitions once to unknown_outcome without relaunch', async (t) => {
  const { store } = await withTempStore(t, { staleProcessingMs: 1 });

  store.reserveAttempt({ attemptId: 'attempt-h', agentLeadId: 'lead-h' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const duplicate = store.reserveAttempt({ attemptId: 'attempt-h', agentLeadId: 'lead-h' });
  const again = store.reserveAttempt({ attemptId: 'attempt-h', agentLeadId: 'lead-h' });

  assert.equal(duplicate.reserved, false);
  assert.equal(duplicate.record.status, IDEMPOTENCY_STATUSES.UNKNOWN_OUTCOME);
  assert.equal(duplicate.record.errorMessage, 'stale_processing');
  assert.equal(duplicate.record.browserStarted, false);
  assert.equal(again.record.updatedAt, duplicate.record.updatedAt);
});

test('capacity rejection before browser launch stores failed_pre_browser', async (t) => {
  const { store } = await withTempStore(t);
  let browserLaunches = 0;

  store.reserveAttempt({ attemptId: 'attempt-capacity', agentLeadId: 'lead-capacity' });
  const completed = store.completeAttempt({
    attemptId: 'attempt-capacity',
    status: IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER,
    browserStarted: false,
    responseCode: 429,
    result: {
      success: false,
      error: 'browser_capacity_reached'
    },
    errorMessage: 'browser_capacity_reached'
  });

  assert.equal(browserLaunches, 0);
  assert.equal(completed.browserStarted, false);
  assert.equal(completed.status, IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER);
});

test('cleanup deletes old completed attempts but keeps processing attempts', async (t) => {
  const { store, dbPath } = await withTempStore(t, { ttlDays: 7 });

  store.reserveAttempt({ attemptId: 'attempt-clean', agentLeadId: 'lead-clean' });
  store.completeAttempt({
    attemptId: 'attempt-clean',
    status: IDEMPOTENCY_STATUSES.FAILED_PRE_BROWSER,
    browserStarted: false,
    responseCode: 400,
    result: {
      success: false,
      error: 'invalid'
    }
  });
  store.reserveAttempt({ attemptId: 'attempt-processing', agentLeadId: 'lead-clean' });

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE browser_attempts SET finished_at = ? WHERE attempt_id = ?')
      .run(new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), 'attempt-clean');
  } finally {
    db.close();
  }

  assert.equal(store.cleanup(), 1);
  assert.equal(store.getAttempt('attempt-clean'), null);
  assert.equal(store.getAttempt('attempt-processing').status, IDEMPOTENCY_STATUSES.PROCESSING);
});
