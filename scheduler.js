const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const schedule = config.schedule;

if (!schedule || !schedule.enabled) {
  console.error('Scheduler is disabled in config.json (set schedule.enabled = true)');
  process.exit(1);
}

if (!cron.validate(schedule.cron)) {
  console.error(`Invalid cron expression: "${schedule.cron}"`);
  process.exit(1);
}

function runDownload() {
  const now = new Date().toLocaleString('en-AU', { timeZone: schedule.timezone || 'UTC' });
  console.log(`\n[${now}] Starting scheduled download...`);

  const script = path.join(__dirname, 'xero-download.js');
  const child = execFile('node', [script], { cwd: __dirname });

  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));

  child.on('close', code => {
    const done = new Date().toLocaleString('en-AU', { timeZone: schedule.timezone || 'UTC' });
    console.log(`[${done}] Download finished (exit code: ${code})`);
  });
}

console.log('=== Xero Report Scheduler ===');
console.log(`Cron:     ${schedule.cron}`);
console.log(`Timezone: ${schedule.timezone || 'UTC'}`);
console.log('Scheduler running — press Ctrl+C to stop.\n');

if (schedule.test_run_after_seconds) {
  const delay = schedule.test_run_after_seconds * 1000;
  console.log(`Test run scheduled in ${schedule.test_run_after_seconds}s...`);
  setTimeout(runDownload, delay);
}

cron.schedule(schedule.cron, runDownload, {
  timezone: schedule.timezone || 'UTC',
});
