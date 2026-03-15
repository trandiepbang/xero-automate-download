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

async function waitForExport(page) {
  // Wait until "Export has been started" status appears
  await page.waitForFunction(
    () => {
      const statuses = document.querySelectorAll('[role="status"]');
      return [...statuses].some(el => el.textContent.includes('Export has been started'));
    },
    { timeout: 30000 }
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(page) {
  console.log('\n[1/3] Logging in...');
  await page.goto(LOGIN_URL);
  await page.fill('input[placeholder="Email address"]', config.xero.username);
  await page.fill('input[placeholder="Password"]', config.xero.password);
  await page.click('button:has-text("Log in")');

  // Wait for MFA screen
  await page.waitForURL(/two-factor/, { timeout: 15000 });
  console.log('  → MFA required');

  const otp = await getOtp();
  await page.fill('input[placeholder="123456"]', otp);
  await page.click('button:has-text("Confirm")');

  // Wait for redirect to Xero dashboard
  await page.waitForURL(/go\.xero\.com/, { timeout: 20000 });
  console.log('  → Login successful');
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

  // Wait for Export button to appear
  try {
    await page.waitForSelector('button:has-text("Export")', { timeout: 20000 });
  } catch {
    console.log(`  ⚠ Timed out waiting for Export on "${report.name}" — skipping`);
    return false;
  }

  // Some reports need an Update click to generate data first
  const updateBtn = page.locator('button:has-text("Update")');
  if (await updateBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await updateBtn.click();
    await page.waitForSelector('[role="status"]:has-text("Report has finished loading")', { timeout: 20000 });
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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // Step 1: Login
    await login(page);

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
    await browser.close();
  }
})();
