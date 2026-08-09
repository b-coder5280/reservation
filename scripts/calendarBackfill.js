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
console.log(`Needs reconciliation: ${summary.needsReconciliation}`);
console.log(`${dryRun ? 'Would create' : 'Created'}: ${summary.created}`);
console.log(`${dryRun ? 'Would update' : 'Updated'}: ${summary.updated}`);
console.log(`${dryRun ? 'Would recover' : 'Recovered'}: ${summary.recovered}`);
console.log(`Already synced: ${summary.alreadySynced}`);
console.log(`Malformed: ${summary.malformed}`);
console.log(`Failed: ${summary.failed}`);

const failures = results.filter((result) => result.error && result.action !== 'MALFORMED');
if (failures.length > 0) {
  console.log('');
  console.log('Failures:');
  failures.forEach((failure) => {
    console.log(`${failure.date} | ${failure.time} | ${failure.name} | ${failure.error}`);
  });
  process.exitCode = 1;
}
