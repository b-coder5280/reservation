import { google } from 'googleapis';

const TIME_ZONE = 'Asia/Seoul';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
  );

  auth.setCredentials({
    refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
  });

  return google.calendar({ version: 'v3', auth });
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

export async function createReservationEvent({ date, time, name }) {
  const calendar = getCalendarClient();
  const calendarId = requireEnv('GOOGLE_CALENDAR_ID');
  const end = addHours(date, time, 3);

  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: `[실험 예약] ${name}`,
      start: {
        dateTime: `${date}T${time}:00`,
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: `${end.date}T${end.time}:00`,
        timeZone: TIME_ZONE,
      },
    },
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
      calendarId: requireEnv('GOOGLE_CALENDAR_ID'),
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
