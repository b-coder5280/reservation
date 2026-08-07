import { google } from 'googleapis';
import {
  DISTINCT_COLORS,
  getReservationColorIndex,
} from '../../src/shared/nameColors.js';

const TIME_ZONE = 'Asia/Seoul';
export const SPELL_RESERVATION_SOURCE = 'spell-reservation';

let calendarEventColorsPromise;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
  );

  auth.setCredentials({
    refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
  });

  return google.calendar({ version: 'v3', auth });
}

export function getCalendarId() {
  return requireEnv('GOOGLE_CALENDAR_ID');
}

function addHours(dateStr, time, hoursToAdd) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
  date.setUTCHours(date.getUTCHours() + hoursToAdd);

  const endDate = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const endTime = [
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
  ].join(':');

  return { date: endDate, time: endTime };
}

export function getReservationEventTimes({ date, time }) {
  const end = addHours(date, time, 3);

  return {
    start: {
      dateTime: `${date}T${time}:00`,
      timeZone: TIME_ZONE,
    },
    end: {
      dateTime: `${end.date}T${end.time}:00`,
      timeZone: TIME_ZONE,
    },
  };
}

export function getReservationKey(date, time) {
  return `${date}_${time}`;
}

function parseHexColor(hexColor) {
  const normalized = String(hexColor || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function colorDistance(leftHex, rightHex) {
  const left = parseHexColor(leftHex);
  const right = parseHexColor(rightHex);
  if (!left || !right) return Number.POSITIVE_INFINITY;

  return ((left.r - right.r) ** 2) + ((left.g - right.g) ** 2) + ((left.b - right.b) ** 2);
}

export function getClosestCalendarColorId(websiteColor, eventColors) {
  return Object.entries(eventColors || {})
    .map(([colorId, color]) => ({
      colorId,
      distance: colorDistance(websiteColor, color.background),
    }))
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return Number(left.colorId) - Number(right.colorId);
    })[0]?.colorId || '1';
}

export function buildWebsiteToCalendarColorMap(eventColors) {
  return DISTINCT_COLORS.map((websiteColor) => getClosestCalendarColorId(websiteColor, eventColors));
}

export function getCalendarColorIdForNameFromEventColors(name, eventColors) {
  const colorMap = buildWebsiteToCalendarColorMap(eventColors);
  return colorMap[getReservationColorIndex(name)] || '1';
}

export async function getCalendarEventColors(calendar = getCalendarClient()) {
  if (!calendarEventColorsPromise) {
    calendarEventColorsPromise = calendar.colors.get().then((response) => response.data.event || {});
  }

  return calendarEventColorsPromise;
}

export async function getCalendarColorIdForName(name, calendar = getCalendarClient()) {
  const eventColors = await getCalendarEventColors(calendar);
  return getCalendarColorIdForNameFromEventColors(name, eventColors);
}

export function buildReservationEventResource({ date, time, name, reservationId, colorId }) {
  const eventTimes = getReservationEventTimes({ date, time });

  return {
    summary: `[실험 예약] ${name}`,
    start: eventTimes.start,
    end: eventTimes.end,
    colorId,
    extendedProperties: {
      private: {
        source: SPELL_RESERVATION_SOURCE,
        reservationKey: getReservationKey(date, time),
        reservationId,
      },
    },
  };
}

export async function createReservationEvent({ date, time, name, reservationId, calendar = getCalendarClient() }) {
  const calendarId = getCalendarId();
  const colorId = await getCalendarColorIdForName(name, calendar);
  const requestBody = buildReservationEventResource({ date, time, name, reservationId, colorId });

  const response = await calendar.events.insert({
    calendarId,
    requestBody,
  });

  if (!response.data.id) {
    throw new Error('Google Calendar did not return an event ID.');
  }

  return response.data.id;
}

export async function deleteReservationEvent(calendarEventId) {
  if (!calendarEventId) return { deleted: false, missing: true };

  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId: getCalendarId(),
      eventId: calendarEventId,
    });
    return { deleted: true, missing: false };
  } catch (error) {
    if (error?.code === 404 || error?.response?.status === 404 || error?.code === 410 || error?.response?.status === 410) {
      return { deleted: false, missing: true };
    }
    throw error;
  }
}
