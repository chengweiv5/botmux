import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { getSessionWorkingDir } from '../src/core/session-manager.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import type { DaemonSession } from '../src/core/types.js';

const root = mkdtempSync(join(tmpdir(), 'catalogue-launch-cwd-'));
const live = join(root, 'live'), persisted = join(root, 'persisted'), botDefault = join(root, 'default');
for (const dir of [live, persisted, botDefault]) mkdirSync(dir);
afterEach(() => __testOnly_resetBotRegistry());

describe('catalogue launch cwd follows worker resolution without materializing state', () => {
  it.each(['pi', 'traex'] as const)('resolves %s default and session paths for both backend configurations', cliId => {
    for (const backendType of ['pty', 'tmux'] as const) {
      for (const scenario of [
        { name: 'HOME unpersisted', cfg: {}, session: { workingDir: homedir() }, expected: homedir() },
        { name: 'live wins over persisted', cfg: { defaultWorkingDir: botDefault }, session: { workingDir: live, session: { workingDir: persisted } }, expected: live },
        { name: 'cold persisted', cfg: { defaultWorkingDir: botDefault }, session: { session: { workingDir: persisted } }, expected: persisted },
        { name: 'unmaterialized default', cfg: { defaultWorkingDir: botDefault }, session: {}, expected: botDefault },
        { name: 'default unset', cfg: {}, session: undefined, expected: homedir() },
        { name: 'tilde default', cfg: { defaultWorkingDir: '~/catalogue-test' }, session: undefined, expected: join(homedir(), 'catalogue-test') },
        { name: 'gone pinned cwd never falls back', cfg: { defaultWorkingDir: botDefault }, session: { workingDir: join(root, 'gone') }, expected: join(root, 'gone') },
        { name: 'auto-worktree base is not launch cwd', cfg: { defaultWorkingDir: botDefault, defaultWorkingDirAutoWorktree: true, workingDir: persisted }, session: undefined, expected: persisted },
        { name: 'auto-worktree fallback HOME', cfg: { defaultWorkingDir: botDefault, defaultWorkingDirAutoWorktree: true }, session: {}, expected: homedir() },
        { name: 'adopt target only', cfg: { defaultWorkingDir: botDefault }, session: { adoptedFrom: { cwd: live } }, expected: live },
      ]) {
        __testOnly_resetBotRegistry();
        const app = `cwd-${cliId}-${backendType}`;
        registerBot({ larkAppId: app, larkAppSecret: 'synthetic', cliId, backendType,
          ...scenario.cfg, env: { HOME: join(root, 'bot-env-home') } });
        const cfg = getBot(app).config;
        const ds = scenario.session === undefined ? undefined : {
          larkAppId: app, ...scenario.session, session: { cliId, ...(scenario.session as any).session },
        } as DaemonSession;
        const before = JSON.stringify(ds);
        const probe = modelCatalogProbeContext(cliId, cfg, process.env, ds);
        expect(probe.probeCwd, `${backendType}: ${scenario.name}`).toBe(scenario.expected);
        expect(probe.probeEnv?.HOME).toBe(join(root, 'bot-env-home'));
        const workerShape = { larkAppId: app, workingDir: ds?.workingDir || ds?.session.workingDir || ds?.adoptedFrom?.cwd } as DaemonSession;
        expect(getSessionWorkingDir(workerShape), scenario.name).toBe(scenario.expected);
        expect(JSON.stringify(ds), 'read-only resolution').toBe(before);
      }
    }
  });

  it('does not borrow another selection runtime or cwd for a new-Bot preview', () => {
    const cfg = { larkAppId: 'shape', larkAppSecret: 'synthetic', cliId: 'pi' as const, defaultWorkingDir: botDefault };
    expect(modelCatalogProbeContext('traex', cfg, process.env).probeCwd).toBeUndefined();
    expect(modelCatalogProbeContext('pi', undefined, process.env).probeCwd).toBeUndefined();
  });
});

// Fixtures are never used as working directories by a real CLI or backend.
afterAll(() => rmSync(root, { recursive: true, force: true }));
