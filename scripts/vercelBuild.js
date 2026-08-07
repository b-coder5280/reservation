import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function shouldRunCalendarReconciliation(env = process.env) {
  return env.VERCEL_ENV === 'production';
}

function getNpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNormalBuildCommand() {
  if (process.env.npm_execpath) {
    return runCommand(process.execPath, [process.env.npm_execpath, 'run', 'normal-build']);
  }

  return runCommand(getNpmCommand(), ['run', 'normal-build'], {
    shell: process.platform === 'win32',
  });
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

export function printReconciliationSummary(summary, logger = console) {
  logger.log('Calendar production reconciliation');
  logger.log(`Scanned: ${summary.scanned}`);
  logger.log(`Eligible: ${summary.eligible}`);
  logger.log(`Created: ${summary.created}`);
  logger.log(`Updated: ${summary.updated}`);
  logger.log(`Recovered: ${summary.recovered}`);
  logger.log(`Already synced: ${summary.alreadySynced}`);
  logger.log(`Skipped: ${summary.skipped}`);
  logger.log(`Failed: ${summary.failed}`);
}

async function loadProductionReconciliationResources() {
  const [
    firebaseAdmin,
    googleCalendar,
    calendarBackfill,
  ] = await Promise.all([
    import('../api/_lib/firebaseAdmin.js'),
    import('../api/_lib/googleCalendar.js'),
    import('../api/_lib/calendarBackfill.js'),
  ]);

  return {
    getAdminDb: firebaseAdmin.getAdminDb,
    closeAdminApps: firebaseAdmin.closeAdminApps,
    getCalendarClient: googleCalendar.getCalendarClient,
    runCalendarBackfill: calendarBackfill.runCalendarBackfill,
  };
}

export async function runProductionCalendarReconciliation({
  logger = console,
  loadResources = loadProductionReconciliationResources,
} = {}) {
  const {
    getAdminDb,
    closeAdminApps,
    getCalendarClient,
    runCalendarBackfill,
  } = await loadResources();

  try {
    const { summary, results } = await runCalendarBackfill({
      db: getAdminDb(),
      calendar: getCalendarClient(),
      dryRun: false,
      logger,
    });

    printReconciliationSummary(summary, logger);

    if (summary.failed > 0) {
      const failures = results.filter((result) => result.error);
      failures.forEach((failure) => {
        logger.error(`${failure.date} | ${failure.time} | ${failure.name} | ${failure.error}`);
      });
      throw new Error('Calendar production reconciliation failed.');
    }
  } finally {
    await closeAdminApps();
    logger.log('Calendar reconciliation resources closed.');
  }
}

export async function runVercelBuild({
  env = process.env,
  logger = console,
  runNormalBuild = runNormalBuildCommand,
  runReconciliation = () => runProductionCalendarReconciliation({ logger }),
} = {}) {
  await runNormalBuild();

  if (!shouldRunCalendarReconciliation(env)) {
    logger.log('Skipping Calendar reconciliation: VERCEL_ENV is not production.');
    return;
  }

  await runReconciliation();
  logger.log('Production build complete.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVercelBuild().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
