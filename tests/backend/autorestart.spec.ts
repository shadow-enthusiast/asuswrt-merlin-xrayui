import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HARNESS = path.join(process.cwd(), 'tests', 'backend', 'autorestart', 'harness.sh');

const which = (bin: string): string | undefined => {
  const out = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : undefined;
};
const BUSYBOX = process.platform === 'linux' ? which('busybox') : undefined;
const SHELLS: [string, string[]][] = [...(BUSYBOX ? [['busybox sh', [BUSYBOX, 'sh']] as [string, string[]]] : []), ['sh', ['sh']]];

const NOW = 1790000000;
const ON = { xray_autorestart: 'true', xray_autorestart_interval: '5', xray_autorestart_retries: '3', xray_autorestart_delay: '10' };

interface Setup {
  conf?: Record<string, string>;
  pidfile?: boolean;
  state?: string;
  env?: Record<string, string>;
}

const run = (shell: string[], steps: string[], setup: Setup = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrayui-autorestart-'));
  try {
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
    const conf = setup.conf ?? ON;
    fs.writeFileSync(
      path.join(dir, 'xrayui.conf'),
      Object.entries(conf)
        .map(([k, v]) => `${k}=${v}\n`)
        .join('')
    );
    if (setup.pidfile ?? true) fs.writeFileSync(path.join(dir, 'run', 'xray.pid'), '4242\n');
    if (setup.state !== undefined) fs.writeFileSync(path.join(dir, 'tmp', 'xrayui.autorestart'), setup.state);
    const out = spawnSync(shell[0], [...shell.slice(1), HARNESS, dir, ...steps], {
      encoding: 'utf8',
      env: { ...process.env, AR_NOW: String(NOW), ...setup.env }
    });
    const read = (rel: string) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : undefined);
    return {
      status: out.status,
      stderr: out.stderr,
      events: (read('events.log') ?? '').split('\n').filter(Boolean),
      state: read('tmp/xrayui.autorestart')
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe.each(SHELLS)('xray auto-restart watchdog (%s)', (_name, shell) => {
  it('restarts xray that died on its own and logs the attempt', () => {
    const r = run(shell, ['autorestart_check']);

    expect(r.stderr).toBe('');
    expect(r.events).toEqual(['sleep 5', 'WARN: Xray was not running, restarting (attempt 1/3)', 'restart', 'autorestart_check rc=0']);
    expect(r.state).toBe(`1 ${NOW} 0\n`);
  });

  it('leaves xray alone when it is running and forgets earlier attempts', () => {
    const r = run(shell, ['autorestart_check'], { state: `2 ${NOW - 900} 0\n`, env: { AR_PID: '4242' } });

    expect(r.events).toEqual(['NOTICE: Xray is running again after 2 automatic restart attempt(s).', 'autorestart_check rc=0']);
    expect(r.state).toBeUndefined();
  });

  it('does not restart xray that was stopped on purpose', () => {
    const r = run(shell, ['autorestart_check'], { pidfile: false, state: `1 ${NOW - 900} 0\n` });

    expect(r.events).toEqual(['autorestart_check rc=0']);
    expect(r.state).toBeUndefined();
  });

  it('does nothing when the option is off', () => {
    const r = run(shell, ['autorestart_check'], { conf: { ...ON, xray_autorestart: 'false' }, state: `3 ${NOW} 1\n` });

    expect(r.events).toEqual(['autorestart_check rc=0']);
    expect(r.state).toBeUndefined();
  });

  it('skips the check while a restart holds the restart lock', () => {
    const r = run(shell, ['touch "$XRAY_RESTART_LOCKFILE"', 'autorestart_check'], { env: { AR_LOCK_BUSY: '1' } });

    expect(r.events).not.toContain('restart');
    expect(r.state).toBeUndefined();
  });

  it('waits for the delay between attempts', () => {
    const early = run(shell, ['autorestart_check'], { state: `1 ${NOW - 300} 0\n` });
    expect(early.events).not.toContain('restart');
    expect(early.state).toBe(`1 ${NOW - 300} 0\n`);

    // a few seconds of cron jitter must not push the attempt to the next check
    const due = run(shell, ['autorestart_check'], { state: `1 ${NOW - 595} 0\n` });
    expect(due.events).toContain('WARN: Xray was not running, restarting (attempt 2/3)');
    expect(due.events).toContain('restart');
    expect(due.state).toBe(`2 ${NOW} 0\n`);
  });

  it('gives up after the last attempt and says so once', () => {
    const first = run(shell, ['autorestart_check'], { state: `3 ${NOW - 900} 0\n` });
    expect(first.events).toEqual([
      'sleep 5',
      'ERROR: Xray is still not running after 3 automatic restart attempt(s). Giving up until Xray is started again.',
      'autorestart_check rc=0'
    ]);
    expect(first.state).toBe(`3 ${NOW - 900} 1\n`);

    const again = run(shell, ['autorestart_check'], { state: `3 ${NOW - 900} 1\n` });
    expect(again.events).toEqual(['sleep 5', 'autorestart_check rc=0']);
  });

  it('keeps trying forever when the attempts are set to 0', () => {
    const r = run(shell, ['autorestart_check'], { conf: { ...ON, xray_autorestart_retries: '0', xray_autorestart_delay: '0' }, state: `41 ${NOW - 60} 0\n` });

    expect(r.events).toContain('WARN: Xray was not running, restarting (attempt 42)');
    expect(r.state).toBe(`42 ${NOW} 0\n`);
  });

  it('treats a damaged state file as no earlier attempts', () => {
    const r = run(shell, ['autorestart_check'], { state: 'garbage $(reboot)\n' });

    expect(r.stderr).toBe('');
    expect(r.events).toContain('WARN: Xray was not running, restarting (attempt 1/3)');
  });

  it('adds the cron job with the chosen interval and removes it when the option is off', () => {
    const on = run(shell, ['cron_autorestart_add'], { conf: { ...ON, xray_autorestart_interval: '2' } });
    expect(on.events).toEqual([
      'cru d xrayui_autorestart',
      'cru a xrayui_autorestart */2 * * * * /jffs/scripts/xrayui cron autorestart',
      'OK: CRON job xrayui_autorestart for Xray UI added successfully',
      'cron_autorestart_add rc=0'
    ]);

    const bad = run(shell, ['cron_autorestart_add'], { conf: { ...ON, xray_autorestart_interval: '7' } });
    expect(bad.events).toContain('cru a xrayui_autorestart */5 * * * * /jffs/scripts/xrayui cron autorestart');

    const off = run(shell, ['cron_autorestart_add'], { conf: { xray_autorestart: 'false' }, state: `1 ${NOW} 0\n` });
    expect(off.events.filter((e) => e.startsWith('cru '))).toEqual(['cru d xrayui_autorestart']);
    expect(off.state).toBeUndefined();
  });

  it('clamps the numbers coming from the settings', () => {
    const r = run(shell, [
      'ev "$(sanitize_autorestart_number 007 3 100)"',
      'ev "$(sanitize_autorestart_number 5000 3 100)"',
      'ev "$(sanitize_autorestart_number 99999999999999999999 10 1440)"',
      'ev "$(sanitize_autorestart_number -1 3 100)"',
      'ev "$(sanitize_autorestart_number "" 10 1440)"'
    ]);

    expect(r.events.filter((e) => !e.includes(' rc='))).toEqual(['7', '100', '1440', '3', '10']);
  });
});
