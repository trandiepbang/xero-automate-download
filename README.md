# Xero Report Downloader

Automates downloading financial reports from Xero as Excel files. Supports session persistence (login once, skip MFA on subsequent runs), a step recorder for custom report configurations, and a cron-based scheduler.

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- A Xero account with access to the reports you want to download

---

## Installation

```bash
# 1. Clone or download this project, then enter the folder
cd xero-report-downloader

# 2. Install dependencies
npm install

# 3. Install Playwright browser
npx playwright install chromium
```

---

## Configuration

Edit `config.json` before running anything.

### Xero credentials

```json
"xero": {
  "username": "you@example.com",
  "password": "your-password",
  "totp_secret": ""
}
```

- If your account uses TOTP (authenticator app), set `totp_secret` to the secret key shown when you set up MFA (the string under the QR code). The script will generate OTP codes automatically.
- Leave `totp_secret` empty to be prompted for the OTP code each time a full login is needed.

### Output folder

```json
"output_dir": "./downloads"
```

Downloaded Excel files are saved here.

### Reports

Each report entry looks like this:

```json
{
  "name": "Balance Sheet",
  "url": "/v1/Run/1017",
  "enabled": true
}
```

- Set `"enabled": false` to skip a report without deleting it.
- Reports that require pre-export interactions (date pickers, filters, etc.) also have a `steps` array — these are recorded automatically by `record-report.js`.

---

## First Run — Login & MFA

The first time you run any script, the browser will open, log in to Xero, and ask for MFA if required. After a successful login the browser profile is saved to `.browser-profile/`. On all subsequent runs the saved profile is reused and MFA is skipped.

> If Xero ever expires your session, a full re-login will happen automatically the next time you run the script.

---

## Usage

### 1. Download reports

```bash
node xero-download.js
```

Downloads all enabled reports from `config.json` and saves them as Excel files in `output_dir`.

---

### 2. Record a new report

Use this when a report requires extra steps before you can export it (e.g. selecting a date range, applying filters, clicking Update).

```bash
node record-report.js
```

**Step-by-step:**

1. The browser opens and logs in automatically.
2. **Manually navigate** to the report page in the browser window.
3. Return to the terminal and press **Enter**.
4. Enter a name for this report (e.g. `Cash Summary`).
5. A floating recording panel appears in the browser (bottom-right corner, draggable).
6. **Perform the actions** you normally do before clicking Export — date range, filters, Update button, etc. Do **not** click Export yourself.
7. Return to the terminal and press **Enter**.
8. The script replays your recorded steps and tests the download automatically.
9. If successful, the report is added to `config.json` and is ready for `xero-download.js`.

---

### 3. Run on a schedule

#### Configure the schedule in `config.json`

```json
"schedule": {
  "enabled": true,
  "cron": "0 8 * * 1-5",
  "timezone": "Australia/Sydney"
}
```

**Common cron expressions:**

| Schedule | Cron |
|---|---|
| Weekdays at 8am | `0 8 * * 1-5` |
| Every day at 9am | `0 9 * * *` |
| Mon, Wed, Fri at 7am | `0 7 * * 1,3,5` |
| Every hour | `0 * * * *` |

Cron format: `minute hour day-of-month month day-of-week`

#### Start the scheduler

```bash
node scheduler.js
```

The process runs continuously and triggers `xero-download.js` at the configured time. Press `Ctrl+C` to stop.

#### Test the scheduler immediately

Add `test_run_after_seconds` to trigger a one-off run N seconds after start:

```json
"schedule": {
  "enabled": true,
  "cron": "0 8 * * 1-5",
  "timezone": "Australia/Sydney",
  "test_run_after_seconds": 5
}
```

Remove this field after testing.

---

## Files

| File | Purpose |
|---|---|
| `xero-download.js` | Downloads all enabled reports |
| `record-report.js` | Records steps for a new report and saves to config |
| `scheduler.js` | Runs `xero-download.js` on a cron schedule |
| `config.json` | Credentials, report list, schedule settings |
| `.browser-profile/` | Persisted browser session (auto-created, do not delete) |
| `downloads/` | Downloaded Excel files (auto-created) |

---

## Troubleshooting

**MFA is required on every run**
The browser profile in `.browser-profile/` was deleted or corrupted. Delete the folder and run again — log in once and it will be saved again.

**Report download fails with "Export button not found"**
The report page may have changed layout. Re-record the report using `record-report.js`.

**`browser.close` or similar errors**
Ensure you are running Node.js v18 or later: `node --version`
# xero-automate-download
