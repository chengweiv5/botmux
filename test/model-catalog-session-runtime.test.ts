import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { resolveCliRuntime } from '../src/adapters/cli/runtime.js';
import { __testOnly_sessionAgentConfig, resolveSessionEnvForSession } from '../src/core/worker-pool.js';
import { botInjectedEnv, buildBotWorkerEnv, buildSessionChildEnv } from '../src/core/env-policy.js';
import { applyGlobalSessionEnvOps, invalidateGlobalConfigCache } from '../src/global-config.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import { config } from '../src/config.js';
import { resolvePairedSpawnBackendType } from '../src/core/persistent-backend.js';
import type { BackendType } from '../src/adapters/backend/types.js';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/services/session-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/session-store.js')>(),
  updateSession: vi.fn(),
}));

const root = mkdtempSync(join(tmpdir(), 'model-runtime-'));
const old = join(root, 'old-pi'), current = join(root, 'current-pi');
const runtime = resolveCliRuntime({ cliId: 'pi', cliPathOverride: old })!;
let priorConfig: string | undefined;
let priorBackend: BackendType;
beforeEach(() => {
  priorBackend = config.daemon.backendType;
  priorConfig = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(mkdtempSync(join(root, 'config-')), 'config.json');
  invalidateGlobalConfigCache();
});
afterEach(() => {
  config.daemon.backendType = priorBackend;
  __testOnly_resetBotRegistry();
  if (priorConfig === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  else process.env.BOTMUX_GLOBAL_CONFIG_FILE = priorConfig;
  invalidateGlobalConfigCache();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('session catalogue runtime matches worker launch resolution', () => {
  it.each(['pty', 'tmux', 'remote-runner', 'riff', 'mojo'] as const)('pairs Bot defaults but does not borrow env for a different preview (%s)', backendType => {
    const cfg: any = { larkAppId: 'default-pair', larkAppSecret: 'synthetic', cliId: 'pi', backendType,
      cliPathOverride: current, env: { PI_CODING_AGENT_DIR: '/synthetic/bot' } };
    applyGlobalSessionEnvOps([{ op: 'set', key: 'GLOBAL_ONLY', value: 'global' }]);
    const defaults = modelCatalogProbeContext('pi', cfg, {});
    expect(defaults.canProbe).toBe(true);
    expect(defaults.runtimeExecutable).toBe(current);
    expect(defaults.probeEnv).toMatchObject({ GLOBAL_ONLY: 'global', PI_CODING_AGENT_DIR: '/synthetic/bot' });
    const preview = modelCatalogProbeContext('codex', cfg, {});
    expect(preview.canProbe).toBe(true);
    expect(preview.runtimeExecutable).toBeUndefined();
    expect(preview.probeEnv).toBeUndefined();
    const remote = modelCatalogProbeContext('mojo', cfg, {});
    expect(remote.canProbe).toBe(false);
  });

  it.each((['pty', 'remote-runner', 'riff', 'mojo'] as const).flatMap(botBackend =>
    (['pty', 'tmux', 'riff'] as const).flatMap(daemonBackend =>
      ['legacy', 'frozen', 'selected'].flatMap(state =>
        ['missing', 'stamp-local', 'stamp-remote', 'live-local', 'live-remote'].map(source => ({ botBackend, daemonBackend, state, source })))),
  ))('pairs actual local CLI before gate and env ($botBackend, daemon=$daemonBackend, $state, $source)', ({ botBackend, daemonBackend, state, source }) => {
    config.daemon.backendType = daemonBackend;
    applyGlobalSessionEnvOps([{ op: 'set', key: 'PI_CODING_AGENT_DIR', value: '/synthetic/global-agent' },
      { op: 'set', key: 'ZDOTDIR', value: '/synthetic/global-shell' }]);
    const cfg: any = { larkAppId: 'paired', larkAppSecret: 'synthetic', cliId: 'claude-code', backendType: botBackend };
    const ds = { larkAppId: cfg.larkAppId, chatId: 'oc_chat', workingDir: root,
      ...(source.startsWith('live') ? { initConfig: { backendType: source === 'live-local' ? 'tmux' : 'remote-runner' } } : {}),
      session: { sessionId: 'paired', cliId: state === 'selected' ? 'codex' : 'pi', agentFrozen: state !== 'legacy',
        cliPathOverride: old, cliRuntime: state === 'legacy' ? undefined : runtime,
        backendType: source === 'missing' ? undefined : source === 'stamp-remote' || source === 'live-local' ? 'riff' : 'pty',
        ...(state === 'selected' ? { cliLaunchSnapshot: { cliId: 'pi', state: 'resolved', cliRuntime: runtime,
          cliPathOverride: old, startupCommands: [] } } : {}),
      } } as DaemonSession;
    const before = JSON.stringify(ds), probe = modelCatalogProbeContext('pi', cfg, {}, ds);
    if (state === 'selected' && botBackend === 'riff') {
      expect(() => __testOnly_sessionAgentConfig(structuredClone(ds), cfg)).toThrow();
      expect(probe.canProbe).toBe(false);
    } else {
      const worker = __testOnly_sessionAgentConfig(structuredClone(ds), cfg);
      expect(worker.cliId).toBe('pi');
      const paired = ds.initConfig?.backendType ?? resolvePairedSpawnBackendType(worker.cliId,
        ds.session.backendType, cfg.backendType, config.daemon.backendType);
      expect(probe.canProbe).toBe(paired !== 'remote-runner');
      expect(probe.runtimeExecutable).toBe(worker.cliPathOverride);
      expect(probe.probeEnv).toEqual(resolveSessionEnvForSession(ds, cfg, paired).env ?? {});
      expect(probe.probeCwd).toBe(root);
    }
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each((['riff', 'mojo', 'remote-runner'] as const).flatMap(cliId =>
    (['pty', 'remote-runner', 'riff', 'mojo'] as const).flatMap(botBackend =>
      ['missing', 'stamp-local', 'live-local', 'live-remote'].map(source => ({ cliId, botBackend, source }))),
  ))('never probes a truly remote CLI ($cliId, $botBackend, $source)', ({ cliId, botBackend, source }) => {
    const cfg: any = { larkAppId: 'true-remote', larkAppSecret: 'synthetic', cliId: 'pi', backendType: botBackend };
    const ds = { larkAppId: cfg.larkAppId, chatId: 'oc_chat',
      ...(source.startsWith('live') ? { initConfig: { backendType: source === 'live-local' ? 'pty' : cliId } } : {}),
      session: { cliId, agentFrozen: true, backendType: source === 'stamp-local' ? 'pty' : undefined } } as DaemonSession;
    const before = JSON.stringify(ds);
    expect(modelCatalogProbeContext(cliId, cfg, {}, ds).canProbe).toBe(false);
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each(['lark', 'http', 'external', 'api-only', 'binding-off', 'trigger-on'])(
    'follows actual session identity wrapper facts (%s)', mode => {
      const cfg: any = { larkAppId: `facts-${mode}`, larkAppSecret: 'synthetic', cliId: 'claude-code',
        env: { ZDOTDIR: '/synthetic/shell', BASH_ENV: '/synthetic/startup' },
        apiOnly: mode === 'api-only', larkToolBinding: mode !== 'binding-off', triggerUserAuth: { enabled: mode === 'trigger-on' } };
      const ds = { larkAppId: cfg.larkAppId, chatId: mode === 'http' || mode === 'trigger-on' ? 'http_async_test' : 'oc_chat',
        session: { cliId: 'pi', agentFrozen: true, cliRuntime: runtime,
          ...(mode === 'external' ? { existingAppServerEndpoint: 'ws://synthetic' } : {}) } } as DaemonSession;
      const probe = modelCatalogProbeContext('pi', cfg, {}, ds);
      expect(probe.probeEnv).toEqual(resolveSessionEnvForSession(ds, cfg).env ?? {});
      expect(probe.probeEnv?.ZDOTDIR).toBe(mode === 'lark' || mode === 'trigger-on' ? undefined : '/synthetic/shell');
    },
  );

  it.each(['pty', 'remote-runner'] as const)('honors live backend over stored and Bot backend (%s)', backendType => {
    const cfg: any = { larkAppId: 'live-backend', larkAppSecret: 'synthetic', cliId: 'pi', backendType: 'tmux', env: { ZDOTDIR: '/synthetic/shell' } };
    const ds = { larkAppId: cfg.larkAppId, chatId: 'oc_chat', initConfig: { backendType },
      session: { cliId: 'pi', cliRuntime: runtime, agentFrozen: true, backendType: 'tmux' } } as DaemonSession;
    const probe = modelCatalogProbeContext('pi', cfg, {}, ds);
    expect(probe.canProbe).toBe(backendType === 'pty');
    expect(probe.probeEnv).toEqual(resolveSessionEnvForSession(ds, cfg).env ?? {});
  });

  it('honors configured protected env redaction in session discovery', () => {
    writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE!, JSON.stringify({ protectedMcpCapabilities: { legacy: {
      secret: { source: 'env', name: 'PRIVATE_AUTH' }, isolation: { redactEnv: ['PRIVATE_EXTRA'] },
    } } }));
    invalidateGlobalConfigCache();
    const cfg: any = { larkAppId: 'protected', larkAppSecret: 'synthetic', cliId: 'claude-code',
      env: { PRIVATE_AUTH: 'synthetic-secret', PRIVATE_EXTRA: 'synthetic-extra', VISIBLE: 'keep' } };
    const ds = { larkAppId: cfg.larkAppId, chatId: 'oc_chat', session: { cliId: 'pi', agentFrozen: true, cliRuntime: runtime } } as DaemonSession;
    const probe = modelCatalogProbeContext('pi', cfg, { PRIVATE_AUTH: 'ambient', PRIVATE_EXTRA: 'ambient' }, ds);
    expect(probe.probeEnv).toEqual({ VISIBLE: 'keep' });
    expect(probe.fingerprint).toBe(resolveSessionEnvForSession(ds, cfg).fingerprint);
  });

  it.each(['pty', 'tmux'] as const)('discovers a runnable legacy cross-CLI own path without freezing (%s)', backendType => {
    const cfg = { larkAppId: `legacy-${backendType}`, larkAppSecret: 'synthetic', cliId: 'claude-code' as const, backendType,
      cliRuntime: resolveCliRuntime({ cliId: 'claude-code', cliPathOverride: current }) };
    registerBot(cfg);
    const ds = { larkAppId: cfg.larkAppId, chatId: 'oc_chat', workingDir: root,
      session: { sessionId: cfg.larkAppId, cliId: 'pi', cliPathOverride: old, agentFrozen: false, backendType } } as DaemonSession;
    const before = JSON.stringify(ds);
    const probe = modelCatalogProbeContext('pi', cfg, process.env, ds);
    const worker = __testOnly_sessionAgentConfig(structuredClone(ds), cfg);
    expect(probe.canProbe).toBe(true);
    expect(probe.runtimeExecutable).toBe(worker.cliPathOverride);
    expect(probe.runtimeExecutable).toBe(old);
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each((['pi', 'claude-code'] as const).flatMap(cliId =>
    (['pty', 'tmux'] as const).flatMap(backendType =>
      ['legacy', 'frozen', 'snapshot', 'binding'].flatMap(state =>
        [false, true].map(strict => ({ cliId, backendType, state, strict })))),
  ))('uses effective worker overlay ($cliId, $backendType, $state, strict=$strict)', ({ cliId, backendType, state, strict }) => {
    applyGlobalSessionEnvOps([
      { op: 'set', key: 'PI_CODING_AGENT_DIR', value: '/synthetic/global-agent' },
      { op: 'set', key: 'GLOBAL_ONLY', value: 'global' },
      { op: 'unset', key: 'GLOBAL_REMOVED' },
    ]);
    const app = `${cliId}-${backendType}-${state}-${strict}`;
    registerBot({ larkAppId: app, larkAppSecret: 'synthetic', cliId, backendType,
      env: state === 'snapshot' ? undefined : { PI_CODING_AGENT_DIR: '/synthetic/bot-agent',
        SHARED_PROVIDER: 'synthetic', ZDOTDIR: '/synthetic/wrong-shell', BASH_ENV: '/synthetic/wrong-shell' },
      envUnset: ['BOT_REMOVED'], envPolicy: strict ? { mode: 'strict', inherit: ['AMBIENT_GRANTED'] } : undefined });
    const cfg = getBot(app).config;
    const ds = { larkAppId: app, chatId: 'oc_chat', workingDir: root, session: {
      sessionId: app, cliId: 'pi', cliPathOverride: old, cliRuntime: runtime, agentFrozen: state !== 'legacy', backendType,
      ...(state === 'snapshot' ? { cliLaunchSnapshot: { state: 'resolved', cliId: 'pi', cliRuntime: runtime, cliPathOverride: old } } : {}),
      ...(state === 'binding' ? { cliInstanceBinding: { instanceId: 'synthetic' } } : {}),
    } } as DaemonSession;
    const before = JSON.stringify(ds);
    const base = { PATH: process.env.PATH, HOME: root, AMBIENT_GRANTED: 'keep', AMBIENT_OTHER: 'ambient',
      BOT_REMOVED: 'remove', GLOBAL_REMOVED: 'remove' };
    const worker = resolveSessionEnvForSession(ds, cfg);
    const expected = { ...buildSessionChildEnv(buildBotWorkerEnv(base, cfg.envPolicy), cfg.envPolicy, worker.envUnset),
      ...botInjectedEnv(worker.env, cfg.envPolicy) };
    const probe = modelCatalogProbeContext('pi', cfg, base, ds);
    expect(probe.probeEnv).toEqual(expected);
    expect(probe.probeEnv?.PI_CODING_AGENT_DIR).toBe(state === 'snapshot' || state === 'binding'
      ? '/synthetic/global-agent' : '/synthetic/bot-agent');
    expect(probe.probeEnv?.AMBIENT_GRANTED).toBe('keep');
    expect(probe.probeEnv?.AMBIENT_OTHER).toBe(strict ? undefined : 'ambient');
    expect(probe.probeEnv?.BOT_REMOVED).toBeUndefined();
    expect(probe.probeEnv?.GLOBAL_REMOVED).toBeUndefined();
    expect(probe.probeEnv?.ZDOTDIR).toBeUndefined();
    expect(probe.probeEnv?.BASH_ENV).toBeUndefined();
    expect(probe.canProbe).toBe(true);
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each(['missing-path', 'inherited-wrapper', 'inherited-mode', 'unknown-own-wrapper'])('declines indeterminate legacy cross-CLI shape (%s)', mode => {
    const cfg: any = { larkAppId: 'legacy-guard', larkAppSecret: 'synthetic', cliId: 'claude-code', cliPathOverride: current };
    const ds: any = { session: { cliId: 'pi', agentFrozen: false, cliPathOverride: old } };
    if (mode === 'missing-path') delete ds.session.cliPathOverride;
    if (mode === 'inherited-wrapper') cfg.wrapperCli = 'ttadk-x-claude';
    if (mode === 'inherited-mode') cfg.cliLaunchMode = 'cli';
    if (mode === 'unknown-own-wrapper') ds.session.wrapperCli = 'unknown';
    const before = JSON.stringify(ds);
    expect(modelCatalogProbeContext('pi', cfg, process.env, ds).canProbe).toBe(false);
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each((['pi', 'claude-code'] as const).flatMap(cliId =>
    (['pty', 'tmux'] as const).flatMap(backendType =>
      ['snapshot', 'pending', 'runtime', 'runtime-no-shadow', 'legacy-path', 'stock'].map(mode => ({ cliId, backendType, mode }))),
  ))('keeps the session runtime when Bot changes ($cliId, $backendType, $mode)', ({ cliId, backendType, mode }) => {
    const app = `${cliId}-${backendType}-${mode}`;
    const cwd = join(root, app);
    mkdirSync(cwd);
    registerBot({ larkAppId: app, larkAppSecret: 'synthetic', cliId, backendType,
      cliPathOverride: cliId === 'pi' ? current : undefined, defaultWorkingDir: cwd });
    const ds = { larkAppId: app, workingDir: cwd, session: {
      sessionId: app, cliId: 'pi', agentFrozen: true, backendType,
      cliRuntime: mode.startsWith('runtime') ? runtime : undefined,
      cliPathOverride: mode === 'stock' || mode === 'runtime-no-shadow' ? undefined : mode === 'runtime' ? current : old,
      ...(mode === 'snapshot' || mode === 'pending' ? { cliLaunchSnapshot: {
        version: 1, state: mode === 'pending' ? 'pending' : 'resolved', entryId: 'pi', cliId: 'pi',
        cliRuntime: runtime, cliPathOverride: old, wrapperCli: null, cliLaunchMode: null,
        model: null, reasoningEffort: null, startupCommands: [], launchShell: null,
      } } : {}),
    } } as DaemonSession;
    const before = JSON.stringify(ds);
    const cfg = getBot(app).config;
    const probe = modelCatalogProbeContext('pi', cfg, process.env, ds);
    expect(JSON.stringify(ds)).toBe(before);
    const launched = __testOnly_sessionAgentConfig(structuredClone(ds), cfg);
    expect(probe.runtimeExecutable).toBe(launched.cliPathOverride);
    expect(probe.runtimeExecutable).toBe(mode === 'stock' ? undefined : old);
    expect(modelCatalogProbeContext(cliId, cfg, process.env).runtimeExecutable).toBe(cliId === 'pi' ? current : undefined);
  });

  it('uses worker legacy pre-freeze fallback without mutating a partial session', () => {
    for (const ownPath of [undefined, old]) {
      const app = `unfrozen-${ownPath ? 'own' : 'bot'}`;
      registerBot({ larkAppId: app, larkAppSecret: 'synthetic', cliId: 'pi', cliPathOverride: current });
      const ds = { larkAppId: app, session: { sessionId: app, cliId: 'pi', cliPathOverride: ownPath } } as DaemonSession;
      const before = JSON.stringify(ds);
      const probe = modelCatalogProbeContext('pi', getBot(app).config, process.env, ds);
      const launched = __testOnly_sessionAgentConfig(structuredClone(ds), getBot(app).config);
      expect(probe.runtimeExecutable).toBe(launched.cliPathOverride);
      expect(JSON.stringify(ds)).toBe(before);
    }
  });

  it.each(['pi', 'claude-code'] as const)('keeps env layers separate from runtime freeze with Bot %s', cliId => {
    const app = `env-${cliId}`;
    registerBot({ larkAppId: app, larkAppSecret: 'synthetic', cliId,
      env: { PI_CODING_AGENT_DIR: '/synthetic/bot-agent', BOT_PROBE_SECRET: 'synthetic' },
      envUnset: ['REMOVE_FOR_ALL'] });
    const ds = { larkAppId: app, workingDir: root, session: { cliId: 'pi', agentFrozen: true, cliRuntime: runtime } } as DaemonSession;
    const base = { PATH: process.env.PATH, HOME: root, REMOVE_FOR_ALL: 'remove', KEEP_AMBIENT: 'keep' };
    const probe = modelCatalogProbeContext('pi', getBot(app).config, base, ds);
    expect(probe.runtimeExecutable).toBe(old);
    expect(probe.probeEnv?.REMOVE_FOR_ALL).toBeUndefined();
    expect(probe.probeEnv?.KEEP_AMBIENT).toBe('keep');
    expect(probe.probeEnv?.BOT_PROBE_SECRET).toBe('synthetic');
    expect(probe.probeEnv?.PI_CODING_AGENT_DIR).toBe('/synthetic/bot-agent');
  });

  it('keeps worker cwd fallback independent of a frozen cross-CLI executable', () => {
    registerBot({ larkAppId: 'cross-fallback', larkAppSecret: 'synthetic', cliId: 'claude-code', defaultWorkingDir: root,
      env: { PI_CODING_AGENT_DIR: '/synthetic/configured-agent' } });
    const ds = { larkAppId: 'cross-fallback', session: { cliId: 'pi', agentFrozen: true, cliRuntime: runtime } } as DaemonSession;
    const probe = modelCatalogProbeContext('pi', getBot(ds.larkAppId).config, process.env, ds);
    expect(probe.runtimeExecutable).toBe(old);
    expect(probe.probeCwd).toBe(root);
    expect(probe.probeEnv?.PI_CODING_AGENT_DIR).toBe('/synthetic/configured-agent');
  });

  it('treats selected stock as explicit and never borrows a legacy session or Bot path', () => {
    const cfg = { larkAppId: 'stock', larkAppSecret: 'synthetic', cliId: 'pi' as const, cliPathOverride: current };
    const ds = { session: { cliId: 'pi', cliRuntime: runtime, cliPathOverride: old,
      cliLaunchSnapshot: { cliId: 'pi', state: 'pending', cliRuntime: null, cliPathOverride: null, wrapperCli: null, cliLaunchMode: null } } } as DaemonSession;
    const probe = modelCatalogProbeContext('pi', cfg, process.env, ds);
    expect(probe.canProbe).toBe(true);
    expect(probe.runtimeExecutable).toBeUndefined();
    expect(ds.session.cliLaunchSnapshot?.state).toBe('pending');
  });

  it.each(['remote', 'unknown-wrapper', 'snapshot-env', 'snapshot-path-missing', 'snapshot-unresolved'])(
    'declines unavailable probe inputs without mutation (%s)', mode => {
      const cfg: any = { larkAppId: 'guard', larkAppSecret: 'synthetic', cliId: 'pi', cliPathOverride: current };
      const ds: any = { session: { cliId: 'pi', agentFrozen: true, cliRuntime: runtime } };
      if (mode === 'remote') ds.initConfig = { backendType: 'remote-runner' };
      if (mode === 'unknown-wrapper') ds.session.wrapperCli = 'unregistered-wrapper';
      if (mode.startsWith('snapshot')) ds.session.cliLaunchSnapshot = {
        cliId: 'pi', state: 'resolved', cliRuntime: runtime, cliPathOverride: old,
      };
      if (mode === 'snapshot-env') cfg.env = { SYNTHETIC_SECRET: 'not-for-selected-cli' };
      if (mode === 'snapshot-path-missing') delete ds.session.cliLaunchSnapshot.cliPathOverride;
      if (mode === 'snapshot-unresolved') ds.session.cliLaunchSnapshot.state = 'invalid';
      const before = JSON.stringify(ds);
      expect(modelCatalogProbeContext('pi', cfg, process.env, ds).canProbe).toBe(false);
      expect(JSON.stringify(ds)).toBe(before);
    },
  );
});
