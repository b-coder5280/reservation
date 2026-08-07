import { getAdminDb } from '../api/_lib/firebaseAdmin.js';
import { getCalendarClient } from '../api/_lib/googleCalendar.js';
import { runCalendarBackfill } from '../api/_lib/calendarBackfill.js';

const dryRun = process.argv.includes('--dry-run');

const db = getAdminDb();
const calendar = getCalendarClient();

console.log(dryRun ? 'SPELL Calendar backfill dry run' : 'SPELL Calendar backfill');
console.log('date | time | name | websiteColor | calendarColorId | action');

const { summary, results } = await runCalendarBackfill({
  db,
  calendar,
  dryRun,
  logger: console,
});

console.log('');
console.log(`Scanned: ${summary.scanned}`);
console.log(`Eligible: ${summary.eligible}`);
console.log(`${dryRun ? 'Would create' : 'Created'}: ${summary.wouldCreate}`);
console.log(`${dryRun ? 'Would update' : 'Updated/recovered'}: ${summary.wouldUpdate}`);
console.log(`Already synced: ${summary.alreadySynced}`);
console.log(`Skipped: ${summary.skipped}`);
console.log(`Failed: ${summary.failed}`);

const failures = results.filter((result) => result.error);
if (failures.length > 0) {
  console.log('');
  console.log('Failures:');
  failures.forEach((failure) => {
    console.log(`${failure.date} | ${failure.time} | ${failure.name} | ${failure.error}`);
  });
  process.exitCode = 1;
}
