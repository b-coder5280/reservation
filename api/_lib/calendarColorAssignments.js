import { createHash } from 'node:crypto';
import { normalizeReservationName } from '../../src/shared/nameColors.js';

export const CALENDAR_COLOR_PALETTE = ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11'];
export const CALENDAR_COLOR_ASSIGNMENTS_PATH = 'calendarColorAssignments';

function normalizeAssignments(assignments) {
  if (!assignments || typeof assignments !== 'object') return {};
  return assignments;
}

function hashToNumber(value) {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

export function getCalendarColorAssignmentKey(name) {
  const normalizedName = normalizeReservationName(name);
  return createHash('sha256').update(normalizedName || '__empty__').digest('hex');
}

export function chooseCalendarColorId(assignments, assignmentKey) {
  const counts = Object.fromEntries(CALENDAR_COLOR_PALETTE.map((colorId) => [colorId, 0]));

  Object.values(normalizeAssignments(assignments)).forEach((assignment) => {
    const colorId = String(assignment?.colorId || '');
    if (Object.hasOwn(counts, colorId)) counts[colorId] += 1;
  });

  const minimumCount = Math.min(...Object.values(counts));
  const candidates = CALENDAR_COLOR_PALETTE.filter((colorId) => counts[colorId] === minimumCount);
  return candidates[hashToNumber(assignmentKey) % candidates.length];
}

export async function getCalendarColorIdForName({
  db,
  assignmentsRef = db?.ref(CALENDAR_COLOR_ASSIGNMENTS_PATH),
  name,
  dryRun = false,
  nowMs = Date.now(),
}) {
  if (!assignmentsRef) {
    throw new Error('Firebase color assignment ref is required.');
  }

  const assignmentKey = getCalendarColorAssignmentKey(name);

  if (dryRun) {
    const snapshot = await assignmentsRef.get();
    const assignments = normalizeAssignments(snapshot.val());
    return assignments[assignmentKey]?.colorId || chooseCalendarColorId(assignments, assignmentKey);
  }

  const result = await assignmentsRef.transaction((current) => {
    const assignments = normalizeAssignments(current);
    if (assignments[assignmentKey]?.colorId) return assignments;

    return {
      ...assignments,
      [assignmentKey]: {
        colorId: chooseCalendarColorId(assignments, assignmentKey),
        createdAt: nowMs,
      },
    };
  }, undefined, false);

  const colorId = result.snapshot.val()?.[assignmentKey]?.colorId;
  if (!result.committed || !colorId) {
    throw new Error('Calendar color assignment failed.');
  }

  return colorId;
}
