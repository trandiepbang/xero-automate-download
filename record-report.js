const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const { authenticator } = require('otplib');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const LOGIN_URL = 'https://login.xero.com/identity/user/login';
const COOKIE_FILE = path.join(__dirname, '.xero-session.json');
const STORAGE_FILE = path.join(__dirname, '.xero-localstorage.json');

async function saveSession(context, page) {
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));

  // Save localStorage from each Xero domain we've visited
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

  // Restore localStorage for each origin
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

  // Verify session
  await page.goto('https://go.xero.com/app', { waitUntil: 'commit' });
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle').catch(() => null);

  const url = page.url();
  console.log(`  → Session check URL: ${url}`);
  return url.includes('go.xero.com') && !url.includes('login.xero.com');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function getOtp() {
  if (config.xero.totp_secret) {
    const code = authenticator.generate(config.xero.totp_secret);
    console.log(`  → Auto-generated OTP: ${code}`);
    return Promise.resolve(code);
  }
  return prompt('  → Enter your OTP code: ');
}

async function login(context, page) {
  console.log('\n[1/4] Logging in...');

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
  await page.waitForLoadState('networkidle').catch(() => null);

  const mfaRequired = page.url().includes('two-factor');

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

// Inject a floating recorder UI into the page that tracks user interactions
async function injectRecorder(page) {
  await page.evaluate(() => {
    window.__recordedSteps = [];

    // Small badge in bottom-right corner; click to expand/collapse the step list
    const badge = document.createElement('div');
    badge.id = '__xero_recorder';
    badge.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: #1a1a2e; color: #eee; font: 13px monospace;
      border-radius: 20px; box-shadow: 0 2px 12px rgba(0,0,0,0.5);
      cursor: pointer; user-select: none;
    `;
    badge.innerHTML = `
      <div id="__xero_badge_label" style="padding:6px 14px;color:#f0a500;font-weight:bold">
        ● 0 steps recorded
      </div>
      <div id="__xero_steps" style="display:none;padding:0 14px 10px;font-size:11px;line-height:1.8;max-height:260px;overflow-y:auto;min-width:240px">
        <em style="color:#888">No steps yet</em>
      </div>
    `;
    document.body.appendChild(badge);

    // Draggable
    let dragging = false, dragOffX = 0, dragOffY = 0, didDrag = false;
    badge.addEventListener('mousedown', (e) => {
      dragging = true; didDrag = false;
      dragOffX = e.clientX - badge.getBoundingClientRect().left;
      dragOffY = e.clientY - badge.getBoundingClientRect().top;
      badge.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      didDrag = true;
      // Switch from bottom/right to top/left positioning on first drag
      badge.style.bottom = 'auto'; badge.style.right = 'auto';
      badge.style.left = (e.clientX - dragOffX) + 'px';
      badge.style.top  = (e.clientY - dragOffY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // Toggle expand only if it wasn't a drag
    badge.addEventListener('click', () => {
      if (didDrag) return;
      const list = document.getElementById('__xero_steps');
      list.style.display = list.style.display === 'none' ? 'block' : 'none';
    });

    function updatePanel() {
      const count = window.__recordedSteps.length;
      const lbl = document.getElementById('__xero_badge_label');
      const list = document.getElementById('__xero_steps');
      if (lbl) lbl.textContent = `● ${count} step${count !== 1 ? 's' : ''} recorded`;
      if (!list) return;
      if (count === 0) {
        list.innerHTML = '<em style="color:#888">No steps yet</em>';
      } else {
        list.innerHTML = window.__recordedSteps.map((s, i) => {
          const label = s.action === 'select'
            ? `select "${s.value}" → ${s.label}`
            : s.action === 'fill'
            ? `fill "${s.value}" → ${s.label}`
            : `click ${s.label}`;
          return `<div style="color:#7ec8e3">${i + 1}. ${label}</div>`;
        }).join('');
        // Auto-scroll to bottom
        list.scrollTop = list.scrollHeight;
      }
    }

    // Position-based XPath — never uses text labels or generated IDs
    function getXPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.body) {
        let idx = 1;
        let sib = node.previousSibling;
        while (sib) {
          if (sib.nodeType === 1 && sib.tagName === node.tagName) idx++;
          sib = sib.previousSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
        node = node.parentElement;
      }
      return `xpath=//body/${parts.join('/')}`;
    }

    // Human-readable label for display only — NOT used as selector
    function makeLabel(el) {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const aria = el.getAttribute('aria-label');
      const placeholder = el.getAttribute('placeholder');
      const name = el.getAttribute('name');
      const type = el.getAttribute('type');

      if (aria) return `<${tag} aria-label="${aria}">`;
      if (placeholder) return `<${tag} placeholder="${placeholder}">`;
      if (name) return `<${tag} name="${name}">`;
      if (text) return `<${tag}> "${text}"`;
      if (type) return `<${tag} type="${type}">`;
      return `<${tag}>`;
    }

    // Track clicks
    document.addEventListener('click', (e) => {
      if (e.target.closest('#__xero_recorder')) return;
      window.__recordedSteps.push({
        action: 'click',
        selector: getXPath(e.target),
        label: makeLabel(e.target),
      });
      updatePanel();
    }, true);

    // Track select changes
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el.tagName.toLowerCase() !== 'select') return;
      window.__recordedSteps.push({
        action: 'select',
        selector: getXPath(el),
        label: makeLabel(el),
        value: el.value,
      });
      updatePanel();
    }, true);

    // Track text input (on blur, to capture filled value)
    document.addEventListener('focusout', (e) => {
      const el = e.target;
      const tag = el.tagName.toLowerCase();
      if (!['input', 'textarea'].includes(tag)) return;
      if (!el.value) return;
      if (['password', 'hidden'].includes(el.type)) return;
      const sel = getXPath(el);
      window.__recordedSteps = window.__recordedSteps.filter(
        s => !(s.action === 'fill' && s.selector === sel)
      );
      window.__recordedSteps.push({
        action: 'fill',
        selector: sel,
        label: makeLabel(el),
        value: el.value,
      });
      updatePanel();
    }, true);
  });
}

async function getRecordedSteps(page) {
  return page.evaluate(() => window.__recordedSteps || []);
}

async function testDownload(page, steps) {
  // Execute any recorded pre-export steps
  for (const step of steps) {
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

  try {
    await page.waitForSelector('button:has-text("Export")', { timeout: 20000 });
  } catch {
    return { ok: false, reason: 'No Export button found within 20s' };
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.click('button:has-text("Export")');

  try {
    await page.waitForSelector('button:has-text("Excel")', { timeout: 5000 });
  } catch {
    return { ok: false, reason: 'No Excel option in Export menu' };
  }
  await page.click('button:has-text("Excel")');

  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  const savePath = path.join(path.resolve(__dirname, config.output_dir), filename);
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  await download.saveAs(savePath);
  return { ok: true, filename };
}

(async () => {
  console.log('=== Xero Report Recorder ===');

  const PROFILE_DIR = path.join(__dirname, '.browser-profile');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await login(context, page);

    console.log('\n[2/4] Navigate to your report in the browser window.');
    console.log('      Make sure the report page is fully loaded, then come back here.\n');
    await prompt('Press Enter when you are on the report page...');

    const currentUrl = page.url();
    const orgMatch = currentUrl.match(/reporting\.xero\.com\/(![^/]+)(\/.*)/);
    if (!orgMatch) {
      console.error('  ❌ Not on a reporting.xero.com URL. Please navigate to a report first.');
      process.exit(1);
    }
    const reportPath = orgMatch[2];
    console.log(`\n  Captured URL path: ${reportPath}`);

    const reportName = await prompt('  Report name (e.g. "Cash Summary"): ');
    if (!reportName) { console.error('No name provided.'); process.exit(1); }

    if (config.reports.some(r => r.name === reportName)) {
      const overwrite = await prompt(`  Report "${reportName}" already exists. Overwrite? (y/n): `);
      if (overwrite.toLowerCase() !== 'y') { console.log('Cancelled.'); process.exit(0); }
      config.reports = config.reports.filter(r => r.name !== reportName);
    }

    console.log('\n[3/4] Recording steps.');
    console.log('      A recording panel will appear in the browser.');
    console.log('      Perform any actions needed BEFORE clicking Export');
    console.log('      (e.g. date range, filters, Update button).');
    console.log('      When done, come back here.\n');

    await injectRecorder(page);
    await prompt('Press Enter when you have finished setting up the report...');

    const steps = await getRecordedSteps(page);
    console.log(`\n  Recorded ${steps.length} step(s):`);
    steps.forEach((s, i) => {
      const label = s.action === 'select' ? `select "${s.value}" in ${s.selector}`
        : s.action === 'fill' ? `fill "${s.value}" into ${s.selector}`
        : `click ${s.selector}`;
      console.log(`    ${i + 1}. ${label}`);
    });

    // Reload and replay to test
    console.log('\n[4/4] Testing download by replaying steps on a fresh page load...');
    const orgId = orgMatch[1];
    await page.goto(`https://reporting.xero.com/${orgId}${reportPath}`);
    await page.waitForLoadState('networkidle');
    const result = await testDownload(page, steps);

    if (!result.ok) {
      console.error(`\n  ❌ Download test failed: ${result.reason}`);
      const save = await prompt('  Save anyway? (y/n): ');
      if (save.toLowerCase() !== 'y') { process.exit(1); }
    } else {
      console.log(`  ✅ Download works! Saved test file: ${result.filename}`);
    }

    const entry = { name: reportName, url: reportPath, enabled: true };
    if (steps.length > 0) entry.steps = steps;
    config.reports.push(entry);
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));

    console.log(`\n  ✅ Added "${reportName}" to config.json`);
    if (steps.length > 0) console.log(`     with ${steps.length} pre-export step(s)`);
    console.log('\nRun: node xero-download.js\n');

  } catch (err) {
    console.error('\n❌ Error:', err.message);
  } finally {
    await browser.close();
  }
})();
