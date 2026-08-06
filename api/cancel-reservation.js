import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getAdminDb } from './_lib/firebaseAdmin.js';
import { deleteReservationEvent } from './_lib/googleCalendar.js';
import { isSlotReservable, validateCancellationInput } from './_lib/reservationRules.js';

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

async function clearCancelLock(slotRef, cancelToken) {
  await slotRef.transaction((current) => {
    if (current?.canceling === cancelToken) {
      const rest = { ...current };
      delete rest.canceling;
      return rest;
    }
    return undefined;
  }, undefined, false);
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
    return send(res, 400, { error: 'Invalid JSON body.' });
  }

  const hasEarlyAccess = body.hasEarlyAccess === true;
  const validation = validateCancellationInput(body);
  if (!validation.isValid) {
    return send(res, 400, { error: 'Invalid cancellation request.', fields: validation.errors });
  }

  const { date, time, password } = validation.values;
  if (!isSlotReservable(date, time, hasEarlyAccess)) {
    return send(res, 403, { error: 'This slot is not currently cancellable.' });
  }

  const db = getAdminDb();
  const slotRef = db.ref(`reservations/${date}/${time}`);
  const snapshot = await slotRef.get();
  const reservation = snapshot.val();

  if (!reservation) {
    return send(res, 404, { error: 'Reservation not found.' });
  }

  if (reservation.password !== password) {
    return send(res, 403, { error: 'PASSWORD_MISMATCH' });
  }

  const cancelToken = crypto.randomUUID();
  const lockResult = await slotRef.transaction((current) => {
    if (
      current &&
      current.password === password &&
      current.calendarEventId === reservation.calendarEventId &&
      !current.canceling
    ) {
      return { ...current, canceling: cancelToken };
    }
    return undefined;
  }, undefined, false);

  if (!lockResult.committed) {
    return send(res, 409, { error: 'Reservation changed before cancellation could start.' });
  }

  try {
    await deleteReservationEvent(reservation.calendarEventId);
  } catch (error) {
    console.error('Google Calendar deletion failed:', error);
    try {
      await clearCancelLock(slotRef, cancelToken);
    } catch (rollbackError) {
      console.error('Cancellation lock rollback failed:', rollbackError);
    }
    return send(res, 502, { error: 'Google Calendar cancellation failed. Reservation was not removed.' });
  }

  const removeResult = await slotRef.transaction((current) => {
    if (current?.canceling === cancelToken) return null;
    return undefined;
  }, undefined, false);

  if (!removeResult.committed) {
    return send(res, 409, { error: 'Calendar event was removed, but Firebase reservation removal needs manual review.' });
  }

  return send(res, 200, { cancelled: true });
}
