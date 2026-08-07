import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getReservationColorIndex,
  getWebsiteColorForName,
  normalizeReservationName,
} from '../src/shared/nameColors.js';
import { getCalendarColorIdForNameFromEventColors } from '../api/_lib/googleCalendar.js';

const EVENT_COLORS = {
  1: { background: '#a4bdfc' },
  2: { background: '#7ae7bf' },
  3: { background: '#dbadff' },
  4: { background: '#ff887c' },
  5: { background: '#fbd75b' },
  6: { background: '#ffb878' },
  7: { background: '#46d6db' },
  8: { background: '#e1e1e1' },
  9: { background: '#5484ed' },
  10: { background: '#51b749' },
  11: { background: '#dc2127' },
};

test('same exact name on different days gets the same website color', () => {
  const mondayColor = getWebsiteColorForName('Kim Test');
  const fridayColor = getWebsiteColorForName('Kim Test');

  assert.equal(mondayColor, fridayColor);
});

test('same exact name gets the same Calendar colorId', () => {
  const first = getCalendarColorIdForNameFromEventColors('Kim Test', EVENT_COLORS);
  const second = getCalendarColorIdForNameFromEventColors('Kim Test', EVENT_COLORS);

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
