import crypto from 'node:crypto';
import {
  buildReservationEventResource,
  getCalendarId,
  getReservationKey,
  getReservationEventTimes,
  SPELL_RESERVATION_SOURCE,
} from './googleCalendar.js';
import { getCalendarColorIdForName } from './calendarColorAssignments.js';
import { CALENDAR_SYNC_STATUS, CALENDAR_SYNC_VERSION } from './reservationState.js';
import { getWebsiteColorForName } from '../../src/shared/nameColors.js';

const VALID_TIMES = new Set(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getPrivateProperties(event) {
  return event?.extendedProperties?.private || {};
}

function isNotFoundError(error) {
  return error?.code === 404 || error?.response?.status === 404 || error?.code === 410 || error?.response?.status === 410;
}

function sameEventDateTime(left, right) {
  return left?.dateTime === right?.dateTime && left?.timeZone === right?.timeZone;
}

export function isValidBackfillDate(date) {
  if (!DATE_PATTERN.test(date)) return false;

  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isEligibleBackfillSlot(date, time) {
  return isValidBackfillDate(date) && VALID_TIMES.has(time);
}

export function validateBackfillRow({ date, time, reservation }) {
  if (!isValidBackfillDate(date)) return { isValid: false, reason: 'Invalid reservation date.' };
  if (!VALID_TIMES.has(time)) return { isValid: false, reason: 'Invalid reservation time slot.' };
  if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) {
    return { isValid: false, reason: 'Invalid reservation record structure.' };
  }
  if (!reservation.name || typeof reservation.name !== 'string') {
    return { isValid: false, reason: 'Missing reservation name.' };
  }
  return { isValid: true };
}

export function flattenReservations(reservations) {
  const rows = [];

  Object.entries(reservations || {}).forEach(([date, slots]) => {
    Object.entries(slots || {}).forEach(([time, reservation]) => {
      rows.push({ date, time, reservation });
    });
  });

  return rows.sort((left, right) => `${left.date}_${left.time}`.localeCompare(`${right.date}_${right.time}`));
}

export function eventNeedsUpdate(event, desiredEvent) {
  const privateProperties = getPrivateProperties(event);
  const desiredPrivate = desiredEvent.extendedProperties.private;

  return !(
    event?.summary === desiredEvent.summary &&
    sameEventDateTime(event?.start, desiredEvent.start) &&
    sameEventDateTime(event?.end, desiredEvent.end) &&
    event?.colorId === desiredEvent.colorId &&
    privateProperties.source === desiredPrivate.source &&
    privateProperties.reservationKey === desiredPrivate.reservationKey &&
    privateProperties.reservationId === desiredPrivate.reservationId
  );
}

export function getBackfillAction({ reservation, existingEvent, desiredEvent }) {
  if (!reservation?.name) return 'MALFORMED';
  if (!existingEvent) return 'CREATE';
  if (!reservation.calendarEventId || reservation.calendarEventId !== existingEvent.id) return 'RECOVER';
  if (eventNeedsUpdate(existingEvent, desiredEvent)) return 'UPDATE';
  return 'ALREADY_SYNCED';
}

export function isCurrentCalendarSync(reservation) {
  return Boolean(
    reservation?.calendarSyncStatus === CALENDAR_SYNC_STATUS.SYNCED &&
    reservation.calendarEventId &&
    reservation.calendarSyncVersion === CALENDAR_SYNC_VERSION
  );
}

export async function findExistingReservationEvent({ calendar, calendarId, date, time, calendarEventId }) {
  if (calendarEventId) {
    try {
      const response = await calendar.events.get({ calendarId, eventId: calendarEventId });
      if (response.data?.status !== 'cancelled') return response.data;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  const reservationKey = getReservationKey(date, time);
  const response = await calendar.events.list({
    calendarId,
    privateExtendedProperty: [
      `source=${SPELL_RESERVATION_SOURCE}`,
      `reservationKey=${reservationKey}`,
    ],
    maxResults: 10,
    singleEvents: false,
  });

  return (response.data.items || []).find((event) => event.status !== 'cancelled') || null;
}

export async function upsertBackfillCalendarEvent({
  calendar,
  calendarId,
  assignmentsRef,
  date,
  time,
  reservation,
  reservationId,
  dryRun = false,
}) {
  const colorId = await getCalendarColorIdForName({ assignmentsRef, name: reservation.name, dryRun });
  const desiredEvent = buildReservationEventResource({
    date,
    time,
    name: reservation.name,
    reservationId,
    colorId,
  });
  const existingEvent = await findExistingReservationEvent({
    calendar,
    calendarId,
    date,
    time,
    calendarEventId: reservation.calendarEventId,
  });
  const action = getBackfillAction({ reservation, existingEvent, desiredEvent });

  if (dryRun) {
    return { action, eventId: existingEvent?.id || null, desiredEvent, existingEvent };
  }

  if (existingEvent) {
    if (eventNeedsUpdate(existingEvent, desiredEvent)) {
      const response = await calendar.events.patch({
        calendarId,
        eventId: existingEvent.id,
        requestBody: desiredEvent,
      });
      return { action, eventId: response.data.id || existingEvent.id, desiredEvent, existingEvent: response.data };
    }

    return { action, eventId: existingEvent.id, desiredEvent, existingEvent };
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody: desiredEvent,
  });

  return { action, eventId: response.data.id, desiredEvent, existingEvent: response.data };
}

function sameLegacyReservation(current, initialReservation) {
  return Boolean(
    current &&
    current.name === initialReservation.name &&
    current.password === initialReservation.password &&
    current.calendarEventId === initialReservation.calendarEventId &&
    (
      initialReservation.calendarSyncStatus === undefined ||
      current.calendarSyncStatus === initialReservation.calendarSyncStatus
    )
  );
}

export async function ensureBackfillReservationId(slotRef, initialReservation, reservationId, nowMs = Date.now()) {
  if (initialReservation.reservationId) return initialReservation;

  const result = await slotRef.transaction((current) => {
    if (current === null) return null;
    if (current.reservationId === reservationId) return current;
    if (current.reservationId && sameLegacyReservation(current, initialReservation)) return current;
    if (!current.reservationId && sameLegacyReservation(current, initialReservation)) {
      return {
        ...current,
        reservationId,
        calendarSyncStatus: current.calendarSyncStatus || CALENDAR_SYNC_STATUS.CREATING,
        createdAt: current.createdAt || nowMs,
        syncUpdatedAt: nowMs,
      };
    }
    return undefined;
  }, undefined, false);

  return result.committed ? result.snapshot.val() : null;
}

export async function persistBackfillSync(slotRef, reservationId, calendarEventId, nowMs = Date.now()) {
  const result = await slotRef.transaction((current) => {
    if (current === null) return null;
    if (current.reservationId !== reservationId) return undefined;

    return {
      ...current,
      calendarEventId,
      calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
      calendarSyncVersion: CALENDAR_SYNC_VERSION,
      createdAt: current.createdAt || nowMs,
      syncUpdatedAt: nowMs,
    };
  }, undefined, false);

  return result.committed && result.snapshot.val()?.reservationId === reservationId;
}

export async function processBackfillReservation({
  calendar,
  calendarId,
  assignmentsRef,
  slotRef,
  date,
  time,
  reservation,
  dryRun = false,
}) {
  const websiteColor = getWebsiteColorForName(reservation?.name);
  const validation = validateBackfillRow({ date, time, reservation });

  if (!validation.isValid) {
    return {
      date,
      time,
      name: reservation?.name || '',
      websiteColor,
      calendarColorId: '',
      action: 'MALFORMED',
      error: validation.reason,
    };
  }

  if (isCurrentCalendarSync(reservation)) {
    return {
      date,
      time,
      name: reservation.name,
      websiteColor,
      calendarColorId: '',
      action: 'ALREADY_SYNCED',
    };
  }

  const reservationId = reservation.reservationId || crypto.randomUUID();
  const activeReservation = dryRun
    ? { ...reservation, reservationId }
    : await ensureBackfillReservationId(slotRef, reservation, reservationId);

  if (!activeReservation) {
    return {
      date,
      time,
      name: reservation.name,
      websiteColor,
      calendarColorId: '',
      action: 'FAILED',
      error: 'Reservation changed before backfill could claim identity.',
    };
  }

  const eventResult = await upsertBackfillCalendarEvent({
    calendar,
    calendarId,
    assignmentsRef,
    date,
    time,
    reservation: activeReservation,
    reservationId: activeReservation.reservationId,
    dryRun,
  });
  const calendarColorId = eventResult.desiredEvent.colorId;

  if (!dryRun && eventResult.eventId) {
    const persisted = await persistBackfillSync(slotRef, activeReservation.reservationId, eventResult.eventId);
    if (!persisted) {
      return {
        date,
        time,
        name: activeReservation.name,
        websiteColor,
        calendarColorId,
        action: eventResult.action,
        error: 'Calendar event synced but Firebase persistence failed.',
      };
    }
  }

  return {
    date,
    time,
    name: activeReservation.name,
    websiteColor,
    calendarColorId,
    action: eventResult.action,
    eventId: eventResult.eventId,
  };
}

async function processWithConcurrency(rows, concurrency, worker) {
  const results = new Array(rows.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(rows[index]);
    }
  }

  const workerCount = Math.min(concurrency, rows.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function runCalendarBackfill({ db, calendar, dryRun = false, logger = console }) {
  const calendarId = getCalendarId();
  const assignmentsRef = db.ref('calendarColorAssignments');

  const snapshot = await db.ref('reservations').get();
  const rows = flattenReservations(snapshot.val() || {});
  const results = [];
  const summary = {
    scanned: rows.length,
    needsReconciliation: 0,
    created: 0,
    updated: 0,
    recovered: 0,
    alreadySynced: 0,
    malformed: 0,
    failed: 0,
  };

  const rowsToProcess = [];

  for (const row of rows) {
    const validation = validateBackfillRow(row);

    if (!validation.isValid) {
      const malformed = {
        date: row.date,
        time: row.time,
        name: row.reservation?.name || '',
        websiteColor: getWebsiteColorForName(row.reservation?.name),
        calendarColorId: '',
        action: 'MALFORMED',
        error: validation.reason,
      };
      summary.malformed += 1;
      results.push(malformed);
      logger.error(`${malformed.date} | ${malformed.time} | ${malformed.name} | ${malformed.websiteColor} | ${malformed.calendarColorId} | MALFORMED | ${malformed.error}`);
    } else if (isCurrentCalendarSync(row.reservation)) {
      const alreadySynced = {
        date: row.date,
        time: row.time,
        name: row.reservation.name,
        websiteColor: getWebsiteColorForName(row.reservation.name),
        calendarColorId: '',
        action: 'ALREADY_SYNCED',
      };
      summary.alreadySynced += 1;
      results.push(alreadySynced);
      logger.log(`${alreadySynced.date} | ${alreadySynced.time} | ${alreadySynced.name} | ${alreadySynced.websiteColor} | ${alreadySynced.calendarColorId} | ${alreadySynced.action}`);
    } else {
      summary.needsReconciliation += 1;
      rowsToProcess.push(row);
    }
  }

  const processedResults = await processWithConcurrency(rowsToProcess, 4, async (row) => {
    try {
      const slotRef = db.ref(`reservations/${row.date}/${row.time}`);
      return await processBackfillReservation({
        calendar,
        calendarId,
        assignmentsRef,
        slotRef,
        date: row.date,
        time: row.time,
        reservation: row.reservation,
        dryRun,
      });
    } catch (error) {
      return {
        date: row.date,
        time: row.time,
        name: row.reservation?.name || '',
        websiteColor: getWebsiteColorForName(row.reservation?.name),
        calendarColorId: '',
        action: 'FAILED',
        error: error?.message || 'Unknown error',
      };
    }
  });

  processedResults.forEach((result) => {
    if (result.action === 'CREATE') summary.created += 1;
    if (result.action === 'UPDATE') summary.updated += 1;
    if (result.action === 'RECOVER') summary.recovered += 1;
    if (result.action === 'ALREADY_SYNCED') summary.alreadySynced += 1;
    if (result.action === 'MALFORMED') summary.malformed += 1;
    if (result.error && result.action !== 'MALFORMED') summary.failed += 1;
    results.push(result);

    const resultAction = result.action === 'MALFORMED' ? 'MALFORMED' : result.error ? 'FAILED' : result.action;
    const line = `${result.date} | ${result.time} | ${result.name} | ${result.websiteColor} | ${result.calendarColorId} | ${resultAction}${result.error ? ` | ${result.error}` : ''}`;
    if (result.error) logger.error(line);
    else logger.log(line);
  });

  return { results, summary };
}

export { getReservationEventTimes };
