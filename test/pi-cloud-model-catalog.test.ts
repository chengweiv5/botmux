import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPiModelCatalog } from '../src/services/pi-model-catalog.js';
import { createModelCatalog, MODEL_DETECT_TTL_MS } from '../src/services/model-catalog.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import type { BotConfig } from '../src/bot-registry.js';
import * as globalConfig from '../src/global-config.js';
import { PI_CLOUD_CASES, piCloudFixture } from './helpers/pi-cloud-fixtures.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const roots: string[] = [];
const captures: { env: NodeJS.ProcessEnv; providers: Record<string, unknown> }[] = [];
const execMock = vi.mocked(execFile);
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'pi-cloud-test-'));
  roots.push(path);
  return path;
}
beforeEach(() => {
  execMock.mockReset();
  captures.length = 0;
  execMock.mockImplementation(((bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, cb: Function) => {
    const providers = JSON.parse(readFileSync(join(options.cwd, 'models.json'), 'utf8')).providers;
    captures.push({ env: options.env, providers });
    const rows = Object.keys(providers).map(provider => `${provider} native-model 128K 16K no no`);
    if (options.env.GOOGLE_CLOUD_API_KEY && !providers['google-vertex']) rows.push('google-vertex native-model 128K 16K no no');
    cb(null, { stdout: ['provider model context max-out thinking images', ...rows].join('\n'), stderr: '' });
  }) as typeof execFile);
});
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Pi native cloud credential-source enumeration', () => {
  it.each(PI_CLOUD_CASES)('$name', async scenario => {
    const fixture = piCloudFixture(root(), scenario);
    const models = await loadPiModelCatalog({ cliBin: '/pi', ...fixture });
    expect(models ?? []).toEqual(scenario.available ? [`${scenario.provider}/native-model`] : []);
    const capture = captures[0]!;
    expect(JSON.stringify(capture)).not.toContain('private-');
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
      expect(capture.env[name]).toBeUndefined();
    }
    expect(JSON.stringify(capture.providers)).not.toContain(fixture.env.HOME!);
    expect(JSON.stringify(capture.providers)).not.toContain(fixture.cwd);
  });

  it.each(['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS'])('applies Bot set/unset before resolving %s', async key => {
    const isVertex = key.startsWith('GOOGLE');
    const scenario = PI_CLOUD_CASES.find(item => item.name === (isVertex ? 'ADC explicit present' : 'IAM pair'))!;
    const fixture = piCloudFixture(root(), scenario);
    const provider = isVertex ? 'google-vertex' : 'amazon-bedrock';
    const base = { ...fixture.env };
    if (!isVertex && key !== 'AWS_SECRET_ACCESS_KEY') {
      delete base.AWS_ACCESS_KEY_ID;
      delete base.AWS_SECRET_ACCESS_KEY;
      base[key] = 'private-source';
    }
    vi.spyOn(globalConfig, 'readRawGlobalSessionEnv').mockReturnValue({ set: {}, unset: [] });
    const bot = { cliId: 'pi', larkAppId: `cloud_${key}`, cliPathOverride: '/pi', defaultWorkingDir: fixture.cwd } as BotConfig;
    const catalog = createModelCatalog();
    const query = (shape: BotConfig) => catalog.detectModels('pi', modelCatalogProbeContext('pi', shape, base));
    expect(await query(bot)).toEqual([`${provider}/native-model`]);
    expect(await query({ ...bot, envUnset: [key] })).toBeNull();
    expect(await query({ ...bot, env: { [key]: '' } })).toBeNull();
    expect(await query({ ...bot, env: { [key]: base[key]! } })).toEqual([`${provider}/native-model`]);
    expect(JSON.stringify(captures)).not.toContain('private-');
  });

  it('isolates default ADC HOME and relative ADC cwd caches and retries absent sources', async () => {
    const source = piCloudFixture(root(), PI_CLOUD_CASES.find(item => item.name === 'ADC relative present')!);
    const other = piCloudFixture(root(), PI_CLOUD_CASES.find(item => item.name === 'ADC default missing')!);
    vi.spyOn(process, 'cwd').mockReturnValue(other.cwd);
    const catalog = createModelCatalog();
    let now = 0;
    const options = { probeEnv: source.env, probeCwd: source.cwd, runtimeExecutable: '/pi', now: () => now };
    expect(await catalog.detectModels('pi', options)).toEqual(['google-vertex/native-model']);
    expect(await catalog.detectModels('pi', { ...options, probeCwd: other.cwd })).toBeNull();
    writeFileSync(join(other.cwd, 'private-adc'), 'private-not-json');
    expect(await catalog.detectModels('pi', { ...options, probeCwd: other.cwd })).toEqual(['google-vertex/native-model']);
    const defaultEnv = { HOME: other.env.HOME, GOOGLE_CLOUD_PROJECT: 'private-project', GOOGLE_CLOUD_LOCATION: 'private-location' };
    expect(await catalog.detectModels('pi', { ...options, probeEnv: defaultEnv })).toBeNull();
    mkdirSync(join(source.env.HOME!, '.config', 'gcloud'), { recursive: true });
    writeFileSync(join(source.env.HOME!, '.config', 'gcloud', 'application_default_credentials.json'), 'private-not-json');
    expect(await catalog.detectModels('pi', { ...options, probeEnv: { ...defaultEnv, HOME: source.env.HOME } })).toEqual(['google-vertex/native-model']);
    rmSync(join(source.cwd, 'private-adc'));
    expect(await catalog.detectModels('pi', options)).toEqual(['google-vertex/native-model']);
    now += MODEL_DETECT_TTL_MS;
    expect(await catalog.detectModels('pi', options)).toBeNull();
    expect(JSON.stringify(captures)).not.toContain('private-');
  });
});
