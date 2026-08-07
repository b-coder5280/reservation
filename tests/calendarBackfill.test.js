import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureBackfillReservationId,
  eventNeedsUpdate,
  getBackfillAction,
  processBackfillReservation,
} from '../api/_lib/calendarBackfill.js';
import {
  SPELL_RESERVATION_SOURCE,
  buildReservationEventResource,
  getReservationEventTimes,
  getReservationKey,
} from '../api/_lib/googleCalendar.js';
import {
  CALENDAR_SYNC_STATUS,
  claimCancellation,
  removeReservationById,
} from '../api/_lib/reservationState.js';

const NOW = new Date('2026-08-07T00:00:00+09:00');
const EVENT_COLORS = {
  1: { background: '#a4bdfc' },
  2: { background: '#7ae7bf' },
  3: { background: '#dbadff' },
  4: { background: '#ff887c' },
  5: { background: '#fbd75b' },
  6: { background: '#ffb878' },
  7: { background: '#46d6db' },
  8: { background: '#e1e1e1' },
  9: { background: '#5484ed' },
  10: { background: '#51b749' },
  11: { background: '#dc2127' },
};

class FakeSlotRef {
  constructor(value) {
    this.value = value;
  }

  async transaction(callback) {
    const initial = callback(null);
    if (initial === undefined) {
      return { committed: false, snapshot: { val: () => this.value } };
    }

    const next = callback(this.value);
    if (next === undefined) {
      return { committed: false, snapshot: { val: () => this.value } };
    }

    this.value = next;
    return { committed: true, snapshot: { val: () => this.value } };
  }
}

class FakeCalendar {
  constructor(events = []) {
    this.eventsById = new Map(events.map((event) => [event.id, { ...event }]));
    this.insertCount = 0;
    this.patchCount = 0;
    this.nextId = 1;
    this.colors = {
      get: async () => ({ data: { event: EVENT_COLORS } }),
    };
    this.events = {
      get: async ({ eventId }) => {
        const event = this.eventsById.get(eventId);
        if (!event) {
          const error = new Error('not found');
          error.code = 404;
          throw error;
        }
        return { data: { ...event } };
      },
      list: async ({ privateExtendedProperty = [] }) => {
        const predicates = privateExtendedProperty.map((property) => property.split('='));
        const items = Array.from(this.eventsById.values()).filter((event) => {
          const privateProperties = event.extendedProperties?.private || {};
          return predicates.every(([key, value]) => privateProperties[key] === value);
        });
        return { data: { items } };
      },
      insert: async ({ requestBody }) => {
        const id = `event-${this.nextId}`;
        this.nextId += 1;
        this.insertCount += 1;
        const event = { id, status: 'confirmed', ...requestBody };
        this.eventsById.set(id, event);
        return { data: event };
      },
      patch: async ({ eventId, requestBody }) => {
        const current = this.eventsById.get(eventId);
        const event = { ...current, ...requestBody, id: eventId, status: current?.status || 'confirmed' };
        this.patchCount += 1;
        this.eventsById.set(eventId, event);
        return { data: event };
      },
    };
  }
}

function existingEvent({ id = 'existing-1', date = '2026-08-08', time = '09:00', name = 'Tester', reservationId = 'rid-1', colorId = '1' } = {}) {
  return {
    id,
    status: 'confirmed',
    ...buildReservationEventResource({ date, time, name, reservationId, colorId }),
  };
}

test('legacy reservation backfill creates Calendar event and persists Firebase sync', async () => {
  const slotRef = new FakeSlotRef({ name: 'Tester', password: 'pw' });
  const calendar = new FakeCalendar();
  const result = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  assert.equal(result.action, 'CREATE');
  assert.equal(calendar.insertCount, 1);
  assert.equal(slotRef.value.calendarSyncStatus, CALENDAR_SYNC_STATUS.SYNCED);
  assert.ok(slotRef.value.reservationId);
  assert.ok(slotRef.value.calendarEventId);
});

test('already synced reservation remains idempotent and creates no duplicate', async () => {
  const event = existingEvent({ colorId: '1' });
  const calendar = new FakeCalendar([event]);
  const slotRef = new FakeSlotRef({
    name: 'Tester',
    password: 'pw',
    reservationId: 'rid-1',
    calendarEventId: event.id,
    calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
  });

  const first = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });
  const second = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  assert.equal(first.action, 'UPDATE');
  assert.equal(second.action, 'ALREADY_SYNCED');
  assert.equal(calendar.insertCount, 0);
});

test('second production deployment produces zero duplicate Calendar events', async () => {
  const calendar = new FakeCalendar();
  const slotRef = new FakeSlotRef({ name: 'Tester', password: 'pw' });

  await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  const second = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  assert.equal(second.action, 'ALREADY_SYNCED');
  assert.equal(calendar.insertCount, 1);
  assert.equal(calendar.eventsById.size, 1);
});

test('Calendar event exists but Firebase calendarEventId is missing gets recovered', async () => {
  const event = existingEvent({ id: 'recover-1', reservationId: 'rid-1' });
  const calendar = new FakeCalendar([event]);
  const slotRef = new FakeSlotRef({
    name: 'Tester',
    password: 'pw',
    reservationId: 'rid-1',
  });

  const result = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  assert.equal(result.action, 'RECOVER');
  assert.equal(slotRef.value.calendarEventId, 'recover-1');
  assert.equal(calendar.insertCount, 0);
});

test('existing Calendar event with wrong color gets updated', async () => {
  const event = existingEvent({ id: 'wrong-color-1', colorId: '11' });
  const calendar = new FakeCalendar([event]);
  const slotRef = new FakeSlotRef({
    name: 'Tester',
    password: 'pw',
    reservationId: 'rid-1',
    calendarEventId: event.id,
    calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
  });

  const result = await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  assert.equal(result.action, 'UPDATE');
  assert.equal(calendar.patchCount, 1);
  assert.notEqual(calendar.eventsById.get(event.id).colorId, '11');
});

test('21:00 backfill event ends at next-day 00:00', () => {
  const eventTimes = getReservationEventTimes({ date: '2026-08-08', time: '21:00' });

  assert.equal(eventTimes.start.dateTime, '2026-08-08T21:00:00');
  assert.equal(eventTimes.end.dateTime, '2026-08-09T00:00:00');
});

test('backfilled reservation can be cancelled by reservationId and password', async () => {
  const slotRef = new FakeSlotRef({ name: 'Tester', password: 'pw' });
  const calendar = new FakeCalendar();
  await processBackfillReservation({
    calendar,
    calendarId: 'calendar-id',
    slotRef,
    date: '2026-08-08',
    time: '09:00',
    reservation: slotRef.value,
    now: NOW,
  });

  const claimed = claimCancellation(slotRef.value, {
    password: 'pw',
    reservationId: slotRef.value.reservationId,
    nowMs: Date.now(),
  });

  assert.equal(claimed.calendarSyncStatus, CALENDAR_SYNC_STATUS.CANCELLING);
  assert.equal(removeReservationById(claimed, slotRef.value.reservationId), null);
});

test('slot replaced while backfill is running is not overwritten', async () => {
  const initial = { name: 'Tester', password: 'pw' };
  const slotRef = new FakeSlotRef({
    name: 'Other',
    password: 'pw2',
    reservationId: 'replacement-rid',
  });

  const normalized = await ensureBackfillReservationId(slotRef, initial, 'new-rid', Date.now());

  assert.equal(normalized, null);
  assert.equal(slotRef.value.reservationId, 'replacement-rid');
});

test('backfill action reports skip for missing name', () => {
  assert.equal(getBackfillAction({ reservation: {}, existingEvent: null, desiredEvent: {} }), 'SKIP');
});

test('event update detects missing extended properties', () => {
  const desired = buildReservationEventResource({
    date: '2026-08-08',
    time: '09:00',
    name: 'Tester',
    reservationId: 'rid-1',
    colorId: '1',
  });
  const event = {
    id: 'event-1',
    summary: desired.summary,
    start: desired.start,
    end: desired.end,
    colorId: desired.colorId,
    extendedProperties: { private: { source: SPELL_RESERVATION_SOURCE, reservationKey: getReservationKey('2026-08-08', '09:00') } },
  };

  assert.equal(eventNeedsUpdate(event, desired), true);
});
