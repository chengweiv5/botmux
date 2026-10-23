/** Offline actual-process fixture. No credentials, tokens or Lark calls. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { DocCommentNegativeStore } from '../../src/services/doc-comment-negative-store.js';

const [root, phase] = process.argv.slice(2);
if (!root || !['fail', 'reopen', 'crash'].includes(phase)) throw new Error('root and phase required');
const store = new DocCommentNegativeStore(root);
if (phase === 'crash') {
  if (store.isDenied('app', 'A', 'c', 'old-legitimate')) throw new Error('epoch not authorized');
  process.kill(process.pid, 'SIGKILL');
} else if (phase === 'reopen') {
  console.log(JSON.stringify({ phase, deniedA: store.isDenied('app', 'A', 'c', 'r'),
    deniedB: store.isDenied('app', 'B', 'c', 'r') }));
} else {
  store.initialize('app', 'A'); store.initialize('app', 'B');
  const paths = store.paths('app', 'A');
  const before = { state: fs.readFileSync(paths.state).toString('base64'),
    db: fs.readFileSync(paths.db).toString('base64'), mode: fs.statSync(dirname(paths.db)).mode };
  const write = fs.writeFileSync; const chmod = fs.chmodSync;
  let markerFailures = 0; let fenceFailures = 0;
  // Inject at the real built-in syscalls after successful clean enrollment.
  // No mock token/proof/provider bypass; the real secure-file helper executes.
  fs.writeFileSync = (() => { markerFailures++; throw Object.assign(new Error('injected_EROFS_write'), { code: 'EROFS' }); }) as typeof fs.writeFileSync;
  fs.chmodSync = (() => { fenceFailures++; throw Object.assign(new Error('injected_EROFS_chmod'), { code: 'EROFS' }); }) as typeof fs.chmodSync;
  syncBuiltinESMExports();
  let failure = '';
  try { store.deny('app', 'A', 'c', 'r'); } catch (error) { failure = String(error); }
  finally { fs.writeFileSync = write; fs.chmodSync = chmod; syncBuiltinESMExports(); }
  const after = { state: fs.readFileSync(paths.state).toString('base64'),
    db: fs.readFileSync(paths.db).toString('base64'), mode: fs.statSync(dirname(paths.db)).mode };
  console.log(JSON.stringify({ phase, markerFailures, fenceFailures, failure,
    unchanged: JSON.stringify(before) === JSON.stringify(after),
    deniedA: store.isDenied('app', 'A', 'c', 'r'), deniedB: store.isDenied('app', 'B', 'c', 'r') }));
}
store.close();
