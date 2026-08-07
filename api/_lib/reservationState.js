export const CALENDAR_SYNC_STATUS = {
  CREATING: 'creating',
  SYNCED: 'synced',
  CANCELLING: 'cancelling',
};

export const CALENDAR_SYNC_VERSION = 2;

// Intermediate sync states older than this are considered abandoned and recoverable.
export const STALE_SYNC_TIMEOUT_MS = 5 * 60 * 1000;

export function isStaleIntermediateReservation(reservation, nowMs = Date.now()) {
  if (!reservation) return false;
  if (
    reservation.calendarSyncStatus !== CALENDAR_SYNC_STATUS.CREATING &&
    reservation.calendarSyncStatus !== CALENDAR_SYNC_STATUS.CANCELLING
  ) {
    return false;
  }

  const syncUpdatedAt = Number(reservation.syncUpdatedAt || reservation.createdAt || 0);
  return syncUpdatedAt > 0 && nowMs - syncUpdatedAt > STALE_SYNC_TIMEOUT_MS;
}

export function makeCreatingReservation({ name, password, reservationId, nowMs = Date.now() }) {
  return {
    name,
    password,
    reservationId,
    calendarSyncStatus: CALENDAR_SYNC_STATUS.CREATING,
    createdAt: nowMs,
    syncUpdatedAt: nowMs,
  };
}

export function canClaimSlotForCreate(current, nowMs = Date.now()) {
  if (current === null) return true;
  return isStaleIntermediateReservation(current, nowMs) && !current.calendarEventId;
}

export function canRecoverCalendarBackedStaleReservation(current, nowMs = Date.now()) {
  return Boolean(
    current?.reservationId &&
    current.calendarEventId &&
    isStaleIntermediateReservation(current, nowMs)
  );
}

export function claimSlotForCreate(current, reservation, nowMs = Date.now()) {
  if (canClaimSlotForCreate(current, nowMs)) return reservation;
  return undefined;
}

export function replaceStaleReservation(current, staleReservation, replacement, nowMs = Date.now()) {
  if (current === null) return null;

  if (
    current?.reservationId === staleReservation.reservationId &&
    current.calendarSyncStatus === staleReservation.calendarSyncStatus &&
    current.calendarEventId === staleReservation.calendarEventId &&
    isStaleIntermediateReservation(current, nowMs)
  ) {
    return replacement;
  }

  return undefined;
}

export function persistCalendarSync(current, reservationId, calendarEventId, nowMs = Date.now()) {
  if (current === null) return null;

  if (
    current?.reservationId === reservationId &&
    current.calendarSyncStatus === CALENDAR_SYNC_STATUS.CREATING
  ) {
    return {
      ...current,
      calendarEventId,
      calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
      calendarSyncVersion: CALENDAR_SYNC_VERSION,
      syncUpdatedAt: nowMs,
    };
  }

  return undefined;
}

export function removeReservationById(current, reservationId) {
  if (current === null) return null;
  if (current?.reservationId === reservationId) return null;
  return undefined;
}

export function normalizeReservationForCancellation(current, { password, reservationId, nowMs = Date.now() }) {
  if (current === null) return null;
  if (current.password !== password) return undefined;

  if (current.reservationId) {
    return current;
  }

  return {
    ...current,
    reservationId,
    calendarSyncStatus: current.calendarSyncStatus || CALENDAR_SYNC_STATUS.SYNCED,
    createdAt: current.createdAt || nowMs,
    syncUpdatedAt: nowMs,
  };
}

export function claimCancellation(current, { password, reservationId, nowMs = Date.now() }) {
  if (current === null) return null;

  if (current.password !== password || current.reservationId !== reservationId) {
    return undefined;
  }

  if (
    current.calendarSyncStatus === CALENDAR_SYNC_STATUS.CREATING &&
    !isStaleIntermediateReservation(current, nowMs)
  ) {
    return undefined;
  }

  return {
    ...current,
    calendarSyncStatus: CALENDAR_SYNC_STATUS.CANCELLING,
    syncUpdatedAt: nowMs,
  };
}

export function restoreSyncedCancellation(current, reservationId, nowMs = Date.now()) {
  if (current === null) return null;

  if (
    current?.reservationId === reservationId &&
    current.calendarSyncStatus === CALENDAR_SYNC_STATUS.CANCELLING
  ) {
    return {
      ...current,
      calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
      syncUpdatedAt: nowMs,
    };
  }

  return undefined;
}
