/**
 * Which processes have their current directory inside a given directory.
 * Detection only — nothing here signals or kills a process.
 *
 * Linux reads every `/proc/<pid>/cwd`; a pid that vanished or belongs to
 * another user (EACCES) is skipped, since it cannot be told apart from "not in
 * the directory" and other users' processes cannot sit in this user's worktree
 * without it being shared anyway. macOS / other Unix run one bounded
 * `lsof -n -P -d cwd -Fpn` over all processes. When enumeration itself is
 * unavailable (no procfs, lsof missing, failed or timed out) the probe answers
 * `unknown` and callers must not treat the directory as unused.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export type DirProcessProbe =
  | { status: 'ok'; pids: number[] }
  | { status: 'unknown'; error: string };

export interface DirProcessProbeOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  /** Override for tests: resolves to lsof's stdout, rejects when unavailable. */
  runLsof?: () => Promise<string>;
}

const LSOF_TIMEOUT_MS = 5_000;

function insideAny(path: string, roots: readonly string[]): boolean {
  const target = path.endsWith(' (deleted)') ? path.slice(0, -' (deleted)'.length) : path;
  return roots.some(root => target === root || target.startsWith(root + sep));
}

function dirRoots(dir: string): string[] {
  const roots = new Set([resolve(dir)]);
  try { roots.add(realpathSync(dir)); } catch { /* gone — the resolved form is all we have */ }
  return [...roots];
}

/** Parse `lsof -Fpn` output: `p<pid>` opens a process set, `n<path>` names its cwd. */
export function parseLsofCwdOutput(out: string, dir: string): number[] {
  const roots = dirRoots(dir);
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line.startsWith('n') && pid !== undefined && insideAny(line.slice(1), roots)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function defaultRunLsof(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-Fpn'], {
      encoding: 'utf-8',
      timeout: LSOF_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      // lsof exits 1 when some processes could not be inspected; the readable
      // ones are still listed. Anything else (missing binary, timeout) is unknown.
      const code = (error as { code?: unknown } | null)?.code;
      if (error && !(code === 1 && stdout)) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function findProcessesWithCwdUnder(
  dir: string,
  opts: DirProcessProbeOptions = {},
): Promise<DirProcessProbe> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') {
    const procRoot = opts.procRoot ?? '/proc';
    let entries: string[];
    try {
      entries = readdirSync(procRoot);
    } catch (error) {
      return { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    const roots = dirRoots(dir);
    const pids: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let cwd: string;
      try { cwd = readlinkSync(`${procRoot}/${entry}/cwd`); } catch { continue; }
      if (insideAny(cwd, roots)) pids.push(Number(entry));
    }
    return { status: 'ok', pids };
  }
  try {
    return { status: 'ok', pids: parseLsofCwdOutput(await (opts.runLsof ?? defaultRunLsof)(), dir) };
  } catch (error) {
    return { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
}
