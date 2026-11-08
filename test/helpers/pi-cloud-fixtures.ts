import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PiCloudCase {
  name: string;
  provider: 'amazon-bedrock' | 'google-vertex';
  available: boolean;
  env?: NodeJS.ProcessEnv;
  auth?: Record<string, unknown>;
  adc?: 'explicit' | 'default' | 'directory';
}

const aws = (name: string, available: boolean, env: NodeJS.ProcessEnv): PiCloudCase =>
  ({ name, provider: 'amazon-bedrock', available, env });
const vertex = (name: string, available: boolean, env: NodeJS.ProcessEnv, adc?: PiCloudCase['adc']): PiCloudCase =>
  ({ name, provider: 'google-vertex', available, env, adc });
const project = { GOOGLE_CLOUD_PROJECT: 'private-project', GOOGLE_CLOUD_LOCATION: 'private-location' };
export const PI_CLOUD_CASES: PiCloudCase[] = [
  aws('AWS absent', false, {}),
  aws('IAM pair', true, { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: 'private-secret' }),
  aws('IAM id only', false, { AWS_ACCESS_KEY_ID: 'private-id' }),
  aws('IAM secret only', false, { AWS_SECRET_ACCESS_KEY: 'private-secret' }),
  aws('IAM empty secret', false, { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: '' }),
  aws('IAM empty id', false, { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: 'private-secret' }),
  aws('IAM blank id', false, { AWS_ACCESS_KEY_ID: ' ', AWS_SECRET_ACCESS_KEY: 'private-secret' }),
  aws('IAM blank secret', false, { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: ' \t ' }),
  aws('role ARN alone', false, { AWS_ROLE_ARN: 'private-role' }),
  ...['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE'].flatMap(key => [
    aws(`${key} configured`, true, { [key]: 'private-source' }),
    aws(`${key} empty`, false, { [key]: '' }),
    aws(`${key} blank`, false, { [key]: ' \t ' }),
  ]),
  { ...aws('stored AWS profile', true, {}), auth: { type: 'api_key', env: { AWS_PROFILE: 'private-stored' } } },
  { ...aws('stored empty AWS profile shadows parent', false, { AWS_PROFILE: 'private-parent' }), auth: { type: 'api_key', env: { AWS_PROFILE: '' } } },
  { ...aws('stored IAM fields are not context env', false, {}), auth: { type: 'api_key', env: { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: 'private-secret' } } },
  { ...aws('stored IAM missing secret', false, {}), auth: { type: 'api_key', env: { AWS_ACCESS_KEY_ID: 'private-id' } } },
  { ...aws('stored IAM id does not complete ambient pair', false, { AWS_SECRET_ACCESS_KEY: 'private-secret' }), auth: { type: 'api_key', env: { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: '' } } },
  { ...aws('stored IAM env does not shadow ambient pair', true, { AWS_ACCESS_KEY_ID: 'private-id', AWS_SECRET_ACCESS_KEY: 'private-secret' }), auth: { type: 'api_key', env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' } } },
  vertex('ADC explicit present', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '$ADC' }, 'explicit'),
  vertex('ADC explicit missing', false, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '$ADC' }),
  vertex('ADC relative present', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: 'private-adc' }, 'explicit'),
  vertex('ADC tilde present', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '~/.config/gcloud/application_default_credentials.json' }, 'default'),
  vertex('ADC default present', true, project, 'default'),
  vertex('ADC default missing', false, project),
  vertex('ADC explicit missing shadows default', false, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '$ADC' }, 'default'),
  vertex('ADC empty env falls back default', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '' }, 'default'),
  vertex('ADC blank env falls back default', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: ' ' }, 'default'),
  vertex('ADC directory exists', true, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '$ADC' }, 'directory'),
  vertex('ADC project missing', false, { GOOGLE_CLOUD_LOCATION: project.GOOGLE_CLOUD_LOCATION }, 'default'),
  vertex('ADC location missing', false, { GOOGLE_CLOUD_PROJECT: project.GOOGLE_CLOUD_PROJECT }, 'default'),
  vertex('ADC empty project', false, { ...project, GOOGLE_CLOUD_PROJECT: '' }, 'default'),
  vertex('ADC blank project', false, { ...project, GOOGLE_CLOUD_PROJECT: ' \t ' }, 'default'),
  vertex('ADC empty location', false, { ...project, GOOGLE_CLOUD_LOCATION: '' }, 'default'),
  vertex('ADC blank location', false, { ...project, GOOGLE_CLOUD_LOCATION: ' ' }, 'default'),
  vertex('ADC project alias', true, { GCLOUD_PROJECT: 'private-alias', GOOGLE_CLOUD_LOCATION: 'private-location' }, 'default'),
  vertex('ADC empty project uses alias', true, { ...project, GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: 'private-alias' }, 'default'),
  vertex('ADC alias without location', false, { GCLOUD_PROJECT: 'private-alias' }, 'default'),
  vertex('Vertex API key without ADC/project/location', true, { GOOGLE_CLOUD_API_KEY: 'private-key' }),
  vertex('Vertex empty API key', false, { GOOGLE_CLOUD_API_KEY: '' }),
  vertex('Vertex blank API key', false, { GOOGLE_CLOUD_API_KEY: ' ' }),
  { ...vertex('stored empty Vertex key shadows env', false, { GOOGLE_CLOUD_API_KEY: 'private-key' }), auth: { type: 'api_key', key: '' } },
  { ...vertex('stored empty Vertex key permits ADC', true, { ...project, GOOGLE_CLOUD_API_KEY: 'private-key' }, 'default'), auth: { type: 'api_key', key: '' } },
  { ...vertex('stored ADC relative', true, {} , 'explicit'), auth: { type: 'api_key', env: { ...project, GOOGLE_APPLICATION_CREDENTIALS: 'private-adc' } } },
  { ...vertex('stored ADC default', true, {}, 'default'), auth: { type: 'api_key', env: project } },
  { ...vertex('stored missing ADC shadows env', false, { ...project, GOOGLE_APPLICATION_CREDENTIALS: '$ADC' }, 'default'), auth: { type: 'api_key', env: { GOOGLE_APPLICATION_CREDENTIALS: 'missing' } } },
  { ...vertex('stored empty project shadows alias', false, { GCLOUD_PROJECT: 'private-alias', GOOGLE_CLOUD_LOCATION: 'private-location' }, 'default'), auth: { type: 'api_key', env: { GOOGLE_CLOUD_PROJECT: '' } } },
  { ...vertex('stored empty ADC path shadows default', false, project, 'default'), auth: { type: 'api_key', env: { GOOGLE_APPLICATION_CREDENTIALS: '' } } },
  { ...vertex('stored empty location shadows env', false, project, 'default'), auth: { type: 'api_key', env: { GOOGLE_CLOUD_LOCATION: '' } } },
  ...[0, 7, false, true, null, {}, []].flatMap(value => [
    { ...aws(`stored malformed AWS profile ${JSON.stringify(value)}`, value == null || Boolean(value), { AWS_PROFILE: 'private-parent' }),
      auth: { type: 'api_key', env: { AWS_PROFILE: value } } },
    { ...aws(`stored malformed AWS profile without parent ${JSON.stringify(value)}`, Boolean(value), {}),
      auth: { type: 'api_key', env: { AWS_PROFILE: value } } },
    { ...vertex(`stored malformed Vertex project ${JSON.stringify(value)}`, value == null || Boolean(value), project, 'default'),
      auth: { type: 'api_key', env: { GOOGLE_CLOUD_PROJECT: value } } },
    { ...vertex(`stored malformed Vertex location ${JSON.stringify(value)}`, value == null || Boolean(value), project, 'default'),
      auth: { type: 'api_key', env: { GOOGLE_CLOUD_LOCATION: value } } },
  ]),
];

/** Synthetic unreadable-as-JSON ADC proves enumeration only checks existence. */
export function piCloudFixture(root: string, scenario: PiCloudCase): { env: NodeJS.ProcessEnv; cwd: string } {
  const home = join(root, 'home'), cwd = join(root, 'cwd'), agent = join(root, 'agent');
  for (const path of [home, cwd, agent]) mkdirSync(path, { recursive: true });
  const adc = join(cwd, 'private-adc');
  const defaultAdc = join(home, '.config', 'gcloud', 'application_default_credentials.json');
  if (scenario.adc === 'explicit') writeFileSync(adc, 'private-not-json-credential');
  if (scenario.adc === 'directory') mkdirSync(adc);
  if (scenario.adc === 'default') {
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
    writeFileSync(defaultAdc, 'private-not-json-credential');
  }
  writeFileSync(join(agent, 'auth.json'), JSON.stringify(scenario.auth ? { [scenario.provider]: scenario.auth } : {}));
  return { cwd, env: { HOME: home, PI_CODING_AGENT_DIR: agent,
    ...Object.fromEntries(Object.entries(scenario.env ?? {}).map(([key, value]) => [key, value === '$ADC' ? adc : value])) } };
}
