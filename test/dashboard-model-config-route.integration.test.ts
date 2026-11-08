import { isInsideDir } from './helpers/require-fenced-data-dir.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { resolveNodeExecutable, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

// Execute dashboard.ts's actual HTTP handlers, not a reconstructed handler or
// mocked catalogue response. Only the external Pi binary is a metadata fixture.
const home = homedir();
if (!isInsideDir(home, process.env.__TEST_DATA_DIR_FENCE)) throw new Error('Dashboard route test requires fenced HOME');
const root = mkdtempSync(join(home, 'model-config-route-'));
const configDir = join(home, '.botmux');
const configPath = join(root, 'bots.json');
const token = 'synthetic-model-route-token';
const sourceCwd = join(root, 'daemon');
const botCwd = join(root, 'bot');
const registryCwd = join(root, 'registry');
const node = resolveNodeExecutable();
let child: ChildProcess | undefined;
let origin = '';
let logs = '';
let configuredText = '';
let botBinary = '';
let registryBinary = '';

function metadata(cwd: string, directory: string, providers: string[]): void {
  const dir = join(cwd, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: Object.fromEntries(providers.map(provider => [provider, {
    api: 'openai-completions', baseUrl: 'https://example.invalid', apiKey: '!never-execute', models: [{ id: 'shared' }, { id: 'only' }],
  }])) }));
}

function executable(name: string): string {
  const path = join(root, name);
  // The real directory service gives this binary only its sanitized scratch
  // metadata. Distinct binary rows also prove runtime selection and cache identity.
  writeFileSync(path, `#!${node}\nconst fs = require('node:fs');
    const providers = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', 'utf8')).providers;
    console.log('provider model context max-out thinking images');
    for (const [provider, data] of Object.entries(providers)) for (const m of data.models || [])
      console.log(provider + ' ' + m.id + ' 128K 16K yes no');
    console.log('runtime-${name} selected 128K 16K yes no');
  `);
  chmodSync(path, 0o755);
  return path;
}

async function request(route: 'models' | 'availability', bot?: string, key = 'pi') {
  const params = new URLSearchParams({ key });
  if (bot !== undefined) params.set('bot', bot);
  const res = await fetch(`${origin}/api/cli-options/${route}?${params}`, {
    headers: { cookie: `botmux_dashboard_token=${token}` }, signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeAll(async () => {
  if (process.platform === 'win32') return;
  if (!node) throw new Error('node required for executable metadata fixture');
  mkdirSync(configDir, { recursive: true });
  metadata(sourceCwd, 'ambient', ['daemon']);
  metadata(botCwd, 'bot-catalog', ['alpha', 'beta']);
  metadata(registryCwd, 'registry-catalog', ['registered']);
  botBinary = executable('disk-pi'); registryBinary = executable('registry-pi');
  const stockBin = join(root, 'stock-bin'); mkdirSync(stockBin);
  const stock = executable('pi'); renameSync(stock, join(stockBin, 'pi'));
  const rows = [
    { larkAppId: 'cli_disk', larkAppSecret: 'synthetic', cliId: 'pi', cliPathOverride: botBinary, defaultWorkingDir: botCwd, env: { PI_CODING_AGENT_DIR: 'bot-catalog' }, backendType: 'pty' },
    { larkAppId: 'cli_registered', larkAppSecret: 'synthetic', cliId: 'pi', cliPathOverride: botBinary, defaultWorkingDir: botCwd, env: { PI_CODING_AGENT_DIR: 'bot-catalog' }, backendType: 'pty' },
    { larkAppId: 'cli_claude', larkAppSecret: 'synthetic', cliId: 'claude-code' },
  ];
  configuredText = JSON.stringify(rows); writeFileSync(configPath, configuredText);
  writeFileSync(join(configDir, '.dashboard-token'), token, { mode: 0o600 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(BOTMUX_|BOTS_CONFIG|PI_|ANTHROPIC|OPENAI|AWS_|GOOGLE_|AZURE_|GEMINI_|LARK_|FEISHU_)/.test(key) && !/FENCE|TMUX/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, BOTS_CONFIG: configPath, SESSION_DATA_DIR: join(root, 'data'),
    BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PORT: String(port), BACKEND_TYPE: 'pty',
    BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false', PI_CODING_AGENT_DIR: 'ambient',
    PATH: `${stockBin}:${process.env.PATH}` });
  child = spawnTsEvalWithRepoImports(`
    const { Server } = await import('node:net');
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) { if (args[0] === 9768) args[0] = 0; return listen.apply(this,args); };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input,init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('External fetch forbidden in route test');
      return originalFetch(input,init);
    };
    const { registerBot } = await import('./src/bot-registry.js');
    registerBot(${JSON.stringify({ larkAppId: 'cli_registered', larkAppSecret: '', apiOnly: true, cliId: 'pi', cliPathOverride: registryBinary,
      defaultWorkingDir: registryCwd, env: { PI_CODING_AGENT_DIR: 'registry-catalog' }, backendType: 'pty' })});
    process.chdir(${JSON.stringify(sourceCwd)});
    await import(${JSON.stringify(resolve('src/index-dashboard.ts'))});
  `, { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', b => { logs += String(b); }); child.stderr?.on('data', b => { logs += String(b); });
  origin = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(logs);
    try { if ((await fetch(origin + '/__health')).ok) return; } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard startup timeout: ${logs}`);
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 5_000);
    try { await closed; } finally { clearTimeout(force); }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('actual Dashboard CLI configuration routes', () => {
  it('falls back to disk and preserves complete provider/id, cwd, env and executable identity', async () => {
    const response = await request('models', 'cli_disk');
    expect(response.status).toBe(200);
    expect(response.body.source).toBe('live');
    expect(response.body.models.sort()).toEqual(['alpha/only', 'alpha/shared', 'beta/only', 'beta/shared', 'runtime-disk-pi/selected']);
    expect(readFileSync(configPath, 'utf8')).toBe(configuredText);
  });

  it('uses the registered Bot rather than conflicting disk runtime, env and cwd', async () => {
    const response = await request('models', 'cli_registered');
    expect(response.status).toBe(200);
    expect(response.body.models.sort()).toEqual(['registered/only', 'registered/shared', 'runtime-registry-pi/selected']);
    expect(readFileSync(configPath, 'utf8')).toBe(configuredText);
  });

  it.each([['cli_disk', () => botBinary], ['cli_registered', () => registryBinary]] as const)
  ('resolves availability runtime from %s through the real route', async (id, bin) => {
    const response = await request('availability', id);
    expect(response).toEqual({ status: 200, body: { status: 'available', command: bin() } });
  });

  it('retains no-Bot preview and non-Pi defaults without borrowing a Bot', async () => {
    const preview = await request('models');
    expect(preview.status).toBe(200);
    expect(preview.body.models.sort()).toEqual(['daemon/only', 'daemon/shared', 'runtime-pi/selected']);
    expect(await request('availability')).toEqual({ status: 200, body: { status: 'available', command: 'pi' } });
    const claude = await request('models', 'cli_claude', 'claude-code');
    expect(claude.status).toBe(200); expect(claude.body.source).toBe('static');
    expect(claude.body.models).toContain('sonnet'); expect(claude.body.models.length).toBeGreaterThan(1);
  });

  it.each(['models', 'availability'] as const)('rejects an unknown explicit Bot on %s without probing another source', async route => {
    expect(await request(route, 'cli_missing')).toEqual({ status: 404, body: { ok: false, error: 'bot_not_found' } });
  });

  it.each(['models', 'availability'] as const)('fails closed on unavailable disk configuration for %s but keeps registry/no-Bot behavior', async route => {
    const backup = configPath + '.bak'; renameSync(configPath, backup); mkdirSync(configPath);
    try {
      expect(await request(route, 'cli_disk')).toEqual({ status: 503, body: { ok: false, error: 'bot_config_unavailable' } });
      expect((await request(route, 'cli_registered')).status).toBe(200);
      expect((await request(route)).status).toBe(200);
    } finally { rmSync(configPath, { recursive: true }); renameSync(backup, configPath); }
    expect(readFileSync(configPath, 'utf8')).toBe(configuredText);
  });

  it.each(['models', 'availability'] as const)('keeps invalid selection rejection ahead of Bot resolution for %s', async route => {
    expect(await request(route, 'cli_missing', 'unknown')).toEqual({ status: 400, body: { ok: false, error: 'unknown_selection_key' } });
  });

  it.each(['models', 'availability'] as const)('does not disguise malformed or missing configuration as an empty catalogue on %s', async route => {
    try {
      writeFileSync(configPath, '{invalid');
      expect(await request(route, 'cli_disk')).toEqual({ status: 503, body: { ok: false, error: 'bot_config_unavailable' } });
      rmSync(configPath);
      expect(await request(route, 'cli_disk')).toEqual({ status: 503, body: { ok: false, error: 'bot_config_unavailable' } });
    } finally { writeFileSync(configPath, configuredText); }
  });
});
