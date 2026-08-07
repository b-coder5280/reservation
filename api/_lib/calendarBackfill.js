import crypto from 'node:crypto';
import {
  buildReservationEventResource,
  getCalendarColorIdForName,
  getCalendarId,
  getCalendarEventColors,
  getReservationKey,
  getReservationEventTimes,
  SPELL_RESERVATION_SOURCE,
} from './googleCalendar.js';
import { CALENDAR_SYNC_STATUS } from './reservationState.js';
import { getWebsiteColorForName } from '../../src/shared/nameColors.js';

const VALID_TIMES = new Set(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);

function slotStartDate(date, time) {
  return new Date(`${date}T${time}:00+09:00`);
}

function getPrivateProperties(event) {
  return event?.extendedProperties?.private || {};
}

function isNotFoundError(error) {
  return error?.code === 404 || error?.response?.status === 404 || error?.code === 410 || error?.response?.status === 410;
}

function sameEventDateTime(left, right) {
  return left?.dateTime === right?.dateTime && left?.timeZone === right?.timeZone;
}

export function isEligibleBackfillSlot(date, time, now = new Date()) {
  if (!VALID_TIMES.has(time)) return false;
  return slotStartDate(date, time) >= now;
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
  if (!reservation?.name) return 'SKIP';
  if (!existingEvent) return 'CREATE';
  if (!reservation.calendarEventId || reservation.calendarEventId !== existingEvent.id) return 'RECOVER';
  if (eventNeedsUpdate(existingEvent, desiredEvent)) return 'UPDATE';
  return 'ALREADY_SYNCED';
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
  date,
  time,
  reservation,
  reservationId,
  dryRun = false,
}) {
  const colorId = await getCalendarColorIdForName(reservation.name, calendar);
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
      createdAt: current.createdAt || nowMs,
      syncUpdatedAt: nowMs,
    };
  }, undefined, false);

  return result.committed && result.snapshot.val()?.reservationId === reservationId;
}

export async function processBackfillReservation({
  calendar,
  calendarId,
  slotRef,
  date,
  time,
  reservation,
  dryRun = false,
  now = new Date(),
}) {
  const websiteColor = getWebsiteColorForName(reservation?.name);

  if (!reservation?.name || !isEligibleBackfillSlot(date, time, now)) {
    return {
      date,
      time,
      name: reservation?.name || '',
      websiteColor,
      calendarColorId: '',
      action: 'SKIP',
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
      action: 'SKIP',
      error: 'Reservation changed before backfill could claim identity.',
    };
  }

  const eventResult = await upsertBackfillCalendarEvent({
    calendar,
    calendarId,
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

export async function runCalendarBackfill({ db, calendar, dryRun = false, now = new Date(), logger = console }) {
  const calendarId = getCalendarId();
  await getCalendarEventColors(calendar);

  const snapshot = await db.ref('reservations').get();
  const rows = flattenReservations(snapshot.val() || {});
  const results = [];
  const summary = {
    scanned: rows.length,
    eligible: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
    alreadySynced: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    if (isEligibleBackfillSlot(row.date, row.time, now)) summary.eligible += 1;

    try {
      const slotRef = db.ref(`reservations/${row.date}/${row.time}`);
      const result = await processBackfillReservation({
        calendar,
        calendarId,
        slotRef,
        date: row.date,
        time: row.time,
        reservation: row.reservation,
        dryRun,
        now,
      });

      if (result.action === 'CREATE') summary.wouldCreate += 1;
      if (result.action === 'UPDATE' || result.action === 'RECOVER') summary.wouldUpdate += 1;
      if (result.action === 'ALREADY_SYNCED') summary.alreadySynced += 1;
      if (result.action === 'SKIP') summary.skipped += 1;
      if (result.error) summary.failed += 1;
      results.push(result);
      logger.log(`${result.date} | ${result.time} | ${result.name} | ${result.websiteColor} | ${result.calendarColorId} | ${result.action}${result.error ? ` | ${result.error}` : ''}`);
    } catch (error) {
      summary.failed += 1;
      const failed = {
        date: row.date,
        time: row.time,
        name: row.reservation?.name || '',
        websiteColor: getWebsiteColorForName(row.reservation?.name),
        calendarColorId: '',
        action: 'SKIP',
        error: error?.message || 'Unknown error',
      };
      results.push(failed);
      logger.error(`${failed.date} | ${failed.time} | ${failed.name} | ${failed.websiteColor} | ${failed.calendarColorId} | FAILED | ${failed.error}`);
    }
  }

  return { results, summary };
}

export { getReservationEventTimes };
