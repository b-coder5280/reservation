import test from 'node:test';
import assert from 'node:assert/strict';
import {
  printReconciliationSummary,
  runProductionCalendarReconciliation,
  runVercelBuild,
  shouldRunCalendarReconciliation,
} from '../scripts/vercelBuild.js';

function createLogger() {
  const messages = [];
  return {
    messages,
    log: (...args) => messages.push(args.join(' ')),
    error: (...args) => messages.push(args.join(' ')),
  };
}

test('VERCEL_ENV=preview does not execute backfill', async () => {
  let buildRuns = 0;
  let reconciliationRuns = 0;

  await runVercelBuild({
    env: { VERCEL_ENV: 'preview' },
    logger: createLogger(),
    runNormalBuild: async () => { buildRuns += 1; },
    runReconciliation: async () => { reconciliationRuns += 1; },
  });

  assert.equal(buildRuns, 1);
  assert.equal(reconciliationRuns, 0);
});

test('VERCEL_ENV unset local build does not execute backfill', async () => {
  let buildRuns = 0;
  let reconciliationRuns = 0;

  await runVercelBuild({
    env: {},
    logger: createLogger(),
    runNormalBuild: async () => { buildRuns += 1; },
    runReconciliation: async () => { reconciliationRuns += 1; },
  });

  assert.equal(buildRuns, 1);
  assert.equal(reconciliationRuns, 0);
});

test('VERCEL_ENV=production executes backfill after normal build', async () => {
  const calls = [];

  await runVercelBuild({
    env: { VERCEL_ENV: 'production' },
    logger: createLogger(),
    runNormalBuild: async () => { calls.push('build'); },
    runReconciliation: async () => { calls.push('reconcile'); },
  });

  assert.deepEqual(calls, ['build', 'reconcile']);
});

test('VERCEL_ENV=production logs completion after reconciliation', async () => {
  const logger = createLogger();

  await runVercelBuild({
    env: { VERCEL_ENV: 'production' },
    logger,
    runNormalBuild: async () => {},
    runReconciliation: async () => {},
  });

  assert.ok(logger.messages.includes('Production build complete.'));
});

test('production reconciliation closes Firebase Admin resources after success', async () => {
  let closed = false;
  const logger = createLogger();

  await runProductionCalendarReconciliation({
    logger,
    loadResources: async () => ({
      getAdminDb: () => ({ ref: () => ({}) }),
      closeAdminApps: async () => { closed = true; },
      getCalendarClient: () => ({}),
      runCalendarBackfill: async () => ({
        summary: {
          scanned: 0,
          eligible: 0,
          created: 0,
          updated: 0,
          recovered: 0,
          alreadySynced: 0,
          skipped: 0,
          failed: 0,
        },
        results: [],
      }),
    }),
  });

  assert.equal(closed, true);
  assert.ok(logger.messages.includes('Calendar reconciliation resources closed.'));
});

test('production reconciliation closes Firebase Admin resources when backfill throws', async () => {
  let closed = false;
  const logger = createLogger();

  await assert.rejects(
    runProductionCalendarReconciliation({
      logger,
      loadResources: async () => ({
        getAdminDb: () => ({ ref: () => ({}) }),
        closeAdminApps: async () => { closed = true; },
        getCalendarClient: () => ({}),
        runCalendarBackfill: async () => {
          throw new Error('boom');
        },
      }),
    }),
    /boom/,
  );

  assert.equal(closed, true);
  assert.ok(logger.messages.includes('Calendar reconciliation resources closed.'));
});

test('production reconciliation predicate is exact', () => {
  assert.equal(shouldRunCalendarReconciliation({ VERCEL_ENV: 'production' }), true);
  assert.equal(shouldRunCalendarReconciliation({ VERCEL_ENV: 'preview' }), false);
  assert.equal(shouldRunCalendarReconciliation({}), false);
});

test('safe production summary includes reconciliation counters', () => {
  const logger = createLogger();
  printReconciliationSummary({
    scanned: 5,
    eligible: 4,
    created: 1,
    updated: 1,
    recovered: 1,
    alreadySynced: 1,
    skipped: 1,
    failed: 0,
  }, logger);

  assert.ok(logger.messages.includes('Calendar production reconciliation'));
  assert.ok(logger.messages.includes('Created: 1'));
  assert.ok(logger.messages.includes('Recovered: 1'));
});
