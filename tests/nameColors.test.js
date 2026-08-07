import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getReservationColorIndex,
  getWebsiteColorForName,
  normalizeReservationName,
} from '../src/shared/nameColors.js';
import {
  CALENDAR_COLOR_PALETTE,
  getCalendarColorIdForName,
} from '../api/_lib/calendarColorAssignments.js';

class FakeAssignmentsRef {
  constructor(value = null) {
    this.value = value;
  }

  async get() {
    return { val: () => this.value };
  }

  async transaction(callback) {
    const initial = callback(null);
    if (initial === undefined) {
      return { committed: false, snapshot: { val: () => this.value } };
    }

    const next = callback(this.value);
    if (next === undefined) {
      return { committed: false, snapshot: { val: () => this.value } };
    }

    this.value = next;
    return { committed: true, snapshot: { val: () => this.value } };
  }
}

test('same exact name on different days gets the same website color', () => {
  const mondayColor = getWebsiteColorForName('Kim Test');
  const fridayColor = getWebsiteColorForName('Kim Test');

  assert.equal(mondayColor, fridayColor);
});

test('same normalized name gets the same Calendar colorId', async () => {
  const assignmentsRef = new FakeAssignmentsRef();
  const first = await getCalendarColorIdForName({ assignmentsRef, name: ' Kim Test ' });
  const second = await getCalendarColorIdForName({ assignmentsRef, name: 'kim test' });

  assert.equal(first, second);
});

test('name colors are deterministic across module reload shape', async () => {
  const first = getReservationColorIndex('Stable Name');
  const moduleUrl = new URL('../src/shared/nameColors.js?restart-check', import.meta.url);
  const reloaded = await import(moduleUrl.href);

  assert.equal(first, reloaded.getReservationColorIndex('Stable Name'));
});

test('different normalized names can receive different stable colors', () => {
  assert.equal(normalizeReservationName(' Alice '), 'alice');
  assert.notEqual(getWebsiteColorForName('Alice'), getWebsiteColorForName('Bob'));
});

test('no normal reservation receives Google Calendar gray colorId 8', async () => {
  const assignmentsRef = new FakeAssignmentsRef();

  for (const name of ['Alice', 'Bob', 'Charlie', 'Dana', 'Eunji', '민수', '지혜', '현우']) {
    const colorId = await getCalendarColorIdForName({ assignmentsRef, name });
    assert.notEqual(colorId, '8');
    assert.ok(CALENDAR_COLOR_PALETTE.includes(colorId));
  }
});

test('first several different names receive different Calendar colors while available', async () => {
  const assignmentsRef = new FakeAssignmentsRef();
  const colors = [];

  for (const name of ['Alice', 'Bob', 'Charlie', 'Dana', 'Eunji', 'Felix']) {
    colors.push(await getCalendarColorIdForName({ assignmentsRef, name }));
  }

  assert.equal(new Set(colors).size, colors.length);
});

test('Calendar color assignments persist through a process restart shape', async () => {
  const firstRef = new FakeAssignmentsRef();
  const first = await getCalendarColorIdForName({ assignmentsRef: firstRef, name: 'Persistent Name' });
  const restartedRef = new FakeAssignmentsRef(firstRef.value);
  const second = await getCalendarColorIdForName({ assignmentsRef: restartedRef, name: 'persistent name' });

  assert.equal(first, second);
});
