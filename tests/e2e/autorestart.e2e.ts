import { test, expect, Page, Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Runs against mock-httpd.mjs, which serves the UI from the `router` container and runs the real
// XRAYUI backend there. crond in the container fires the real cru job, so every wait below is
// bounded by the one-minute cron tick.

const sh = (cmd: string): string => execFileSync('docker', ['exec', 'router', 'sh', '-c', cmd], { encoding: 'utf8' }).trim();
// live processes only; a killed core is a zombie until reaped
const xrayPid = () => sh('for p in $(pidof xray); do grep -q "^State:.*Z" /proc/$p/status 2>/dev/null || echo $p; done | head -n 1');
const syslog = () => sh('cat /tmp/syslog.log 2>/dev/null || true');
const count = (needle: string) => syslog().split('\n').filter((l) => l.includes(needle)).length;

const idle = () => sh("jq -r '.loading.message // empty' /www/user/xrayui/xray-ui-response.json 2>/dev/null || true") === '';
const conf = () => sh('cat /opt/etc/xrayui.conf 2>/dev/null || true');

const RESTARTING = 'XRAYUI: Xray was not running, restarting (attempt';

async function until(what: string, check: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}\n--- syslog tail ---\n${syslog().split('\n').slice(-40).join('\n')}`);
}

const LABEL = {
  enable: 'Auto-restart Xray if it stops',
  interval: 'Check every',
  retries: 'Restart attempts',
  delay: 'Delay between attempts'
};

// Layout tables nest, so every ancestor row matches too; the row that owns the header comes last.
const statusRow = (page: Page, header: string) => page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: header, exact: true }) }).last();

async function openPage(page: Page) {
  await page.goto('/user1.asp');
  await expect(page.locator('th', { hasText: 'Connection status' })).toBeVisible({ timeout: 30_000 });
}

async function openGeneralOptions(page: Page): Promise<Locator> {
  await openPage(page);
  await statusRow(page, 'General options').getByRole('button', { name: 'manage' }).click();
  const modal = page.locator('.xray-modal-overlay', { hasText: 'XRAYUI General Settings' });
  await expect(modal).toBeVisible();
  return modal;
}

// The header holds the label followed by its hint text, so anchor on the label.
const row = (modal: Locator, label: string) => modal.locator('tr', { has: modal.page().locator('th', { hasText: new RegExp(`^\\s*${label}`) }) }).last();

async function submitAndWaitForReload(page: Page, click: () => Promise<void>) {
  const reloaded = page.waitForEvent('load', { timeout: 180_000 });
  await click();
  await reloaded;
  await expect(page.locator('th', { hasText: 'Connection status' })).toBeVisible({ timeout: 30_000 });
}

async function clickServerButton(page: Page, name: 'start' | 'stop') {
  await until('no task in progress', idle, 120_000);
  await openPage(page);
  const link = statusRow(page, 'Connection status').getByRole('link', { name: new RegExp(`^\\s*${name}\\s*$`, 'i') });
  await submitAndWaitForReload(page, () => link.click());
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
});

test('the option is off by default and nothing is scheduled', async ({ page }) => {
  expect(xrayPid()).not.toBe('');
  const modal = await openGeneralOptions(page);

  await expect(row(modal, LABEL.enable).locator('input[type=checkbox]')).not.toBeChecked();
  await expect(row(modal, LABEL.interval)).toHaveCount(0);
  await expect(row(modal, LABEL.retries)).toHaveCount(0);
  await expect(row(modal, LABEL.delay)).toHaveCount(0);
  expect(sh('cru l')).not.toContain('xrayui_autorestart');
});

test('turning it on shows the defaults, and the saved values reach the router', async ({ page }) => {
  let modal = await openGeneralOptions(page);
  await row(modal, LABEL.enable).locator('input[type=checkbox]').check();

  await expect(row(modal, LABEL.interval).locator('select')).toHaveValue('5');
  await expect(row(modal, LABEL.retries).locator('input')).toHaveValue('3');
  await expect(row(modal, LABEL.delay).locator('input')).toHaveValue('10');
  await page.screenshot({ path: 'test-results/general-tab-autorestart.png', fullPage: true });

  await row(modal, LABEL.interval).locator('select').selectOption('1');
  await row(modal, LABEL.retries).locator('input').fill('2');
  await row(modal, LABEL.delay).locator('input').fill('0');
  await submitAndWaitForReload(page, () => modal.locator('input[type=button][value="save"]').click());

  await until('the settings to be applied on the router', () => /^xray_autorestart="?true"?$/m.test(conf()) && idle(), 120_000);
  expect(conf()).toMatch(/^xray_autorestart_interval="?1"?$/m);
  expect(conf()).toMatch(/^xray_autorestart_retries="?2"?$/m);
  expect(conf()).toMatch(/^xray_autorestart_delay="?0"?$/m);
  expect(sh('cru l')).toContain('*/1 * * * * /jffs/scripts/xrayui cron autorestart #xrayui_autorestart#');

  modal = await openGeneralOptions(page);
  await expect(row(modal, LABEL.enable).locator('input[type=checkbox]')).toBeChecked();
  await expect(row(modal, LABEL.interval).locator('select')).toHaveValue('1');
  await expect(row(modal, LABEL.retries).locator('input')).toHaveValue('2');
  await expect(row(modal, LABEL.delay).locator('input')).toHaveValue('0');
});

test('a crashed Xray core is restarted by the cron job and the restart is logged', async () => {
  test.setTimeout(6 * 60_000);
  await until('xray running and no task in progress', () => xrayPid() !== '' && idle(), 120_000);
  const before = xrayPid();
  const attempts = count(RESTARTING);

  sh(`kill -9 ${before}`);
  await until('the watchdog to log the restart', () => syslog().includes(`${RESTARTING} 1/2)`) && count(RESTARTING) > attempts, 150_000);
  await until('a new xray process', () => xrayPid() !== '' && xrayPid() !== before, 60_000);
  await until('the "running again" line', () => syslog().includes('Xray is running again after 1 automatic restart attempt(s).'), 150_000);
  expect(sh('test -f /tmp/xrayui.autorestart && echo yes || echo no')).toBe('no');
});

test('Xray stopped from the UI stays stopped', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await clickServerButton(page, 'stop');
  await until('xray to stop', () => xrayPid() === '', 60_000);
  expect(sh('test -f /var/run/xray.pid && echo yes || echo no')).toBe('no');

  const attempts = count(RESTARTING);
  await new Promise((r) => setTimeout(r, 135_000)); // two cron ticks
  expect(xrayPid()).toBe('');
  expect(count(RESTARTING)).toBe(attempts);

  await clickServerButton(page, 'start');
  await until('xray to start again', () => xrayPid() !== '', 60_000);
});

test('a core that keeps failing is retried the set number of times, then left alone', async () => {
  test.setTimeout(10 * 60_000);
  // The config still passes `xray -test`, but the core exits right away because its inbound port is taken.
  await until('xray running and no task in progress', () => xrayPid() !== '' && idle(), 120_000);
  sh(`kill -9 $(pidof xray)`);
  sh('socat TCP-LISTEN:10808,bind=127.0.0.1,fork /dev/null >/dev/null 2>&1 & echo $! >/tmp/port-hog.pid');

  await until('attempt 1/2', () => syslog().includes(`${RESTARTING} 1/2)`) && count(`${RESTARTING} 1/2)`) >= 2, 150_000);
  await until('attempt 2/2', () => syslog().includes(`${RESTARTING} 2/2)`), 150_000);
  await until('the give-up line', () => syslog().includes('Xray is still not running after 2 automatic restart attempt(s). Giving up until Xray is started again.'), 150_000);

  const attempts = count(RESTARTING);
  await new Promise((r) => setTimeout(r, 135_000));
  expect(count(RESTARTING)).toBe(attempts);
  expect(count('Giving up until Xray is started again.')).toBe(1);
  expect(xrayPid()).toBe('');

  sh('kill $(cat /tmp/port-hog.pid) 2>/dev/null; true');
});

test('starting Xray by hand resets the attempts', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  await clickServerButton(page, 'start');
  await until('xray running', () => xrayPid() !== '', 60_000);
  await until('the "running again" line after 2 attempts', () => syslog().includes('Xray is running again after 2 automatic restart attempt(s).'), 150_000);
  expect(sh('test -f /tmp/xrayui.autorestart && echo yes || echo no')).toBe('no');
});

test('turning the option off removes the cron job', async ({ page }) => {
  const modal = await openGeneralOptions(page);
  await row(modal, LABEL.enable).locator('input[type=checkbox]').uncheck();
  await expect(row(modal, LABEL.interval)).toHaveCount(0);
  await submitAndWaitForReload(page, () => modal.locator('input[type=button][value="save"]').click());

  await until('the option to be off on the router', () => /^xray_autorestart="?false"?$/m.test(conf()) && idle(), 120_000);
  expect(sh('cru l')).not.toContain('xrayui_autorestart');
});
