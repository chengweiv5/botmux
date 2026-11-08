import { constants } from 'node:fs';
import { access, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Lexer } from 'yaml';
import { piSettingsPath } from '../adapters/cli/pi-model.js';
import { detectModelsViaExec } from '../adapters/cli/model-catalog-json.js';

const MARKER = 'botmux-catalog-configured';
const LOCAL_ENDPOINT = 'http://127.0.0.1:1';
const MAX_BYTES = 16 * 1024 * 1024;
// Pi's provider auth descriptors use these non-suffixed token names in 1.3/1.5.
const TOKEN_ENV_KEYS = new Set(['HF_TOKEN', 'COPILOT_GITHUB_TOKEN']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}

// Pi 1.3/1.5 accept line comments, not block comments. Leave strings untouched.
// JSON.parse validates the result; a regexp would corrupt URLs and escaped quotes.
function withoutJsonComments(text: string): string {
  let output = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      output += ch;
      if (ch === '\\') output += text[++i] ?? '';
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; output += ch; }
    else if (ch === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      output += ' ';
    } else output += ch;
  }
  return output;
}

function envValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Match Pi 1.3/1.5 cloud auth source predicates without resolving credentials. */
async function cloudProviderConfigured(
  provider: 'amazon-bedrock' | 'google-vertex',
  env: NodeJS.ProcessEnv,
  auth: Record<string, unknown>,
  cwd: string,
): Promise<boolean> {
  const stored = record(auth[provider]);
  const credential = stored?.type === 'api_key' ? stored : undefined;
  const storedEnv = record(credential?.env);
  // Native descriptors apply ?? and truthiness to stored fields even when a
  // malformed auth.json contains non-strings. Do not silently borrow ambient env.
  const field = (name: string): unknown => storedEnv?.[name];
  // Stored env is read only by explicit provider fields, not overlaid onto ctx.
  // Those fields use ??, so an empty stored project/profile shadows ambient env.
  const contextEnv = (name: string) => envValue(env[name]);
  const key = typeof credential?.key === 'string' ? credential.key : undefined;
  if (provider === 'amazon-bedrock') {
    return Boolean(key || contextEnv('AWS_BEARER_TOKEN_BEDROCK')
      || (field('AWS_PROFILE') ?? contextEnv('AWS_PROFILE'))
      || (contextEnv('AWS_ACCESS_KEY_ID') && contextEnv('AWS_SECRET_ACCESS_KEY'))
      || contextEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI')
      || contextEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI')
      || contextEnv('AWS_WEB_IDENTITY_TOKEN_FILE'));
  }
  if (key ?? contextEnv('GOOGLE_CLOUD_API_KEY')) return true;
  const path = field('GOOGLE_APPLICATION_CREDENTIALS') ?? contextEnv('GOOGLE_APPLICATION_CREDENTIALS')
    ?? '~/.config/gcloud/application_default_credentials.json';
  const project = field('GOOGLE_CLOUD_PROJECT') ?? contextEnv('GOOGLE_CLOUD_PROJECT') ?? contextEnv('GCLOUD_PROJECT');
  const location = field('GOOGLE_CLOUD_LOCATION') ?? contextEnv('GOOGLE_CLOUD_LOCATION');
  if (typeof path !== 'string' || !path || !project || !location) return false;
  try {
    const expanded = path.startsWith('~') ? (env.HOME ?? homedir()) + path.slice(1) : path;
    // Native auth uses F_OK, not file parsing/type validation. Never open ADC.
    await access(resolve(cwd, expanded));
    return true;
  } catch { return false; }
}

function parseJsonc(text: string): unknown {
  const source = withoutJsonComments(text);
  // Reuse the installed flow-collection lexer for punctuation/string boundaries.
  // JSON.parse remains the grammar validator, so YAML/JSON5 syntax is not accepted.
  const tokens = [...new Lexer().lex(source)].filter(token => !/^[\x02\x18\x1f]$/.test(token));
  if (tokens.join('') !== source) throw new Error('Invalid JSON tokens');
  let previous = '';
  return JSON.parse(tokens.map((token, index) => {
    if (/^\s*$/.test(token)) return token;
    const before = previous;
    previous = token;
    if (token !== ',' || !before || ['[', '{', ':', ','].includes(before)) return token;
    let next = index + 1;
    while (next < tokens.length && /^\s*$/.test(tokens[next]!)) next++;
    return tokens[next] === '}' || tokens[next] === ']' ? '' : token;
  }).join(''));
}

async function readObject(path: string, comments = false): Promise<Record<string, unknown>> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return {};
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) return {};
    const text = buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '');
    return record(comments ? parseJsonc(text) : JSON.parse(text)) ?? {};
  } catch {
    return {};
  } finally {
    await file?.close().catch(() => {});
  }
}

/** Whitelist only model metadata. Never copy request headers or credential helpers. */
function modelMetadata(value: unknown, provider?: string): Record<string, unknown> | undefined {
  const model = record(value);
  if (!model || !identifier(model.id) || (model.type !== undefined && model.type !== 'chat')) return undefined;
  return {
    id: model.id,
    ...(provider ? { provider } : {}),
    ...(identifier(model.api) ? { api: model.api } : {}),
    baseUrl: LOCAL_ENDPOINT,
    name: model.id,
    reasoning: model.reasoning === true,
    input: ['text'],
    contextWindow: typeof model.contextWindow === 'number' && model.contextWindow > 0 ? model.contextWindow : 128_000,
    maxTokens: typeof model.maxTokens === 'number' && model.maxTokens > 0 ? model.maxTokens : 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Pi 1.3/1.5 use the same six-column --list-models table. */
export function parsePiModelList(stdout: string): string[] {
  const models = new Set<string>();
  let inTable = false;
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.join(' ') === 'provider model context max-out thinking images') {
      inTable = true;
      continue;
    }
    if (!inTable || columns.length !== 6) continue;
    const [provider, id, context, maxOut, thinking, images] = columns;
    if (!identifier(provider) || provider.includes('/') || !identifier(id)
      || !/^\d+(?:\.\d+)?[KM]?$/.test(context!) || !/^\d+(?:\.\d+)?[KM]?$/.test(maxOut!)
      || !/^(yes|no)$/.test(thinking!) || !/^(yes|no)$/.test(images!)) continue;
    models.add(`${provider}/${id}`);
  }
  return [...models];
}

/**
 * Enumerate configured models, not verified access. Native --list-models also
 * loads extensions, migrates files and resolves !command credentials. Run it
 * only against a disposable metadata mirror: no real credentials, settings,
 * extensions or writable source paths reach Pi. Its installed built-in catalog
 * still supplies env/auth-only providers, unlike a models.json-only reader.
 */
export async function loadPiModelCatalog(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<readonly string[] | null> {
  let scratch: string | undefined;
  try {
    const env = input.env ?? process.env;
    const agentDir = dirname(piSettingsPath({ env, cwd: input.cwd }));
    const [config, auth, stored] = await Promise.all([
      readObject(join(agentDir, 'models.json'), true),
      readObject(join(agentDir, 'auth.json')),
      readObject(join(agentDir, 'models-store.json')),
    ]);
    const providers: Record<string, Record<string, unknown>> = Object.create(null);
    for (const [id, value] of Object.entries(record(config.providers) ?? {})) {
      const provider = record(value);
      if (!identifier(id) || id.includes('/') || !provider) continue;
      providers[id] = {
        apiKey: MARKER,
        baseUrl: LOCAL_ENDPOINT,
        ...(identifier(provider.api) ? { api: provider.api } : {}),
        ...(Array.isArray(provider.models) ? {
          models: provider.models.map(model => modelMetadata(model)).filter(model => model !== undefined),
        } : {}),
      };
    }
    for (const [id, value] of Object.entries(auth)) {
      const credential = record(value);
      if (!identifier(id) || id.includes('/') || !credential) continue;
      if ((credential.type === 'api_key' && typeof credential.key === 'string' && credential.key)
        || credential.type === 'oauth') {
        // A provider override preserves configured-ness without refreshing OAuth.
        providers[id] ??= { apiKey: MARKER, baseUrl: LOCAL_ENDPOINT };
      }
    }
    const modelStore: Record<string, unknown> = Object.create(null);
    for (const [id, value] of Object.entries(stored)) {
      const entry = record(value);
      if (!identifier(id) || id.includes('/') || !Array.isArray(entry?.models)) continue;
      modelStore[id] = {
        models: entry.models.map(model => modelMetadata(model, id)).filter(model => model !== undefined),
        checkedAt: Date.now(),
      };
    }

    scratch = await mkdtemp(join(tmpdir(), 'botmux-pi-catalog-'));
    // Start with a small environment: NODE_OPTIONS, credential file paths and
    // arbitrary provider helpers must not escape the disposable HOME.
    const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH, SystemRoot: env.SystemRoot };
    for (const [key, value] of Object.entries(env)) {
      if (key !== 'GOOGLE_CLOUD_API_KEY' && envValue(value)
        && (TOKEN_ENV_KEYS.has(key) || /_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN)$/.test(key))) childEnv[key] = MARKER;
    }
    for (const provider of ['amazon-bedrock', 'google-vertex'] as const) {
      if (await cloudProviderConfigured(provider, env, auth, input.cwd ?? process.cwd())) {
        providers[provider] ??= { apiKey: MARKER, baseUrl: LOCAL_ENDPOINT };
      }
    }
    Object.assign(childEnv, {
      HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: scratch,
      XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, XDG_CACHE_HOME: scratch,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', NO_COLOR: '1', TERM: 'dumb',
    });
    await Promise.all([
      writeFile(join(scratch, 'models.json'), JSON.stringify({ providers }), { mode: 0o600 }),
      writeFile(join(scratch, 'auth.json'), '{}', { mode: 0o600 }),
      writeFile(join(scratch, 'models-store.json'), JSON.stringify(modelStore), { mode: 0o600 }),
    ]);
    return await detectModelsViaExec(input.cliBin, [
      '--list-models', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    ], parsePiModelList, { env: childEnv, cwd: scratch });
  } catch {
    // Errors may include credentials or private paths. Never forward stderr.
    return null;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
