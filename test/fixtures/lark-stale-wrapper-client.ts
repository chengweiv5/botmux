import { spawnTsScript } from '../helpers/ts-runner.js';
import { join } from 'node:path';
process.send?.({ ready: true });
process.once('message', async (message: { repo: string; bindingPath: string; relayDir: string; port: number }) => {
  const run = (file: string, args: string[]) => new Promise<{ code: number | null; err: string; out: string }>((resolve, reject) => {
    const child = spawnTsScript(join(message.repo, file), args, { env: { ...process.env,
      BOTMUX_SEND_RELAY: message.relayDir, BOTMUX_LARK_TOOL_BINDING: message.bindingPath,
      BOTMUX_SESSION_ID: 'tool-session', BOTMUX_LARK_APP_ID: 'cli_bound', BOTMUX_DAEMON_IPC_PORT: String(message.port),
      SESSION_DATA_DIR: join(message.relayDir, '..'), BOTS_CONFIG: join(message.relayDir, '..', 'bots.json'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', out = ''; child.stderr!.on('data', chunk => err += chunk); child.stdout!.on('data', chunk => out += chunk);
    child.once('error', reject); child.once('close', code => resolve({ code, err, out }));
  });
  const user = await run('src/lark-tool-runner.ts', ['--binding', message.bindingPath, '--', 'docs', '+fetch', '--as', 'user']);
  const auth = await run('src/cli.ts', ['auth', 'request', '--scope', 'im:chat:read', '--json']);
  process.send?.({ user, auth });
});
