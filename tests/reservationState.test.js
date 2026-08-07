import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_SYNC_STATUS,
  CALENDAR_SYNC_VERSION,
  STALE_SYNC_TIMEOUT_MS,
  canClaimSlotForCreate,
  canRecoverCalendarBackedStaleReservation,
  claimCancellation,
  claimSlotForCreate,
  makeCreatingReservation,
  normalizeReservationForCancellation,
  persistCalendarSync,
  removeReservationById,
  replaceStaleReservation,
  restoreSyncedCancellation,
} from '../api/_lib/reservationState.js';
import { getReservationEventTimes } from '../api/_lib/googleCalendar.js';

const NOW = 1_800_000_000_000;

function syncedReservation(overrides = {}) {
  return {
    name: 'Tester',
    password: 'pw',
    reservationId: 'rid-1',
    calendarEventId: 'event-1',
    calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
    createdAt: NOW,
    syncUpdatedAt: NOW,
    ...overrides,
  };
}

test('normal create claims an empty slot and persists Calendar sync', () => {
  const creating = makeCreatingReservation({ name: 'Tester', password: 'pw', reservationId: 'rid-1', nowMs: NOW });
  const claimed = claimSlotForCreate(null, creating, NOW);
  const synced = persistCalendarSync(claimed, 'rid-1', 'event-1', NOW + 10);

  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CREATING);
  assert.equal(synced.calendarEventId, 'event-1');
  assert.equal(synced.calendarSyncStatus, CALENDAR_SYNC_STATUS.SYNCED);
  assert.equal(synced.calendarSyncVersion, CALENDAR_SYNC_VERSION);
});

test('normal cancel claims synced reservation and removes only the matching reservationId', () => {
  const claimed = claimCancellation(syncedReservation(), { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 1 });

  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
  assert.equal(removeReservationById(claimed, 'rid-1'), null);
  assert.equal(removeReservationById(syncedReservation({ reservationId: 'rid-2' }), 'rid-1'), undefined);
});

test('Calendar creation failure rolls back only the matching creating reservation', () => {
  assert.equal(removeReservationById(syncedReservation({ calendarSyncStatus: CALENDAR_SYNC_STATUS.CREATING }), 'rid-1'), null);
  assert.equal(removeReservationById(syncedReservation({ reservationId: 'new-rid' }), 'rid-1'), undefined);
});

test('Calendar deletion failure restores cancelling reservation to synced', () => {
  const cancelling = syncedReservation({ calendarSyncStatus: CALENDAR_SYNC_STATUS.CANCELLING });
  const restored = restoreSyncedCancellation(cancelling, 'rid-1', NOW + 2);

  assert.equal(restored.calendarSyncStatus, CALENDAR_SYNC_STATUS.SYNCED);
  assert.equal(restoreSyncedCancellation(syncedReservation({ reservationId: 'new-rid' }), 'rid-1'), undefined);
});

test('Calendar event already missing during cancellation still allows Firebase removal', () => {
  const cancelling = claimCancellation(syncedReservation(), { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 1 });

  assert.equal(removeReservationById(cancelling, 'rid-1'), null);
});

test('legacy reservation without calendarEventId can be normalized and cancelled', () => {
  const legacy = { name: 'Tester', password: 'pw' };
  const normalized = normalizeReservationForCancellation(legacy, { password: 'pw', reservationId: 'legacy-rid', nowMs: NOW });
  const claimed = claimCancellation(normalized, { password: 'pw', reservationId: 'legacy-rid', nowMs: NOW + 1 });

  assert.equal(normalized.reservationId, 'legacy-rid');
  assert.equal(normalized.calendarEventId, undefined);
  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
  assert.equal(removeReservationById(claimed, 'legacy-rid'), null);
});

test('legacy normalization uses an already-persisted reservationId from a concurrent cancel', () => {
  const alreadyNormalized = {
    name: 'Tester',
    password: 'pw',
    reservationId: 'winner-rid',
    calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
    createdAt: NOW,
    syncUpdatedAt: NOW,
  };
  const normalized = normalizeReservationForCancellation(alreadyNormalized, {
    password: 'pw',
    reservationId: 'loser-rid',
    nowMs: NOW + 1,
  });
  const claimed = claimCancellation(normalized, {
    password: 'pw',
    reservationId: normalized.reservationId,
    nowMs: NOW + 2,
  });

  assert.equal(normalized.reservationId, 'winner-rid');
  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
});

test('reservation with reservationId but no calendarEventId can be cancelled', () => {
  const broken = syncedReservation({ calendarEventId: undefined });
  const claimed = claimCancellation(broken, { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 1 });

  assert.equal(claimed.calendarEventId, undefined);
  assert.equal(removeReservationById(claimed, 'rid-1'), null);
});

test('two simultaneous creates for the same slot cannot both win', () => {
  const first = makeCreatingReservation({ name: 'A', password: 'pw', reservationId: 'rid-1', nowMs: NOW });
  const second = makeCreatingReservation({ name: 'B', password: 'pw', reservationId: 'rid-2', nowMs: NOW });

  assert.equal(claimSlotForCreate(null, first, NOW).reservationId, 'rid-1');
  assert.equal(claimSlotForCreate(first, second, NOW), undefined);
});

test('two simultaneous cancellations are safe for the same reservationId', () => {
  const firstClaim = claimCancellation(syncedReservation(), { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 1 });
  const secondClaim = claimCancellation(firstClaim, { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 2 });

  assert.equal(firstClaim.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
  assert.equal(secondClaim.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
  assert.equal(removeReservationById(secondClaim, 'rid-1'), null);
});

test('old cancellation completion cannot remove a replacement booking', () => {
  const replacement = syncedReservation({ reservationId: 'replacement-rid' });

  assert.equal(removeReservationById(replacement, 'old-rid'), undefined);
});

test('21:00 reservation ends at next-day 00:00 in Asia/Seoul', () => {
  const eventTimes = getReservationEventTimes({ date: '2026-08-07', time: '21:00' });

  assert.equal(eventTimes.start.dateTime, '2026-08-07T21:00:00');
  assert.equal(eventTimes.end.dateTime, '2026-08-08T00:00:00');
  assert.equal(eventTimes.start.timeZone, 'Asia/Seoul');
  assert.equal(eventTimes.end.timeZone, 'Asia/Seoul');
});

test('incorrect password cannot normalize or claim cancellation', () => {
  assert.equal(
    normalizeReservationForCancellation(syncedReservation(), { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }),
    undefined,
  );
  assert.equal(claimCancellation(syncedReservation(), { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }), undefined);
});

test('stale intermediate states can be recovered without overwriting active operations', () => {
  const activeCreating = syncedReservation({
    calendarEventId: undefined,
    calendarSyncStatus: CALENDAR_SYNC_STATUS.CREATING,
    syncUpdatedAt: NOW,
  });
  const staleCreating = { ...activeCreating, syncUpdatedAt: NOW - STALE_SYNC_TIMEOUT_MS - 1 };
  const replacement = makeCreatingReservation({ name: 'New', password: 'pw', reservationId: 'new-rid', nowMs: NOW });

  assert.equal(canClaimSlotForCreate(activeCreating, NOW), false);
  assert.equal(canClaimSlotForCreate(staleCreating, NOW), true);
  assert.equal(claimSlotForCreate(staleCreating, replacement, NOW).reservationId, 'new-rid');
});

test('stale Calendar-backed reservation is recovered only by matching reservationId and status', () => {
  const staleCancelling = syncedReservation({
    calendarSyncStatus: CALENDAR_SYNC_STATUS.CANCELLING,
    syncUpdatedAt: NOW - STALE_SYNC_TIMEOUT_MS - 1,
  });
  const replacement = makeCreatingReservation({ name: 'New', password: 'pw', reservationId: 'new-rid', nowMs: NOW });

  assert.equal(canRecoverCalendarBackedStaleReservation(staleCancelling, NOW), true);
  assert.equal(replaceStaleReservation(staleCancelling, staleCancelling, replacement, NOW).reservationId, 'new-rid');
  assert.equal(
    replaceStaleReservation({ ...staleCancelling, reservationId: 'other-rid' }, staleCancelling, replacement, NOW),
    undefined,
  );
});

test('legacy cancellation tolerates initial transaction null before actual legacy reservation', () => {
  const legacy = { name: 'test', password: 'pw' };

  assert.equal(
    normalizeReservationForCancellation(null, { password: 'pw', reservationId: 'legacy-rid', nowMs: NOW }),
    null,
  );

  const normalized = normalizeReservationForCancellation(legacy, {
    password: 'pw',
    reservationId: 'legacy-rid',
    nowMs: NOW,
  });

  assert.equal(claimCancellation(null, { password: 'pw', reservationId: 'legacy-rid', nowMs: NOW + 1 }), null);
  assert.equal(
    claimCancellation(normalized, { password: 'pw', reservationId: 'legacy-rid', nowMs: NOW + 1 }).calendarSyncStatus,
    CALENDAR_SYNC_STATUS.CANCELLING,
  );
});

test('synced cancellation tolerates initial transaction null before actual synced reservation', () => {
  const synced = syncedReservation();

  assert.equal(normalizeReservationForCancellation(null, { password: 'pw', reservationId: 'rid-1', nowMs: NOW }), null);
  assert.equal(claimCancellation(null, { password: 'pw', reservationId: 'rid-1', nowMs: NOW }), null);

  const normalized = normalizeReservationForCancellation(synced, { password: 'pw', reservationId: 'rid-1', nowMs: NOW });
  const claimed = claimCancellation(normalized, { password: 'pw', reservationId: 'rid-1', nowMs: NOW + 1 });

  assert.equal(normalized.reservationId, 'rid-1');
  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
});

test('create Calendar persistence tolerates initial transaction null before actual creating reservation', () => {
  const creating = makeCreatingReservation({ name: 'Tester', password: 'pw', reservationId: 'rid-1', nowMs: NOW });

  assert.equal(persistCalendarSync(null, 'rid-1', 'event-1', NOW + 1), null);

  const synced = persistCalendarSync(creating, 'rid-1', 'event-1', NOW + 1);
  assert.equal(synced.reservationId, 'rid-1');
  assert.equal(synced.calendarEventId, 'event-1');
  assert.equal(synced.calendarSyncStatus, CALENDAR_SYNC_STATUS.SYNCED);
  assert.equal(synced.calendarSyncVersion, CALENDAR_SYNC_VERSION);
});

test('true absent reservation stays null without aborting expected-existing transactions', () => {
  assert.equal(normalizeReservationForCancellation(null, { password: 'pw', reservationId: 'rid-1', nowMs: NOW }), null);
  assert.equal(claimCancellation(null, { password: 'pw', reservationId: 'rid-1', nowMs: NOW }), null);
  assert.equal(persistCalendarSync(null, 'rid-1', 'event-1', NOW), null);
  assert.equal(removeReservationById(null, 'rid-1'), null);
  assert.equal(restoreSyncedCancellation(null, 'rid-1', NOW), null);
  assert.equal(
    replaceStaleReservation(null, syncedReservation({ calendarSyncStatus: CALENDAR_SYNC_STATUS.CANCELLING }), syncedReservation(), NOW),
    null,
  );
});

test('password mismatch still aborts after authoritative reservation is visible', () => {
  const synced = syncedReservation();

  assert.equal(normalizeReservationForCancellation(null, { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }), null);
  assert.equal(normalizeReservationForCancellation(synced, { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }), undefined);
  assert.equal(claimCancellation(null, { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }), null);
  assert.equal(claimCancellation(synced, { password: 'wrong', reservationId: 'rid-1', nowMs: NOW }), undefined);
});

test('reservationId mismatch still aborts after authoritative reservation is visible', () => {
  const synced = syncedReservation();

  assert.equal(claimCancellation(null, { password: 'pw', reservationId: 'other-rid', nowMs: NOW }), null);
  assert.equal(claimCancellation(synced, { password: 'pw', reservationId: 'other-rid', nowMs: NOW }), undefined);
  assert.equal(persistCalendarSync(null, 'other-rid', 'event-1', NOW), null);
  assert.equal(persistCalendarSync(synced, 'other-rid', 'event-1', NOW), undefined);
  assert.equal(removeReservationById(null, 'other-rid'), null);
  assert.equal(removeReservationById(synced, 'other-rid'), undefined);
});

test('concurrent replacement reservation is not mutated after initial transaction null', () => {
  const replacement = syncedReservation({ reservationId: 'replacement-rid', calendarEventId: 'replacement-event' });

  assert.equal(removeReservationById(null, 'old-rid'), null);
  assert.equal(removeReservationById(replacement, 'old-rid'), undefined);
  assert.equal(claimCancellation(null, { password: 'pw', reservationId: 'old-rid', nowMs: NOW }), null);
  assert.equal(claimCancellation(replacement, { password: 'pw', reservationId: 'old-rid', nowMs: NOW }), undefined);
  assert.equal(persistCalendarSync(null, 'old-rid', 'old-event', NOW), null);
  assert.equal(persistCalendarSync(replacement, 'old-rid', 'old-event', NOW), undefined);
});
