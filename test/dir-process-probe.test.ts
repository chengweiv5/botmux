/**
 * findProcessesWithCwdUnder: detection only. Every process here is spawned by
 * the test itself and reaped through its own ChildProcess handle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findProcessesWithCwdUnder, parseLsofCwdOutput } from '../src/utils/dir-process-probe.js';

const children: ChildProcess[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dir-process-probe-')));
  dirs.push(dir);
  return dir;
}

async function sleeper(cwd: string): Promise<ChildProcess> {
  const child = spawn('sleep', ['30'], { cwd, stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findProcessesWithCwdUnder', () => {
  it.runIf(process.platform === 'linux')('finds a process whose cwd is the directory or below it, and only that one', async () => {
    const root = tempDir();
    const inside = join(root, 'wt');
    mkdirSync(join(inside, 'pkg'), { recursive: true });
    const elsewhere = join(root, 'wt-other');
    mkdirSync(elsewhere);
    const child = await sleeper(join(inside, 'pkg'));
    const sibling = await sleeper(elsewhere);

    const probe = await findProcessesWithCwdUnder(inside);
    expect(probe.status).toBe('ok');
    if (probe.status !== 'ok') return;
    expect(probe.pids).toContain(child.pid);
    expect(probe.pids).not.toContain(sibling.pid);
  });

  it.runIf(process.platform === 'linux')('stops reporting the process once it exits', async () => {
    const dir = tempDir();
    const child = await sleeper(dir);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    expect(await findProcessesWithCwdUnder(dir)).toEqual({ status: 'ok', pids: [] });
  });

  it('answers unknown when procfs cannot be listed', async () => {
    const probe = await findProcessesWithCwdUnder('/x', { platform: 'linux', procRoot: join(tmpdir(), 'no-such-proc-root') });
    expect(probe.status).toBe('unknown');
  });

  it('uses lsof off Linux and answers unknown when it is unavailable', async () => {
    expect(await findProcessesWithCwdUnder('/work/wt', {
      platform: 'darwin',
      runLsof: async () => 'p10\nfcwd\nn/work/wt/src\np11\nfcwd\nn/work/wt-other\n',
    })).toEqual({ status: 'ok', pids: [10] });
    const probe = await findProcessesWithCwdUnder('/work/wt', {
      platform: 'darwin',
      runLsof: async () => { throw new Error('spawn lsof ENOENT'); },
    });
    expect(probe).toEqual({ status: 'unknown', error: 'spawn lsof ENOENT' });
  });
});

describe('parseLsofCwdOutput', () => {
  it('matches the directory itself and descendants, not same-prefix siblings', () => {
    const out = ['p1', 'fcwd', 'n/work/wt', 'p2', 'fcwd', 'n/work/wt/a/b', 'p3', 'fcwd', 'n/work/wtx', 'p4', 'fcwd', 'n/'].join('\n');
    expect(parseLsofCwdOutput(out, '/work/wt').sort()).toEqual([1, 2]);
  });
});
