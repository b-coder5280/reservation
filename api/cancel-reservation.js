import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getAdminDb } from './_lib/firebaseAdmin.js';
import { deleteReservationEvent } from './_lib/googleCalendar.js';
import { isSlotReservable, validateCancellationInput } from './_lib/reservationRules.js';
import {
  claimCancellation,
  normalizeReservationForCancellation,
  removeReservationById,
  restoreSyncedCancellation,
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

async function normalizeForCancellation(slotRef, password, reservationId, nowMs) {
  const result = await slotRef.transaction(
    (current) => normalizeReservationForCancellation(current, { password, reservationId, nowMs }),
    undefined,
    false,
  );

  if (result.committed) {
    return result.snapshot.val();
  }

  return null;
}

async function restoreSyncedIfStillMatching(slotRef, reservationId) {
  const result = await slotRef.transaction(
    (current) => restoreSyncedCancellation(current, reservationId, Date.now()),
    undefined,
    false,
  );

  if (result.committed) return true;

  const snapshot = await slotRef.get();
  const current = snapshot.val();
  return !current || current.reservationId !== reservationId;
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
  const validation = validateCancellationInput(body);
  if (!validation.isValid) {
    return send(res, 400, { error: 'INVALID_REQUEST', fields: validation.errors });
  }

  const { date, time, password } = validation.values;
  if (!isSlotReservable(date, time, hasEarlyAccess)) {
    return send(res, 403, { error: 'SLOT_NOT_CANCELLABLE' });
  }

  const db = getAdminDb();
  const slotRef = db.ref(`reservations/${date}/${time}`);
  const initialSnapshot = await slotRef.get();
  const initialReservation = initialSnapshot.val();

  if (!initialReservation) {
    return send(res, 200, { cancelled: true, alreadyAbsent: true });
  }

  if (initialReservation.password !== password) {
    return send(res, 403, { error: 'PASSWORD_MISMATCH' });
  }

  let reservationId = initialReservation.reservationId || crypto.randomUUID();
  const nowMs = Date.now();
  const normalizedReservation = await normalizeForCancellation(slotRef, password, reservationId, nowMs);

  if (!normalizedReservation) {
    const snapshot = await slotRef.get();
    const current = snapshot.val();
    if (!current) return send(res, 200, { cancelled: true, alreadyAbsent: true });
    if (current.password !== password) return send(res, 403, { error: 'PASSWORD_MISMATCH' });
    return send(res, 409, { error: 'CANCELLATION_CONFLICT' });
  }
  reservationId = normalizedReservation.reservationId;

  const claimResult = await slotRef.transaction(
    (current) => claimCancellation(current, { password, reservationId, nowMs: Date.now() }),
    undefined,
    false,
  );

  if (!claimResult.committed) {
    const snapshot = await slotRef.get();
    const current = snapshot.val();
    if (!current) {
      return send(res, 200, { cancelled: true, alreadyAbsent: true });
    }
    if (current.reservationId !== reservationId) return send(res, 409, { error: 'CANCELLATION_CONFLICT' });
    return send(res, 409, { error: 'SYNC_IN_PROGRESS' });
  }

  const claimedReservation = claimResult.snapshot.val();
  if (!claimedReservation) {
    return send(res, 200, { cancelled: true, alreadyAbsent: true });
  }
  if (claimedReservation.reservationId !== reservationId) {
    return send(res, 409, { error: 'CANCELLATION_CONFLICT' });
  }

  console.log('[reservation:cancel] cancellation claimed', { date, time, reservationId });

  if (claimedReservation.calendarEventId) {
    try {
      const deletion = await deleteReservationEvent(claimedReservation.calendarEventId);
      console.log('[reservation:cancel] calendar deleted/already absent', {
        date,
        time,
        reservationId,
        calendarEventId: claimedReservation.calendarEventId,
        alreadyAbsent: deletion.missing,
      });
    } catch (error) {
      console.error('[reservation:cancel] calendar delete failed', {
        date,
        time,
        reservationId,
        calendarEventId: claimedReservation.calendarEventId,
        error: error?.message,
      });

      const restored = await restoreSyncedIfStillMatching(slotRef, reservationId);
      if (!restored) {
        return send(res, 502, { error: 'CANCEL_RECOVERY_REQUIRED' });
      }
      return send(res, 502, { error: 'CALENDAR_DELETE_FAILED' });
    }
  } else {
    console.log('[reservation:cancel] no calendar event to delete', { date, time, reservationId });
  }

  const firebaseRemoved = await removeReservationIfStillMatching(slotRef, reservationId);
  if (!firebaseRemoved) {
    console.error('[reservation:cancel] firebase remove failed', { date, time, reservationId });
    return send(res, 502, { error: 'CANCEL_RECOVERY_REQUIRED' });
  }

  console.log('[reservation:cancel] firebase removed', { date, time, reservationId });
  return send(res, 200, { cancelled: true });
}
