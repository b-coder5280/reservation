import { getAdminDb } from './_lib/firebaseAdmin.js';
import { Buffer } from 'node:buffer';
import { createReservationEvent, deleteReservationEvent } from './_lib/googleCalendar.js';
import {
  exceedsWeeklyRestrictedLimit,
  getBookingWindow,
  isRestrictedSlot,
  isSlotReservable,
  validateReservationInput,
} from './_lib/reservationRules.js';

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

async function rollbackCreatedReservation(slotRef, reservation) {
  const result = await slotRef.transaction((current) => {
    if (
      current &&
      current.name === reservation.name &&
      current.password === reservation.password &&
      !current.calendarEventId
    ) {
      return null;
    }
    return undefined;
  }, undefined, false);

  return result.committed;
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
  const validation = validateReservationInput(body);
  if (!validation.isValid) {
    return send(res, 400, { error: 'Invalid reservation request.', fields: validation.errors });
  }

  const { date, time, name, password } = validation.values;
  if (!isSlotReservable(date, time, hasEarlyAccess)) {
    return send(res, 403, { error: 'This slot is not currently reservable.' });
  }

  const db = getAdminDb();
  const slotRef = db.ref(`reservations/${date}/${time}`);
  const reservation = { name, password };

  let transactionResult;
  try {
    transactionResult = await slotRef.transaction((current) => {
      if (current === null) return reservation;
      return undefined;
    }, undefined, false);
  } catch (error) {
    console.error('Firebase reservation transaction failed:', error);
    return send(res, 500, { error: '예약 저장 중 오류가 발생했습니다.' });
  }

  if (!transactionResult.committed) {
    return send(res, 409, { error: 'SLOT_TAKEN' });
  }

  try {
    if (isRestrictedSlot(date, time)) {
      const bookingWindow = getBookingWindow({ hasEarlyAccess });
      const reservationsSnapshot = await db.ref('reservations').get();
      const reservations = reservationsSnapshot.val() || {};

      if (exceedsWeeklyRestrictedLimit({ reservations, bookingWindow, name })) {
        const rolledBack = await rollbackCreatedReservation(slotRef, reservation);
        if (!rolledBack) {
          return send(res, 500, { error: 'Over-limit reservation rollback needs manual review.' });
        }
        return send(res, 409, { error: 'OVER_LIMIT' });
      }
    }

    const calendarEventId = await createReservationEvent({ date, time, name });

    const updateResult = await slotRef.transaction((current) => {
      if (
        current &&
        current.name === name &&
        current.password === password &&
        !current.calendarEventId
      ) {
        return { ...current, calendarEventId };
      }
      return undefined;
    }, undefined, false);

    if (!updateResult.committed) {
      await deleteReservationEvent(calendarEventId);
      return send(res, 409, { error: 'Reservation changed before Calendar sync completed.' });
    }

    return send(res, 201, {
      reservation: {
        name,
        calendarEventId,
      },
    });
  } catch (error) {
    console.error('Reservation creation sync failed:', error);
    let rolledBack = false;
    try {
      rolledBack = await rollbackCreatedReservation(slotRef, reservation);
    } catch (rollbackError) {
      console.error('Firebase rollback after Calendar failure failed:', rollbackError);
    }
    if (!rolledBack) {
      return send(res, 502, { error: 'Google Calendar synchronization failed, and Firebase rollback needs manual review.' });
    }
    return send(res, 502, { error: 'Google Calendar synchronization failed. Reservation was not saved.' });
  }
}
