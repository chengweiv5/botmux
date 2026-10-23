/** Explicit host-only OFFLINE repair. Not registered in botmux agent IPC/CLI. */
import { readSecureHostFileSync } from '../src/platform/secure-host-file.js';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DocCommentNegativeStore } from '../src/services/doc-comment-negative-store.js';
import type { SignedCommentRecovery } from '../src/services/doc-comment-recovery-trust.js';

const [dataDir, evidenceFile, confirm] = process.argv.slice(2);
if (!dataDir || !evidenceFile || confirm !== '--confirm-offline-audited') {
  throw new Error('Usage: bun scripts/recover-doc-comment-negative.ts <dataDir> <0600-evidence.json> --confirm-offline-audited');
}
if (process.env.BOTMUX_SESSION_ID || process.env.BOTMUX_LARK_TOOL_BINDING) throw new Error('negative_recovery_agent_context_forbidden');
const root = resolve(dataDir);
// Conservatively require all local daemon pid files down: this is an offline
// repair, not an online reset that races a live ingress consumer.
for (const name of readdirSync(root).filter(n => /^daemon(?:-\d+)?\.pid$/.test(n))) {
  const pid = Number(readFileSync(join(root, name), 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('negative_recovery_daemon_pid_unverified');
  try { process.kill(pid, 0); throw new Error('negative_recovery_daemon_live'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
const raw = readSecureHostFileSync(resolve(evidenceFile), 16 * 1024 * 1024);
if (!raw) throw new Error('negative_recovery_evidence_missing');
const store = new DocCommentNegativeStore(root);
try { store.recoverOffline(JSON.parse(raw) as SignedCommentRecovery); console.log('Offline signed evidence recorded; only a future daemon may claim a new uncertain epoch.'); }
finally { store.close(); }
