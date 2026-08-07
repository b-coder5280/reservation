import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getAdminDb } from './_lib/firebaseAdmin.js';
import { createReservationEvent, deleteReservationEvent } from './_lib/googleCalendar.js';
import {
  exceedsWeeklyRestrictedLimit,
  getBookingWindow,
  isRestrictedSlot,
  isSlotReservable,
  validateReservationInput,
} from './_lib/reservationRules.js';
import {
  canRecoverCalendarBackedStaleReservation,
  claimSlotForCreate,
  makeCreatingReservation,
  persistCalendarSync,
  removeReservationById,
  replaceStaleReservation,
} from './_lib/reservationState.js';

function send(res, status, body) {
  res.status(status).json(body);
}

async function readJson(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function removeReservationIfStillMatching(slotRef, reservationId) {
  const result = await slotRef.transaction((current) => removeReservationById(current, reservationId), undefined, false);
  if (result.committed) return true;

  const snapshot = await slotRef.get();
  const current = snapshot.val();
  return !current || current.reservationId !== reservationId;
}

async function claimSlot(slotRef, reservation, nowMs) {
  const result = await slotRef.transaction((current) => claimSlotForCreate(current, reservation, nowMs), undefined, false);
  if (result.committed) return { claimed: true };

  const snapshot = await slotRef.get();
  const current = snapshot.val();
  return { claimed: false, current };
}

async function recoverStaleCalendarBackedSlot(slotRef, current, replacement, nowMs, date, time) {
  try {
    await deleteReservationEvent(current.calendarEventId);
    console.log('[reservation:create] stale calendar deleted', { date, time, reservationId: current.reservationId });
  } catch (error) {
    console.error('[reservation:create] stale calendar delete failed', {
      date,
      time,
      reservationId: current.reservationId,
      error: error?.message,
    });
    return { claimed: false, error: 'STALE_CALENDAR_DELETE_FAILED' };
  }

  const replaceResult = await slotRef.transaction(
    (latest) => replaceStaleReservation(latest, current, replacement, nowMs),
    undefined,
    false,
  );

  const finalReservation = replaceResult.snapshot.val();
  if (replaceResult.committed && finalReservation === null) {
    return claimSlot(slotRef, replacement, Date.now());
  }

  return {
    claimed: Boolean(replaceResult.committed && finalReservation?.reservationId === replacement.reservationId),
  };
}

function isPersistedCalendarSync(reservation, reservationId, calendarEventId) {
  return Boolean(
    reservation &&
    reservation.reservationId === reservationId &&
    reservation.calendarEventId === calendarEventId &&
    reservation.calendarSyncStatus === 'synced'
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: 'INVALID_JSON' });
  }

  const hasEarlyAccess = body.hasEarlyAccess === true;
  const validation = validateReservationInput(body);
  if (!validation.isValid) {
    return send(res, 400, { error: 'INVALID_REQUEST', fields: validation.errors });
  }

  const { date, time, name, password } = validation.values;
  if (!isSlotReservable(date, time, hasEarlyAccess)) {
    return send(res, 403, { error: 'SLOT_NOT_RESERVABLE' });
  }

  const db = getAdminDb();
  const slotRef = db.ref(`reservations/${date}/${time}`);
  const nowMs = Date.now();
  const reservationId = crypto.randomUUID();
  const reservation = makeCreatingReservation({ name, password, reservationId, nowMs });

  let claimResult;
  try {
    claimResult = await claimSlot(slotRef, reservation, nowMs);

    if (!claimResult.claimed && canRecoverCalendarBackedStaleReservation(claimResult.current, nowMs)) {
      claimResult = await recoverStaleCalendarBackedSlot(slotRef, claimResult.current, reservation, nowMs, date, time);
      if (claimResult.error) {
        return send(res, 502, { error: claimResult.error });
      }
    }
  } catch (error) {
    console.error('[reservation:create] slot claim failed', { date, time, reservationId, error: error?.message });
    return send(res, 500, { error: 'FIREBASE_TRANSACTION_FAILED' });
  }

  if (!claimResult.claimed) {
    return send(res, 409, { error: 'SLOT_TAKEN' });
  }

  console.log('[reservation:create] slot claimed', { date, time, reservationId });

  try {
    if (isRestrictedSlot(date, time)) {
      const bookingWindow = getBookingWindow({ hasEarlyAccess });
      const reservationsSnapshot = await db.ref('reservations').get();
      const reservations = reservationsSnapshot.val() || {};

      if (exceedsWeeklyRestrictedLimit({ reservations, bookingWindow, name })) {
        const rolledBack = await removeReservationIfStillMatching(slotRef, reservationId);
        if (!rolledBack) {
          console.error('[reservation:create] over-limit rollback failed', { date, time, reservationId });
          return send(res, 500, { error: 'CREATE_RECOVERY_REQUIRED' });
        }
        console.log('[reservation:create] over-limit rollback complete', { date, time, reservationId });
        return send(res, 409, { error: 'OVER_LIMIT' });
      }
    }

    let calendarEventId;
    try {
      calendarEventId = await createReservationEvent({ date, time, name, reservationId });
    } catch (error) {
      console.error('[reservation:create] calendar create failed', { date, time, reservationId, error: error?.message });

      const firebaseClean = await removeReservationIfStillMatching(slotRef, reservationId);
      if (!firebaseClean) {
        return send(res, 502, { error: 'CREATE_RECOVERY_REQUIRED' });
      }

      return send(res, 502, { error: 'CALENDAR_CREATE_FAILED' });
    }

    console.log('[reservation:create] calendar created', { date, time, reservationId, calendarEventId });

    let updateResult;
    try {
      const syncNowMs = Date.now();
      updateResult = await slotRef.transaction(
        (current) => persistCalendarSync(current, reservationId, calendarEventId, syncNowMs),
        undefined,
        false,
      );
    } catch (error) {
      console.error('[reservation:create] sync persist transaction failed', {
        date,
        time,
        reservationId,
        calendarEventId,
        error: error?.message,
      });
      updateResult = { committed: false };
    }

    const persistedReservation = updateResult.snapshot?.val();
    if (!updateResult.committed || !isPersistedCalendarSync(persistedReservation, reservationId, calendarEventId)) {
      let calendarDeleted = false;
      let firebaseClean = false;

      try {
        await deleteReservationEvent(calendarEventId);
        calendarDeleted = true;
      } catch (deleteError) {
        console.error('[reservation:create] calendar cleanup failed after persist failure', {
          date,
          time,
          reservationId,
          calendarEventId,
          error: deleteError?.message,
        });
      }

      try {
        firebaseClean = await removeReservationIfStillMatching(slotRef, reservationId);
      } catch (rollbackError) {
        console.error('[reservation:create] firebase cleanup failed after persist failure', {
          date,
          time,
          reservationId,
          calendarEventId,
          error: rollbackError?.message,
        });
      }

      if (!calendarDeleted || !firebaseClean) {
        return send(res, 502, { error: 'CREATE_RECOVERY_REQUIRED' });
      }

      return send(res, 409, { error: 'SYNC_PERSIST_CONFLICT' });
    }

    console.log('[reservation:create] sync persisted', { date, time, reservationId, calendarEventId });

    return send(res, 201, {
      reservation: {
        name,
        reservationId,
        calendarEventId,
        calendarSyncStatus: 'synced',
      },
    });
  } catch (error) {
    console.error('[reservation:create] unexpected create failure', { date, time, reservationId, error: error?.message });
    return send(res, 500, { error: 'CREATE_RECOVERY_REQUIRED' });
  }
}
