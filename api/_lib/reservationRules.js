export const TIMES = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];

const RESTRICTED_TIMES = ['09:00', '12:00', '15:00'];
const RESTRICTED_DAYS = [1, 2, 3, 4, 5];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getKstWallDate(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds(),
  ));
}

function parseDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function getWallDate(dateStr, time = '00:00') {
  const parsed = parseDate(dateStr);
  if (!parsed) return null;

  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, hours, minutes, 0, 0));
}

function getLocalDateString(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function getBookingWindow({ hasEarlyAccess = false, now = new Date() } = {}) {
  const current = getKstWallDate(now);
  const day = current.getUTCDay();
  const totalMinutes = current.getUTCHours() * 60 + current.getUTCMinutes();
  const openMinutes = hasEarlyAccess ? (11 * 60 + 40) : (12 * 60);

  const start = new Date(current);
  start.setUTCHours(hasEarlyAccess ? 11 : 12, hasEarlyAccess ? 40 : 0, 0, 0);

  let diff = day - 2;
  if (diff < 0) diff += 7;
  if (day === 2 && totalMinutes < openMinutes) {
    diff = 7;
  }

  start.setUTCDate(start.getUTCDate() - diff);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  end.setUTCHours(21, 0, 0, 0);

  const reservableStart = new Date(start);
  reservableStart.setUTCDate(reservableStart.getUTCDate() + 1);
  reservableStart.setUTCHours(0, 0, 0, 0);

  return {
    start,
    end,
    isOpen: current >= start && current <= end,
    reservableStart,
    reservableEnd: end,
  };
}

export function validateReservationInput({ date, time, name, password }) {
  const errors = {};

  if (!parseDate(date)) errors.date = 'Invalid date.';
  if (!TIMES.includes(time)) errors.time = 'Invalid reservation time.';
  if (typeof name !== 'string' || !name.trim()) errors.name = 'Name is required.';
  if (typeof password !== 'string' || !password.trim()) errors.password = 'Password is required.';

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    values: {
      date,
      time,
      name: typeof name === 'string' ? name.trim() : '',
      password: typeof password === 'string' ? password : '',
    },
  };
}

export function validateCancellationInput({ date, time, password }) {
  const errors = {};

  if (!parseDate(date)) errors.date = 'Invalid date.';
  if (!TIMES.includes(time)) errors.time = 'Invalid reservation time.';
  if (typeof password !== 'string' || !password.trim()) errors.password = 'Password is required.';

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    values: {
      date,
      time,
      password: typeof password === 'string' ? password : '',
    },
  };
}

export function isSlotReservable(date, time, hasEarlyAccess) {
  const bookingWindow = getBookingWindow({ hasEarlyAccess });
  const slotTime = getWallDate(date, time);

  return Boolean(
    slotTime &&
    bookingWindow.isOpen &&
    slotTime >= bookingWindow.reservableStart &&
    slotTime <= bookingWindow.reservableEnd
  );
}

export function exceedsWeeklyRestrictedLimit({ reservations, bookingWindow, name }) {
  let count = 0;
  const currentSearch = new Date(bookingWindow.reservableStart);
  const trimmedName = name.trim();

  while (currentSearch <= bookingWindow.reservableEnd) {
    const day = currentSearch.getUTCDay();
    const dateStr = getLocalDateString(currentSearch);
    const dayReservations = reservations?.[dateStr];

    if (RESTRICTED_DAYS.includes(day) && dayReservations) {
      RESTRICTED_TIMES.forEach((restrictedTime) => {
        if (dayReservations[restrictedTime]?.name?.trim() === trimmedName) {
          count += 1;
        }
      });
    }

    currentSearch.setUTCDate(currentSearch.getUTCDate() + 1);
  }

  return count > 3;
}

export function isRestrictedSlot(date, time) {
  const slotTime = getWallDate(date, time);
  return Boolean(slotTime && RESTRICTED_TIMES.includes(time) && RESTRICTED_DAYS.includes(slotTime.getUTCDay()));
}
