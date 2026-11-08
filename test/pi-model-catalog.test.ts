import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPiModelCatalog, parsePiModelList } from '../src/services/pi-model-catalog.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createModelCatalog, buildModelChoicesResponse, MODEL_DETECT_TTL_MS } from '../src/services/model-catalog.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import type { BotConfig } from '../src/bot-registry.js';
import * as globalConfig from '../src/global-config.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execMock = vi.mocked(execFile);
const roots: string[] = [];
const header = 'provider model context max-out thinking images';
function table(models: string[]): string {
  return [header, ...models.map(slug => {
    const slash = slug.indexOf('/');
    return `${slug.slice(0, slash)} ${slug.slice(slash + 1)} 128K 16K yes no`;
  })].join('\n');
}
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'botmux-pi-model-test-'));
  roots.push(path);
  return path;
}
function config(dir: string, models: string[]): void {
  mkdirSync(dir, { recursive: true });
  const providers: Record<string, { api: string; models: { id: string }[] }> = {};
  for (const slug of models) {
    const [provider, ...parts] = slug.split('/');
    (providers[provider!] ??= { api: 'openai-completions', models: [] }).models.push({ id: parts.join('/') });
  }
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers }));
}
type ProbeOptions = { env: NodeJS.ProcessEnv; cwd: string; timeout: number; maxBuffer: number };
function respond(fn: (options: ProbeOptions, bin: string, args: string[]) => string): void {
  execMock.mockImplementation(((bin: string, args: string[], options: ProbeOptions, cb: Function) => {
    try { cb(null, { stdout: fn(options, bin, args), stderr: '' }); }
    catch (error) { cb(error); }
  }) as typeof execFile);
}
function mirrorResponse({ cwd }: ProbeOptions): string {
  const { providers } = JSON.parse(readFileSync(join(cwd, 'models.json'), 'utf8'));
  return table(Object.entries(providers).flatMap(([provider, value]: [string, any]) =>
    (value.models ?? []).map((m: { id: string }) => `${provider}/${m.id}`)));
}

beforeEach(() => { execMock.mockReset(); });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('parsePiModelList', () => {
  it('keeps provider-qualified ids, nested ids and same-name providers, deduplicating only full ids', () => {
    const ids = ['alpha/shared', 'beta/shared', 'alpha/vendor/model', 'alpha/shared'];
    expect(parsePiModelList(`startup notice\n${table(ids)}\n`)).toEqual(ids.slice(0, 3));
  });

  it('rejects unrelated output and malformed individual rows without discarding valid rows', () => {
    expect(parsePiModelList('alpha shared 128K 16K yes no')).toEqual([]);
    expect(parsePiModelList(`${header}\nalpha/invalid shared 128K 16K yes no\nalpha bad NaN 16K yes no\n${table(['beta/valid'])}`))
      .toEqual(['beta/valid']);
    expect(parsePiModelList('')).toEqual([]);
  });

  it('accepts large native catalogs without truncating later providers', () => {
    const models = Array.from({ length: 12_000 }, (_, n) => `provider-${n % 4}/model-${n}`);
    expect(parsePiModelList(table(models))).toEqual(models);
  });
});

describe('loadPiModelCatalog', () => {
  it('uses an isolated credential-blind metadata mirror and cleans it after native discovery', async () => {
    const dir = directory();
    const helper = `!touch ${join(dir, 'helper-ran')}`;
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {
      alpha: { api: 'openai-completions', apiKey: helper, headers: { Authorization: 'private-header' }, models: [
        { id: 'shared', headers: { secret: helper } }, { id: 'only' }, null, { id: 42 }, { id: '' }, { id: 'not-chat', type: 'image' },
      ] },
      beta: { api: 'openai-responses', apiKey: 'private-key', models: [{ id: 'shared' }] },
      invalid: null,
    } }));
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      loggedIn: { type: 'oauth', access: 'private-access', refresh: helper, expires: 0 },
      keyed: { type: 'api_key', key: helper }, empty: { type: 'api_key', key: '' }, invalid: null,
    }));
    writeFileSync(join(dir, 'models-store.json'), JSON.stringify({
      loggedIn: { models: [{ id: 'cached', provider: 'loggedIn', api: 'openai-responses', headers: { secret: helper } }], credential: 'private-store' },
    }));
    const original = readFileSync(join(dir, 'models.json'), 'utf8');
    let scratch = '';
    let observed: { options: ProbeOptions; args: string[]; providers: any; stored: any; auth: any; bin: string } | undefined;
    respond((options, bin, args) => {
      scratch = options.cwd;
      observed = { options, bin, args,
        providers: JSON.parse(readFileSync(join(scratch, 'models.json'), 'utf8')).providers,
        stored: JSON.parse(readFileSync(join(scratch, 'models-store.json'), 'utf8')),
        auth: JSON.parse(readFileSync(join(scratch, 'auth.json'), 'utf8')),
      };
      return mirrorResponse(options);
    });
    const result = await loadPiModelCatalog({ cliBin: '/target/pi', env: {
      HOME: dir, PI_CODING_AGENT_DIR: dir, PATH: '/target/bin', ANTHROPIC_API_KEY: 'private-env',
      NODE_OPTIONS: '--require /private/loader', GOOGLE_APPLICATION_CREDENTIALS: '/private/credentials',
      AWS_PROFILE: 'private-profile',
    } });
    expect(result).toEqual(['alpha/shared', 'alpha/only', 'beta/shared']);
    expect(observed!.bin).toBe('/target/pi');
    expect(observed!.args).toEqual(expect.arrayContaining(['--list-models', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']));
    expect(observed!.providers.loggedIn.apiKey).toBeTruthy();
    expect(observed!.providers.keyed.apiKey).toBeTruthy();
    expect(observed!.providers['amazon-bedrock'].apiKey).toBeTruthy();
    expect(observed!.providers.empty).toBeUndefined();
    expect(observed!.stored.loggedIn.models[0]).toMatchObject({ id: 'cached', provider: 'loggedIn' });
    expect(observed!.auth).toEqual({});
    expect(observed!.options.env).toMatchObject({ HOME: scratch, PI_CODING_AGENT_DIR: scratch, PI_OFFLINE: '1', PI_TELEMETRY: '0', PATH: '/target/bin' });
    expect(observed!.options.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(observed!.options.env.NODE_OPTIONS).toBeUndefined();
    expect(observed!.options.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(JSON.stringify(observed)).not.toMatch(/private-|!touch/);
    expect(observed!.options.timeout).toBeGreaterThan(0);
    expect(observed!.options.timeout).toBeLessThanOrEqual(10_000);
    expect(observed!.options.maxBuffer).toBeGreaterThan(Buffer.byteLength(table(Array.from({ length: 12_000 }, (_, n) => `p/m${n}`))));
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(dir, 'helper-ran'))).toBe(false);
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(original);
  });

  it('takes HOME and PI_CODING_AGENT_DIR from the target env, never the ambient bot', async () => {
    const first = directory(), second = directory(), overlay = directory();
    config(join(first, '.pi', 'agent'), ['ambient/one']);
    config(join(second, '.pi', 'agent'), ['target/two']);
    config(overlay, ['overlay/three']);
    vi.stubEnv('PI_CODING_AGENT_DIR', join(first, '.pi', 'agent'));
    respond(mirrorResponse);
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { HOME: second } })).resolves.toEqual(['target/two']);
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { HOME: second, PI_CODING_AGENT_DIR: overlay } })).resolves.toEqual(['overlay/three']);
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { HOME: second, PI_CODING_AGENT_DIR: '~/.pi/agent' } })).resolves.toEqual(['target/two']);
  });

  it('accepts Pi models.json comments and BOM without changing strings or running helper values', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'models.json'), '\uFEFF' + `{
      // configured provider
      "providers": { "alpha": { "api": "openai-completions",
        "baseUrl": "https://example.invalid/a//b", "apiKey": "!never-run",
        "models": [{ "id": "vendor/model", "name": "quoted \\\" // name" }]
      } }
    }`);
    respond(mirrorResponse);
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir } }))
      .resolves.toEqual(['alpha/vendor/model']);
  });

  it('accepts JSONC object and array trailing commas without altering escaped strings', async () => {
    const dir = directory();
    const id = 'escaped-"-\\-,}-//-/*';
    writeFileSync(join(dir, 'models.json'), `{
      // line comment
      "providers": { "alpha": { "api": "openai-completions",
        "models": [{ "id": ${JSON.stringify(id)}, },],
      }, },
    }`);
    respond(mirrorResponse);
    expect(await loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir } }))
      .toEqual([`alpha/${id}`]);
  });

  it.each(['{"providers":{,}}', '{"providers":{"alpha":{},,}}', '{/* never closed',
    '{"providers":{"alpha":{"api":"openai-completions",/* invalid */"models":[{"id":"x"}]}}}',
    '{"providers":{"alpha":{"models":[,]}}}', '{"providers":{"alpha":{"models":[{"id":"x"},,]}}}',
    '{"providers": {alpha: {}}}', '{"providers":{} trailing}'])
  ('rejects illegal JSONC instead of normalizing it into a catalog (%s)', async raw => {
    const dir = directory();
    writeFileSync(join(dir, 'models.json'), raw);
    let mirrored: any;
    respond(options => {
      mirrored = JSON.parse(readFileSync(join(options.cwd, 'models.json'), 'utf8'));
      return mirrorResponse(options);
    });
    expect(await loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir } })).toBeNull();
    expect(mirrored.providers).toEqual({});
  });

  it('drops block-comment config without losing independently configured providers', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'models.json'), '{"providers":{/* rejected */"alpha":{"api":"openai-completions","models":[{"id":"x"}]}}}');
    respond(options => {
      const providers = JSON.parse(readFileSync(join(options.cwd, 'models.json'), 'utf8')).providers;
      expect(providers.alpha).toBeUndefined();
      return options.env.HF_TOKEN ? table(['huggingface/env-model']) : header;
    });
    expect(await loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir, HF_TOKEN: 'private-token' } }))
      .toEqual(['huggingface/env-model']);
  });

  it.each([undefined, '', '{broken', 'null', '[]', '{"providers":{}}', '{"providers":{"bad":null}}'])
  ('fails soft with missing, empty or broken model metadata (%s)', async raw => {
    const dir = directory();
    if (raw !== undefined) writeFileSync(join(dir, 'models.json'), raw);
    respond(mirrorResponse);
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir } })).resolves.toBeNull();
  });

  it.each(['ENOENT', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])('cleans temporary files and fails soft on %s', async code => {
    const dir = directory();
    let scratch = '';
    respond(options => { scratch = options.cwd; throw Object.assign(new Error('sensitive stderr'), { code }); });
    await expect(loadPiModelCatalog({ cliBin: '/pi', env: { PI_CODING_AGENT_DIR: dir } })).resolves.toBeNull();
    expect(existsSync(scratch)).toBe(false);
  });
});

describe('Pi adapter and Dashboard model catalog integration', () => {
  it.each(['pty', 'tmux'] as const)('discovers relative agent dirs in the Bot default cwd and isolates cwd caches for %s', async backendType => {
    const daemon = directory(), botCwd = directory(), sessionCwd = directory();
    config(join(daemon, 'relative-agent'), ['dashboard-provider/shared']);
    config(join(botCwd, 'relative-agent'), ['bot-provider/shared']);
    config(join(sessionCwd, 'relative-agent'), ['session-provider/shared']);
    vi.spyOn(process, 'cwd').mockReturnValue(daemon);
    vi.spyOn(globalConfig, 'readRawGlobalSessionEnv').mockReturnValue({ set: {}, unset: [] });
    const bot = { larkAppId: `cli_cwd_${backendType}_${botCwd}`, cliId: 'pi', backendType,
      workingDir: daemon, defaultWorkingDir: botCwd, cliPathOverride: '/pi',
      env: { PI_CODING_AGENT_DIR: 'relative-agent' } } as BotConfig;
    respond(mirrorResponse);
    const probe = modelCatalogProbeContext('pi', bot, { HOME: directory() });
    expect((await buildModelChoicesResponse('pi', probe)).models).toEqual(['bot-provider/shared']);
    const catalog = createModelCatalog();
    const requests = await Promise.all([
      catalog.detectModels('pi', probe),
      catalog.detectModels('pi', { ...probe, probeCwd: sessionCwd }),
      catalog.detectModels('pi', { ...probe, probeCwd: daemon }),
    ]);
    expect(requests).toEqual([['bot-provider/shared'], ['session-provider/shared'], ['dashboard-provider/shared']]);
    config(join(botCwd, 'relative-agent'), ['changed/shared']);
    expect(await catalog.detectModels('pi', probe)).toEqual(['bot-provider/shared']);
    expect(execMock).toHaveBeenCalledTimes(4);
    // A changed CLI selection must not borrow this Bot's env or cwd.
    expect(modelCatalogProbeContext('codex', bot, {})).toMatchObject({ probeEnv: undefined, probeCwd: undefined });
  });

  it.each(['HF_TOKEN', 'COPILOT_GITHUB_TOKEN'])('honors Bot set/unset of %s with only credential markers', async key => {
    vi.spyOn(globalConfig, 'readRawGlobalSessionEnv').mockReturnValue({ set: {}, unset: [] });
    const home = directory();
    const bot = { larkAppId: `cli_token_${key}_${home}`, cliId: 'pi', cliPathOverride: '/pi' } as BotConfig;
    const request = (shape: BotConfig) => modelCatalogProbeContext('pi', shape, { HOME: home, [key]: 'private-parent-token' });
    const observed: NodeJS.ProcessEnv[] = [];
    respond(options => {
      observed.push(options.env);
      const value = options.env[key];
      return value ? table([`${key === 'HF_TOKEN' ? 'huggingface' : 'github-copilot'}/native-model`]) : header;
    });
    const expected = [`${key === 'HF_TOKEN' ? 'huggingface' : 'github-copilot'}/native-model`];
    expect((await buildModelChoicesResponse('pi', request(bot))).models).toEqual(expected);
    expect((await buildModelChoicesResponse('pi', request({ ...bot, envUnset: [key] }))).models).toEqual([]);
    expect((await buildModelChoicesResponse('pi', request({ ...bot, env: { [key]: 'private-bot-token', UNRELATED_TOKEN: 'private-other' } }))).models).toEqual(expected);
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(observed.map(env => Boolean(env[key]))).toEqual([true, false, true]);
    expect(JSON.stringify(observed)).not.toMatch(/private-/);
    expect(observed.every(env => env.UNRELATED_TOKEN === undefined)).toBe(true);
  });

  it('composes global overlay, bot overlay and unset before reading the Pi directory', async () => {
    const globalDir = directory(), botDir = directory(), home = directory();
    config(globalDir, ['global/model']);
    config(botDir, ['bot/model']);
    config(join(home, '.pi', 'agent'), ['home/model']);
    vi.spyOn(globalConfig, 'readRawGlobalSessionEnv').mockReturnValue({
      set: { PI_CODING_AGENT_DIR: globalDir }, unset: [],
    });
    respond(mirrorResponse);
    const bot = { larkAppId: 'cli_overlay', cliId: 'pi', cliPathOverride: '/pi' } as BotConfig;
    const request = (shape: BotConfig) => modelCatalogProbeContext('pi', shape, { HOME: home });
    expect(await buildModelChoicesResponse('pi', request(bot))).toMatchObject({ models: ['global/model'], source: 'live' });
    expect(await buildModelChoicesResponse('pi', request({ ...bot, env: { PI_CODING_AGENT_DIR: botDir } })))
      .toMatchObject({ models: ['bot/model'], source: 'live' });
    expect(await buildModelChoicesResponse('pi', request({ ...bot, envUnset: ['PI_CODING_AGENT_DIR'] })))
      .toMatchObject({ models: ['home/model'], source: 'live' });
  });

  it.each(['pty', 'tmux'] as const)('uses the persisted runtime and bot env overlay for %s', async backendType => {
    const dir = directory();
    config(dir, ['alpha/shared', 'beta/shared']);
    const bot = { larkAppId: `cli_${backendType}_${dir}`, cliId: 'pi', backendType,
      cliRuntime: { executable: '/target/pi' }, model: 'legacy', env: { PI_CODING_AGENT_DIR: dir },
    } as BotConfig;
    const probe = modelCatalogProbeContext('pi', bot, { HOME: directory(), PATH: '/bin' });
    respond(mirrorResponse);
    const response = await buildModelChoicesResponse('pi', probe);
    expect(response.models).toEqual(['alpha/shared', 'beta/shared']);
    expect(response.source).toBe('live');
    expect(execMock.mock.calls[0]![0]).toBe('/target/pi');
    expect(JSON.stringify(response)).not.toContain(dir);
    expect(bot.model).toBe('legacy');
  });

  it('retries failures, coalesces in-flight requests and separates env/runtime/cache expiry', async () => {
    const dir = directory();
    config(dir, ['alpha/shared']);
    const catalog = createModelCatalog();
    let now = 0;
    const opts = { now: () => now, runtimeExecutable: '/pi-one', runtimeContext: 'bot-a',
      probeEnv: { PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: 'first' } };
    respond(() => { throw new Error('temporary failure'); });
    expect(await catalog.detectModels('pi', opts)).toBeNull();
    respond(mirrorResponse);
    const both = await Promise.all([catalog.detectModels('pi', opts), catalog.detectModels('pi', opts)]);
    expect(both).toEqual([['alpha/shared'], ['alpha/shared']]);
    expect(execMock).toHaveBeenCalledTimes(2);
    config(dir, ['alpha/next']);
    expect(await catalog.detectModels('pi', opts)).toEqual(['alpha/shared']);
    expect(await catalog.detectModels('pi', { ...opts, probeEnv: { ...opts.probeEnv, OPENAI_API_KEY: 'second' } })).toEqual(['alpha/next']);
    expect(await catalog.detectModels('pi', { ...opts, runtimeExecutable: '/pi-two' })).toEqual(['alpha/next']);
    expect(await catalog.detectModels('pi', { ...opts, runtimeContext: 'bot-b' })).toEqual(['alpha/next']);
    now += MODEL_DETECT_TTL_MS;
    expect(await catalog.detectModels('pi', opts)).toEqual(['alpha/next']);
    expect(execMock).toHaveBeenCalledTimes(6);
  });

  it('adapter exposes an env-aware slug catalog, without advertising service-tier capabilities', async () => {
    const dir = directory();
    config(dir, ['alpha/custom']);
    respond(mirrorResponse);
    const adapter = createPiAdapter('/pi');
    expect(adapter.detectModelCapabilities).toBeUndefined();
    expect(await adapter.detectModels!({ env: { PI_CODING_AGENT_DIR: dir } })).toEqual(['alpha/custom']);
  });

  it('separates effective default environment identities for new-bot catalog requests', async () => {
    const first = directory(), second = directory();
    config(first, ['first/model']);
    config(second, ['second/model']);
    respond(mirrorResponse);
    const catalog = createModelCatalog();
    const opts = { runtimeExecutable: '/pi' };
    vi.stubEnv('PI_CODING_AGENT_DIR', first);
    expect(await catalog.detectModels('pi', opts)).toEqual(['first/model']);
    vi.stubEnv('PI_CODING_AGENT_DIR', second);
    expect(await catalog.detectModels('pi', opts)).toEqual(['second/model']);
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
