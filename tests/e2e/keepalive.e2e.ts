import { test, expect, Page, Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// TCP keepalive on an inbound, set through Transport -> Sockopt and Apply in the real UI.
// Clients run in their own containers on the router's docker network; `docker network disconnect`
// makes them vanish without closing their connections, like a phone that lost signal.

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const sh = (cmd: string): string => docker('exec', 'router', 'sh', '-c', cmd);
const idle = () => sh("jq -r '.loading.message // empty' /www/user/xrayui/xray-ui-response.json 2>/dev/null || true") === '';
const xrayPid = () => sh('for p in $(pidof xray); do grep -q "^State:.*Z" /proc/$p/status 2>/dev/null || echo $p; done | head -n 1');

const NET = 'e2enet';
const INBOUND = 'socks-lan';
const PORT = 10809;
const TARGET_PORT = 10900;
const CLIENTS = 20;

// Server-side ESTABLISHED sockets of the inbound, with the kernel timer each one has armed (02 = keepalive).
function inboundSockets(): { established: number; keepalive: number } {
  const hexPort = PORT.toString(16).toUpperCase().padStart(4, '0');
  const rows = sh(`cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$2 ~ /:${hexPort}$/ && $4 == "01" {split($6, t, ":"); print t[1]}'`)
    .split('\n')
    .filter(Boolean);
  return { established: rows.length, keepalive: rows.filter((t) => t === '02').length };
}

const configSockopt = () => sh(`jq -c '.inbounds[] | select(.tag == "${INBOUND}") | .streamSettings.sockopt // {}' /opt/etc/xray/config.json`);

async function until(what: string, check: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}\nsockets: ${JSON.stringify(inboundSockets())}`);
}

// A client container that opens CLIENTS idle connections through the socks inbound to a target that never answers.
function startClients(name: string) {
  docker('rm', '-f', name);
  docker(
    'run', '-d', '--name', name, '--network', NET, '--entrypoint', 'sh', 'xrayui-router', '-c',
    `for i in $(seq 1 ${CLIENTS}); do (sleep 3600 | socat - SOCKS4A:router:127.0.0.1:${TARGET_PORT},socksport=${PORT}) & done; wait`
  );
}

async function openSockopt(page: Page): Promise<Locator> {
  await page.goto('/user1.asp');
  await expect(page.locator('th', { hasText: 'Connection status' })).toBeVisible({ timeout: 30_000 });
  const inboundRow = page.locator('tr.proxy-row', { has: page.locator('th', { hasText: new RegExp(`^\\s*${INBOUND}\\s*$`) }) });
  await inboundRow.getByRole('link', { name: 'transport' }).click();
  const transport = page.locator('.xray-modal-overlay', { hasText: 'Transport settings' });
  await expect(transport).toBeVisible();
  await transport.locator('tr', { has: page.locator('th', { hasText: /^\s*Transparent Proxy \(tproxy\)/ }) }).getByRole('button', { name: 'manage' }).click();
  const sockopt = page.locator('.xray-modal-overlay', { hasText: 'Transparent Proxy Settings' }).last();
  await expect(sockopt).toBeVisible();
  return sockopt;
}

const field = (modal: Locator, label: string) => modal.locator('tr', { has: modal.page().locator('th', { hasText: new RegExp(`^\\s*${label}`) }) }).locator('input');
const IDLE = 'TCP keepalive idle, s';
const INTERVAL = 'TCP keepalive interval, s';

async function saveAndApply(page: Page, sockopt: Locator) {
  await sockopt.locator('.xray-modal-footer button', { hasText: 'close' }).click();
  await page.locator('.xray-modal-overlay', { hasText: 'Transport settings' }).locator('input[type=button][value="save"]').click();
  await until('no task in progress', idle, 120_000);
  const reloaded = page.waitForEvent('load', { timeout: 180_000 });
  await page.locator('.apply_gen input[type=button][value="apply"]').click();
  await reloaded;
  await until('xray running after apply', () => xrayPid() !== '' && idle(), 120_000);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  sh(`(socat TCP-LISTEN:${TARGET_PORT},bind=127.0.0.1,fork,reuseaddr EXEC:'sleep 3600' >/dev/null 2>&1 &)`);
});

test.afterAll(() => {
  for (const c of ['ka-off', 'ka-on']) docker('rm', '-f', c);
});

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
});

test('without keepalive, connections of vanished clients stay open', async () => {
  test.setTimeout(5 * 60_000);
  await until('xray running and no task in progress', () => xrayPid() !== '' && idle(), 120_000);
  expect(configSockopt()).toBe('{}');
  startClients('ka-off');
  await until(`${CLIENTS} connections`, () => inboundSockets().established === CLIENTS, 60_000);
  expect(inboundSockets().keepalive).toBe(0);

  docker('network', 'disconnect', NET, 'ka-off');
  await new Promise((r) => setTimeout(r, 90_000));
  expect(inboundSockets().established).toBe(CLIENTS);
});

test('keepalive set in the Sockopt modal reaches config.json', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const sockopt = await openSockopt(page);
  await expect(field(sockopt, IDLE)).toHaveValue('');
  await expect(field(sockopt, IDLE)).toHaveAttribute('min', '0');
  await expect(sockopt).toContainText('default: off');
  await field(sockopt, IDLE).fill('10');
  await field(sockopt, INTERVAL).fill('5');
  await page.screenshot({ path: 'test-results/sockopt-keepalive.png', fullPage: true });
  await saveAndApply(page, sockopt);

  expect(JSON.parse(configSockopt())).toEqual({ tcpKeepAliveIdle: 10, tcpKeepAliveInterval: 5 });
  // Applying restarted Xray, so the dead connections from the first test are gone with the old process.
  await until('old connections closed by the restart', () => inboundSockets().established === 0, 60_000);

  const reopened = await openSockopt(page);
  await expect(field(reopened, IDLE)).toHaveValue('10');
  await expect(field(reopened, INTERVAL)).toHaveValue('5');
});

test('with keepalive, connections of vanished clients are closed', async () => {
  test.setTimeout(5 * 60_000);
  startClients('ka-on');
  await until(`${CLIENTS} connections with the keepalive timer`, () => inboundSockets().keepalive === CLIENTS, 60_000);

  docker('network', 'disconnect', NET, 'ka-on');
  const start = Date.now();
  // idle 10 s + 9 unanswered probes 5 s apart (Linux default) = about 55 s
  await until('the dead connections to be closed', () => inboundSockets().established === 0, 150_000);
  console.log(`dead connections closed ${Math.round((Date.now() - start) / 1000)} s after the clients vanished`);
});

test('clearing the fields removes keepalive from config.json', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const sockopt = await openSockopt(page);
  await field(sockopt, IDLE).fill('');
  await field(sockopt, INTERVAL).fill('');
  await saveAndApply(page, sockopt);

  expect(configSockopt()).toBe('{}');
});
