const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const { authenticator } = require('otplib');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// ─── Load config ────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const BASE_URL = 'https://reporting.xero.com';
const LOGIN_URL = 'https://login.xero.com/identity/user/login';
const COOKIE_FILE = path.join(__dirname, '.xero-session.json');
const STORAGE_FILE = path.join(__dirname, '.xero-localstorage.json');

async function saveSession(context, page) {
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));

  const storage = {};
  for (const origin of ['https://go.xero.com', 'https://login.xero.com']) {
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      storage[origin] = await page.evaluate(() => JSON.parse(JSON.stringify(localStorage)));
    } catch { /* ignore */ }
  }
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2));
  console.log(`  → Saved ${cookies.length} cookies + localStorage`);
}

async function restoreSession(context, page) {
  if (!fs.existsSync(COOKIE_FILE)) return false;

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  await context.addCookies(cookies);
  console.log(`  → Loaded ${cookies.length} cookies`);

  if (fs.existsSync(STORAGE_FILE)) {
    const storage = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    for (const [origin, items] of Object.entries(storage)) {
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.evaluate(items => {
          for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
        }, items);
        console.log(`  → Restored localStorage for ${origin} (${Object.keys(items).length} items)`);
      } catch { /* ignore */ }
    }
  }

  await page.goto('https://go.xero.com/app', { waitUntil: 'commit' });
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle').catch(() => null);

  const url = page.url();
  console.log(`  → Session check URL: ${url}`);
  return url.includes('go.xero.com') && !url.includes('login.xero.com');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getOtp() {
  if (config.xero.totp_secret) {
    const code = authenticator.generate(config.xero.totp_secret);
    console.log(`  → Auto-generated OTP: ${code}`);
    return Promise.resolve(code);
  }
  return prompt('  → Enter your OTP code: ');
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(context, page) {
  console.log('\n[1/3] Logging in...');

  // Step 1: try restoring full session (cookies + localStorage)
  const restored = await restoreSession(context, page);
  if (restored) {
    console.log('  → Session restored — skipping login and MFA');
    return;
  }
  console.log('  → Session expired or not found, doing full login...');

  // Step 2: full login
  await page.goto(LOGIN_URL);
  await page.fill('input[placeholder="Email address"]', config.xero.username);
  await page.fill('input[placeholder="Password"]', config.xero.password);
  await page.click('button:has-text("Log in")');

  const mfaRequired = await page.waitForURL(/two-factor/, { timeout: 8000 })
    .then(() => true).catch(() => false);

  if (mfaRequired) {
    console.log('  → MFA required');
    const otp = await getOtp();
    await page.fill('input[placeholder="123456"]', otp);

    const trustBox = page.locator('[data-automationid="auth-remembermecheckbox--input"]');
    const trustVisible = await trustBox.isVisible({ timeout: 2000 }).catch(() => false);
    if (trustVisible) {
      await trustBox.check();
      console.log('  → Checked "Trust this device"');
    }

    await page.click('button:has-text("Confirm")');
  } else {
    console.log('  → MFA skipped');
  }

  await page.waitForURL(/go\.xero\.com/, { timeout: 20000 });
  console.log('  → Login successful');

  // Save cookies + localStorage for next run
  await saveSession(context, page);
}

// ─── Get org ID from current URL ─────────────────────────────────────────────
async function getOrgId(page) {
  const extractOrgId = url => {
    const m = url.match(/\/(![^/?#]+)/);
    return m ? m[1] : null;
  };

  // Wait for the URL to settle on one that contains the org ID (e.g. /app/!Tdg0z/...)
  await page.waitForURL(url => extractOrgId(url.href) !== null, { timeout: 15000 });
  return extractOrgId(page.url());
}

// ─── Download a single report ─────────────────────────────────────────────────
async function downloadReport(page, orgId, report, outputDir) {
  const reportUrl = `${BASE_URL}/${orgId}${report.url}`;
  console.log(`\n  Navigating to: ${report.name}`);
  await page.goto(reportUrl);

  // Replay any recorded pre-export steps
  if (report.steps && report.steps.length > 0) {
    console.log(`  → Replaying ${report.steps.length} recorded step(s)...`);
    for (const step of report.steps) {
      try {
        if (step.action === 'click') {
          await page.click(step.selector, { timeout: 10000 });
        } else if (step.action === 'select') {
          await page.selectOption(step.selector, step.value, { timeout: 10000 });
        } else if (step.action === 'fill') {
          await page.fill(step.selector, step.value, { timeout: 10000 });
        }
      } catch (e) {
        console.warn(`  ⚠ Step failed (${step.action} ${step.selector}): ${e.message}`);
      }
    }
  }

  // Wait for Export button to appear
  try {
    await page.waitForSelector('button:has-text("Export")', { timeout: 20000 });
  } catch {
    console.log(`  ⚠ Timed out waiting for Export on "${report.name}" — skipping`);
    return false;
  }

  // Set up download listener
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

  // Click Export → Excel
  await page.click('button:has-text("Export")');
  await page.waitForSelector('button:has-text("Excel")', { timeout: 5000 });
  await page.click('button:has-text("Excel")');

  // Save the file
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  const savePath = path.join(outputDir, filename);
  await download.saveAs(savePath);

  console.log(`  ✅ Saved: ${filename}`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const outputDir = path.resolve(__dirname, config.output_dir);
  ensureDir(outputDir);

  const enabledReports = config.reports.filter(r => r.enabled);
  if (enabledReports.length === 0) {
    console.error('No reports enabled in config.json');
    process.exit(1);
  }

  console.log('=== Xero Report Downloader ===');
  console.log(`Reports to download: ${enabledReports.map(r => r.name).join(', ')}`);
  console.log(`Output directory: ${outputDir}`);

  const PROFILE_DIR = path.join(__dirname, '.browser-profile');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    // Step 1: Login
    await login(context, page);

    // Step 2: Get org ID
    console.log('\n[2/3] Detecting organisation...');
    const orgId = await getOrgId(page);
    if (!orgId) throw new Error('Could not detect Xero organisation ID');
    console.log(`  → Org ID: ${orgId}`);

    // Step 3: Download each report
    console.log(`\n[3/3] Downloading ${enabledReports.length} report(s)...`);
    let success = 0;
    for (const report of enabledReports) {
      const ok = await downloadReport(page, orgId, report, outputDir);
      if (ok) success++;
    }

    console.log(`\n=== Done: ${success}/${enabledReports.length} reports downloaded to ${outputDir} ===\n`);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
  } finally {
    await context.close();
  }
})();
