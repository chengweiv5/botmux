import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pty from 'node-pty';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { tsEvalArgs } from './helpers/ts-runner.js';

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1 })) }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Pi model qualification reaches the backend process', () => {
  it.each(['pty', 'tmux-shell'] as const)('keeps model provider and actual cwd together through %s', backend => {
    const root = mkdtempSync(join(tmpdir(), 'pi-backend-cwd-'));
    roots.push(root);
    const daemon = join(root, 'daemon');
    mkdirSync(daemon);
    vi.spyOn(process, 'cwd').mockReturnValue(daemon);
    const adapter = createPiAdapter('/pi', () => '/tmp/synthetic-boundary.js');
    for (const name of ['bot-default', 'topic-session']) {
      const workingDir = join(root, name);
      mkdirSync(join(workingDir, 'relative-agent'), { recursive: true });
      writeFileSync(join(workingDir, 'relative-agent', 'settings.json'), JSON.stringify({ defaultProvider: name }));
      const env = { HOME: root, PI_CODING_AGENT_DIR: 'relative-agent', PATH: process.env.PATH };
      const args = adapter.buildArgs({ sessionId: 'synthetic', resume: false, model: 'shared', workingDir, env });
      if (backend === 'pty') {
        new PtyBackend().spawn('/pi', args, { cwd: workingDir, cols: 80, rows: 24, env, injectEnv: {} });
        const [bin, argv, options] = vi.mocked(pty.spawn).mock.calls.at(-1)!;
        expect(bin).toBe('/pi');
        expect(options.cwd).toBe(workingDir);
        expect(argv[argv.indexOf('--model') + 1]).toBe(`${name}/shared`);
        expect(resolve(options.cwd!, options.env!.PI_CODING_AGENT_DIR!)).toBe(join(workingDir, 'relative-agent'));
      } else {
        // Run the backend's real shell wrapper with a local argv/cwd recorder;
        // no tmux server or Pi runtime is started by this test.
        const recorder = tsEvalArgs('console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1), agentDir: process.env.PI_CODING_AGENT_DIR }))');
        const command = shellCommandArgv({ shell: '/bin/sh', flags: [] }, shellWrapperScript(join(root, 'bin')), [
          workingDir, ...buildBotmuxEnvAssignments({}, { PI_CODING_AGENT_DIR: 'relative-agent' }),
          recorder.command, ...recorder.args, '--', ...args,
        ]);
        const result = spawnSync(command[0]!, command.slice(1), { cwd: daemon, env, encoding: 'utf8', timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as { cwd: string; argv: string[]; agentDir: string };
        expect(report.cwd).toBe(realpathSync(workingDir));
        expect(report.argv[report.argv.indexOf('--model') + 1]).toBe(`${name}/shared`);
        expect(resolve(report.cwd, report.agentDir)).toBe(realpathSync(join(workingDir, 'relative-agent')));
      }
    }
  });
});
