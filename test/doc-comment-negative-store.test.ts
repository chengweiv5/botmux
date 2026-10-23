import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, renameSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocCommentNegativeStore } from '../src/services/doc-comment-negative-store.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import { logger } from '../src/utils/logger.js';
import * as secureFiles from '../src/platform/secure-host-file.js';
import * as fs from 'node:fs';
import { putDocSubscription, removeDocSubscription } from '../src/services/doc-subs-store.js';
import { spawnSyncTsEvalWithRepoImports, spawnSyncTsScript } from './helpers/ts-runner.js';
import { generateKeyPairSync, sign } from 'node:crypto';

const recoveryKeys = vi.hoisted(() => ({ publicKey: '', privateKey: '' }));
Object.assign(recoveryKeys, generateKeyPairSync('ed25519', {publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}));
vi.mock('../src/services/doc-comment-recovery-trust.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/services/doc-comment-recovery-trust.js')>();
  return {...actual,readVerifiedCommentRecovery:(envelope: any)=>actual.verifyCommentRecoverySignature(envelope,recoveryKeys.publicKey)};
});
function signed(evidence: unknown) { const payload=JSON.stringify(evidence); return {payload,signature:sign(null,Buffer.from(payload),recoveryKeys.privateKey).toString('base64')}; }
function trustPrelude() { return `
  import fsTrust from 'node:fs'; import {syncBuiltinESMExports as syncTrust} from 'node:module';
  const statTrust=fsTrust.lstatSync; const readTrust=fsTrust.readFileSync;
  fsTrust.lstatSync=(p,...args)=> String(p).startsWith('/etc/botmux') ? ({uid:0,mode:0o700,isSymbolicLink:()=>false,isFile:()=>String(p).endsWith('.pem'),isDirectory:()=>!String(p).endsWith('.pem')}) : statTrust(p,...args);
  fsTrust.readFileSync=(p,...args)=>String(p)==='/etc/botmux/comment-recovery/public-key.pem' ? ${JSON.stringify(recoveryKeys.publicKey)} : readTrust(p,...args);syncTrust();
`; }

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const roots: string[] = [];
const stores: DocCommentNegativeStore[] = [];
function fixture(capacity = 2, open?: typeof openDatabaseSyncOrThrow) {
  const root = mkdtempSync(join(tmpdir(), 'comment-negative-')); roots.push(root);
  const store = new DocCommentNegativeStore(root, capacity, open); stores.push(store);
  return { root, store };
}
function restoreFixturePermissions(root: string): void {
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) restoreFixturePermissions(path);
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { restoreFixturePermissions(root); rmSync(root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

describe('exact persistent comment negatives', () => {
  it('revokes immediately with real secure-file syscall failures and no durable denial trace', () => {
    const { root } = fixture();
    const child = spawnSyncTsScript('test/fixtures/comment-negative-double-fault.ts', [root, 'fail'],
      { encoding: 'utf8', timeout: 15_000 });
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.markerFailures).toBeGreaterThan(0);
    expect(result.fenceFailures).toBeGreaterThan(0);
    expect(result.unchanged).toBe(true);
    expect(result.deniedA).toBe(true);
    expect(result.deniedB).toBe(false);
    const restarted = spawnSyncTsScript('test/fixtures/comment-negative-double-fault.ts', [root, 'reopen'],
      { encoding: 'utf8', timeout: 15_000 });
    expect(restarted.status).toBe(0);
    expect(JSON.parse(restarted.stdout.trim()).deniedA).toBe(true);
  });
  it('keeps every exact veto but allows old unedited pending and new cross-document replies', () => {
    const { store } = fixture();
    store.deny('app', 'A', 'comment', '900'); store.deny('app', 'A', 'comment', '100');
    expect(store.isDenied('app', 'A', 'comment', '100')).toBe(true);
    expect(store.isDenied('app', 'A', 'comment', '900')).toBe(true);
    expect(store.isDenied('app', 'A', 'comment', '50')).toBe(false);
    expect(store.isDenied('app', 'A', 'comment', '901')).toBe(false);
    expect(store.isDenied('app', 'A', 'other-comment', '100')).toBe(false);
    expect(store.isDenied('app', 'B', 'comment', '100')).toBe(false);
    expect(store.isDenied('other-app', 'A', 'comment', '100')).toBe(false);
  });
  it('retains denial across connection eviction, daemon reopen and re-subscription', () => {
    const { root, store } = fixture(1);
    store.deny('app', 'A', 'comment', '1');
    for (let i = 0; i < 20; i++) store.initialize('app', `other-${i}`);
    expect(store.cachedConnections).toBeLessThanOrEqual(1);
    expect(store.isDenied('app', 'A', 'comment', '1')).toBe(true);
    store.close(); const reopened = new DocCommentNegativeStore(root, 1); stores.push(reopened);
    const sub = { fileToken: 'A', fileType: 'docx', sessionAnchor: 'doc:A:watch', scope: 'chat' as const,
      chatId: 'doc:A:watch', commentTriggerMode: 'all' as const, createdAt: Date.now() };
    putDocSubscription(root, 'app', sub);
    removeDocSubscription(root, 'app', 'A');
    putDocSubscription(root, 'app', sub);
    reopened.initialize('app', 'A');
    expect(reopened.isDenied('app', 'A', 'comment', '1')).toBe(true);
    expect(reopened.isDenied('app', 'A', 'comment', '2')).toBe(false);
  });
  it('holds ten thousand edits on disk with a bounded connection/cache working set', () => {
    const { store } = fixture(2);
    for (let i = 0; i < 10_000; i++) store.deny('app', 'A', 'comment', String(i));
    const disk = openDatabaseSyncOrThrow(store.paths('app', 'A').db, { readOnly: true });
    try { expect(disk.prepare('SELECT COUNT(*) AS n FROM veto').get()).toEqual({ n: 10_000 }); }
    finally { disk.close(); }
    expect(store.cachedConnections).toBeLessThanOrEqual(2);
    expect(store.isDenied('app', 'A', 'comment', '0')).toBe(true);
    expect(store.isDenied('app', 'A', 'comment', '9999')).toBe(true);
    expect(store.isDenied('app', 'A', 'comment', '10000')).toBe(false);
    expect(store.isDenied('app', 'A', 'comment', 'old-legitimate')).toBe(false);
    expect(store.isDenied('app', 'B', 'comment', '0')).toBe(false);
  }, 180_000);
  it('isolates corrupt/missing/symlink storage and emits a document-scoped diagnostic', () => {
    const { root, store } = fixture(1);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    store.initialize('app', 'A'); store.initialize('app', 'B');
    writeFileSync(store.paths('app', 'A').db, 'not sqlite');
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ appId: 'app', fileToken: 'A' }));
    const other = join(root, 'unrelated'); writeFileSync(other, 'untouched');
    const paths = store.paths('app', 'C'); store.initialize('app', 'C'); store.close();
    rmSync(paths.db); symlinkSync(other, paths.db);
    expect(store.isDenied('app', 'C', 'c', 'r')).toBe(true);
    expect(readFileSync(other, 'utf8')).toBe('untouched');
    rmSync(store.paths('app', 'B').db);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'D', 'c', 'r')).toBe(false);
    const orphan = store.paths('app', 'E'); store.initialize('app', 'E'); store.close();
    rmSync(orphan.state);
    expect(store.isDenied('app', 'E', 'c', 'r')).toBe(true);
  });
  it('does not accept a replaced empty database after the first mismatch', () => {
    const { store } = fixture();
    store.deny('app', 'A', 'c', 'r');
    const path = store.paths('app', 'A').db;
    // Move the real DB aside, create a valid but empty substitute with matching
    // metadata: neither repeated reads nor cache eviction can clear the fault.
    const backup = path + '.backup';
    renameSync(path, backup);
    const replacement = openDatabaseSyncOrThrow(path);
    replacement.exec('CREATE TABLE authority (version,app_id,file_token); INSERT INTO authority VALUES (1,\'app\',\'A\'); CREATE TABLE veto (comment_id,reply_id);');
    replacement.close(); chmodSync(path, 0o600);
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    store.close();
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(false);
  });
  it('durably fences only the failed document before an insert and never silently clears lost negatives', () => {
    let fail = false;
    const open = (path: string): DatabaseSyncLike => {
      const db = openDatabaseSyncOrThrow(path);
      return { ...db, exec: sql => db.exec(sql), close: () => db.close(), prepare: sql => {
        const stmt = db.prepare(sql);
        return { get: (...args) => stmt.get(...args), all: (...args) => stmt.all(...args), run: (...args) => {
          if (fail && sql.startsWith('INSERT OR IGNORE INTO veto')) throw new Error('simulated_full');
          return stmt.run(...args);
        } };
      } };
    };
    const { root, store } = fixture(2, open);
    store.initialize('app', 'A'); fail = true;
    expect(() => store.deny('app', 'A', 'c', 'r')).toThrow('simulated_full');
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(false);
    fail = false;
    expect(() => store.deny('app', 'A', 'c', 'later')).toThrow('negative_process_quarantine');
    store.close(); const reopened = new DocCommentNegativeStore(root); stores.push(reopened);
    expect(reopened.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(reopened.isDenied('app', 'A', 'c', 'later')).toBe(true);
    expect(reopened.isDenied('app', 'B', 'c', 'r')).toBe(false);
    // A new OS process has no quarantine memory; the durable directory fence
    // must still deny the original document while leaving B available.
    const child = spawnSyncTsEvalWithRepoImports(`
      import { DocCommentNegativeStore } from './src/services/doc-comment-negative-store.js';
      const store = new DocCommentNegativeStore(${JSON.stringify(root)});
      console.log(JSON.stringify({ a: store.isDenied('app','A','c','r'), b: store.isDenied('app','B','c','r') }));
      store.close();
    `, { encoding: 'utf8', timeout: 15_000 });
    expect(child.status).toBe(0);
    // Both documents were authorized in the prior epoch. Normal shutdown also
    // retains uncertain, so B is anonymous after an actual process restart.
    expect(JSON.parse(child.stdout.trim())).toEqual({ a: true, b: true });
  });
  it('fences a failed pending-marker write before a previously clean document can be allowed again', () => {
    const { root, store } = fixture();
    store.initialize('app', 'A'); store.initialize('app', 'B');
    vi.spyOn(secureFiles, 'writeSecureHostFileSync').mockImplementationOnce(() => { throw new Error('simulated_enospc_before_marker'); });
    expect(() => store.deny('app', 'A', 'c', 'r')).toThrow('simulated_enospc_before_marker');
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(false);
    store.close(); const reopened = new DocCommentNegativeStore(root); stores.push(reopened);
    expect(reopened.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(reopened.isDenied('app', 'B', 'c', 'r')).toBe(false);
  });
  it('withholds a clean document when marker and directory fence both fail, even after store recreation', () => {
    const { root, store } = fixture();
    store.initialize('app', 'A'); store.initialize('app', 'B');
    const cleanState = readFileSync(store.paths('app', 'A').state);
    vi.spyOn(secureFiles, 'writeSecureHostFileSync').mockImplementationOnce(() => { throw new Error('simulated_readonly_marker'); });
    const fence = vi.mocked(fs.chmodSync).mockImplementationOnce(() => { throw new Error('simulated_readonly_fence'); });
    expect(() => store.deny('app', 'A', 'c', 'r')).toThrow('simulated_readonly_marker');
    expect(fence).toHaveBeenCalled();
    expect(readFileSync(store.paths('app', 'A').state)).toEqual(cleanState);
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(store.isDenied('app', 'A', 'c', 'fresh')).toBe(true);
    expect(store.isDenied('app', 'B', 'c', 'r')).toBe(false);
    store.close(); const recreated = new DocCommentNegativeStore(root); stores.push(recreated);
    expect(recreated.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(recreated.isDenied('app', 'B', 'c', 'r')).toBe(false);
    expect(() => recreated.deny('app', 'A', 'c', 'later')).toThrow();
    expect(recreated.isDenied('app', 'A', 'c', 'r')).toBe(true);
  });
  it('keeps the process guard when the directory fsync also fails', () => {
    const { root, store } = fixture(); store.initialize('app', 'A'); store.initialize('app', 'B');
    vi.spyOn(secureFiles, 'writeSecureHostFileSync').mockImplementationOnce(() => { throw new Error('simulated_marker_io'); });
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('simulated_fsync_io'); });
    expect(() => store.deny('app', 'A', 'c', 'r')).toThrow('simulated_marker_io');
    // Do not depend on an unconfirmed durability promise from chmod: even if a
    // host repairs the mode while this process survives, identity stays revoked.
    chmodSync(join(store.paths('app', 'A').state, '..'), 0o700);
    expect(store.isDenied('app', 'A', 'c', 'r')).toBe(true);
    store.close(); const recreated = new DocCommentNegativeStore(root); stores.push(recreated);
    expect(recreated.isDenied('app', 'A', 'c', 'new')).toBe(true);
    expect(recreated.isDenied('app', 'B', 'c', 'r')).toBe(false);
  });
  it('fail-stops personal comment authority if exceptional document quarantine capacity is exhausted', () => {
    const { root } = fixture();
    const child = spawnSyncTsEvalWithRepoImports(`
      import { DocCommentNegativeStore } from './src/services/doc-comment-negative-store.js';
      import { logger } from './src/utils/logger.js';
      import { writeFileSync } from 'node:fs';
      logger.error = () => {};
      const root = ${JSON.stringify(root)};
      const healthy = new DocCommentNegativeStore(root);
      const before = healthy.isDenied('app', 'healthy', 'c', 'r');
      const brokenRoot = root + '/not-a-directory'; writeFileSync(brokenRoot, 'file');
      const broken = new DocCommentNegativeStore(brokenRoot);
      for (let i = 0; i < 1100; i++) { try { broken.deny('app', String(i), 'c', 'r'); } catch {} }
      console.log(JSON.stringify({ before, after: healthy.isDenied('app', 'healthy', 'c', 'r') }));
      healthy.close(); broken.close();
    `, { encoding: 'utf8', timeout: 15_000 });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ before: false, after: true });
  });
  it('retains uncertain on clean exit and keeps old legitimate pending anonymous until audited recovery', () => {
    const { root } = fixture();
    const prior = spawnSyncTsEvalWithRepoImports(`
      import { DocCommentNegativeStore } from './src/services/doc-comment-negative-store.js';
      const s = new DocCommentNegativeStore(${JSON.stringify(root)});
      console.log(s.isDenied('app','A','c','old-legitimate')); s.close();
    `, { encoding: 'utf8', timeout: 15_000 });
    expect(prior.status).toBe(0); expect(prior.stdout.trim()).toBe('false');
    const s = new DocCommentNegativeStore(root); stores.push(s);
    expect(s.isDenied('app', 'A', 'c', 'old-legitimate')).toBe(true);
    expect(s.isDenied('app', 'A', 'c', 'new')).toBe(true);
    expect(s.isDenied('app', 'B', 'c', 'new')).toBe(false);
    const state = JSON.parse(readFileSync(s.paths('app', 'A').state, 'utf8'));
    expect(() => s.recoverOffline(signed({ version: 1, appId: 'app', fileToken: 'A', previousEpochId: state.uncertain.id,
      ingressStoppedAndDrained: true, authoritativeHistoryComplete: false, evidenceReference: 'unavailable', operator: 'host-admin', negatives: [] }))).toThrow('negative_recovery_evidence_required');
    s.recoverOffline(signed({ version: 1, appId: 'app', fileToken: 'A', previousEpochId: state.uncertain.id,
      ingressStoppedAndDrained: true, authoritativeHistoryComplete: true, evidenceReference: 'offline-audited-history-fixture', operator: 'host-admin', negatives: [{ commentId: 'c', replyId: 'edited' }] }));
    // Recovery process cannot authorize. Only a NEW daemon can claim handoff.
    expect(s.isDenied('app', 'A', 'c', 'old-legitimate')).toBe(true);
    const failedClaim=spawnSyncTsEvalWithRepoImports(trustPrelude()+`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      import { DocCommentNegativeStore } from './src/services/doc-comment-negative-store.js';
      const s = new DocCommentNegativeStore(${JSON.stringify(root)});
      const saved=fs.fsyncSync; fs.fsyncSync=()=>{throw new Error('claim_fsync_failed')}; syncBuiltinESMExports();
      let refused=false; try{s.prepareIngress('app','A')}catch{refused=true}
      fs.fsyncSync=saved;syncBuiltinESMExports();
      console.log(JSON.stringify({refused,denied:s.isDenied('app','A','c','old-legitimate')}));s.close();
    `,{encoding:'utf8',timeout:15_000});
    expect(failedClaim.status).toBe(0);expect(JSON.parse(failedClaim.stdout.trim())).toEqual({refused:true,denied:true});
    const future = spawnSyncTsEvalWithRepoImports(trustPrelude()+`
      import { DocCommentNegativeStore } from './src/services/doc-comment-negative-store.js';
      const s = new DocCommentNegativeStore(${JSON.stringify(root)});
      s.prepareStoredIngress('app');
      console.log(JSON.stringify({ old:s.isDenied('app','A','c','old-legitimate'), edited:s.isDenied('app','A','c','edited') })); s.close();
    `, { encoding: 'utf8', timeout: 15_000 });
    expect(future.status).toBe(0); expect(JSON.parse(future.stdout.trim())).toEqual({ old: false, edited: true });
    expect(s.isDenied('app', 'A', 'c', 'old-legitimate')).toBe(true);
  });
  it('rejects recovery while the original epoch holder is live and marker fsync failure before allow', () => {
    const { store } = fixture(); store.initialize('app', 'A');
    const state = JSON.parse(readFileSync(store.paths('app','A').state, 'utf8'));
    expect(() => store.recoverOffline(signed({ version:1,appId:'app',fileToken:'A',previousEpochId:state.uncertain.id,
      ingressStoppedAndDrained:true,authoritativeHistoryComplete:true,evidenceReference:'fixture',operator:'host',negatives:[] }))).toThrow('negative_recovery_holder_live_or_unverified');
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('epoch_fsync_failed'); });
    expect(store.isDenied('app','failed','c','r')).toBe(true);
    expect(store.isDenied('app','failed','c','r')).toBe(true);
    expect(store.isDenied('app','B','c','r')).toBe(false);
  });
  it('defaults to anonymous after actual SIGKILL and refuses missing state or unaccounted pending recovery', () => {
    const { root, store } = fixture();
    const killed = spawnSyncTsScript('test/fixtures/comment-negative-double-fault.ts',[root,'crash'],{encoding:'utf8',timeout:15_000});
    expect(killed.signal).toBe('SIGKILL');
    expect(store.isDenied('app','A','c','old-legitimate')).toBe(true);
    const path = store.paths('app','A').state;
    const state = JSON.parse(readFileSync(path,'utf8'));
    const evidence = {version:1 as const,appId:'app',fileToken:'A',previousEpochId:state.uncertain.id,
      ingressStoppedAndDrained:true as const,authoritativeHistoryComplete:true as const,evidenceReference:'fixture',operator:'host',negatives:[]};
    secureFiles.writeSecureHostFileSync(path,JSON.stringify({...state,pending:{commentId:'c',replyId:'lost-edit'}}));
    expect(()=>store.recoverOffline(signed(evidence))).toThrow('negative_recovery_pending_not_accounted');
    rmSync(path);
    expect(store.isDenied('app','A','c','new')).toBe(true);
    expect(()=>store.recoverOffline(signed(evidence))).toThrow('negative_recovery_epoch_mismatch');
  });
  it('requires host-only explicit offline management and records the successful audit before a new epoch', () => {
    const {root,store}=fixture();
    const prior=spawnSyncTsScript('test/fixtures/comment-negative-double-fault.ts',[root,'crash'],{encoding:'utf8',timeout:15_000});
    expect(prior.signal).toBe('SIGKILL');
    const state=JSON.parse(readFileSync(store.paths('app','A').state,'utf8'));
    const manifest=join(root,'evidence.json');
    writeFileSync(manifest,JSON.stringify({version:1,appId:'app',fileToken:'A',previousEpochId:state.uncertain.id,
      ingressStoppedAndDrained:true,authoritativeHistoryComplete:true,evidenceReference:'audited-fixture',operator:'host-admin',negatives:[]}),{mode:0o600});
    const args=[root,manifest,'--confirm-offline-audited'];
    const agent=spawnSyncTsScript('scripts/recover-doc-comment-negative.ts',args,{encoding:'utf8',timeout:15_000,env:{...process.env,BOTMUX_SESSION_ID:'agent'}});
    expect(agent.status).not.toBe(0); expect(agent.stderr).toContain('negative_recovery_agent_context_forbidden');
    const env={...process.env}; delete env.BOTMUX_SESSION_ID; delete env.BOTMUX_LARK_TOOL_BINDING;
    writeFileSync(join(root,'daemon.pid'),String(process.pid));
    const live=spawnSyncTsScript('scripts/recover-doc-comment-negative.ts',args,{encoding:'utf8',timeout:15_000,env});
    expect(live.status).not.toBe(0); expect(live.stderr).toContain('negative_recovery_daemon_live');
    rmSync(join(root,'daemon.pid'));
    const unsigned=spawnSyncTsScript('scripts/recover-doc-comment-negative.ts',args,{encoding:'utf8',timeout:15_000,env});
    expect(unsigned.status).not.toBe(0);
    const payload=JSON.parse(readFileSync(manifest,'utf8'));
    store.recoverOffline(signed(payload));
    const after=JSON.parse(readFileSync(store.paths('app','A').state,'utf8'));
    expect(after.uncertain.id).toBe(state.uncertain.id);
    expect(after.recovery.auditDigest).toBeTruthy();
    expect(JSON.parse(readFileSync(join(store.paths('app','A').state,'..',`recovery-${after.recovery.auditDigest}.json`),'utf8')).payload).toBe(readFileSync(manifest,'utf8'));
    rmSync(join(store.paths('app','A').state,'..',`recovery-${after.recovery.auditDigest}.json`));
    const missing=spawnSyncTsEvalWithRepoImports(`
      import{DocCommentNegativeStore}from'./src/services/doc-comment-negative-store.js';
      const s=new DocCommentNegativeStore(${JSON.stringify(root)});let refused=false;
      try{s.prepareStoredIngress('app')}catch{refused=true}
      console.log(JSON.stringify({refused,denied:s.isDenied('app','A','c','r')}));s.close();
    `,{encoding:'utf8',timeout:15_000});
    expect(missing.status).toBe(0);expect(JSON.parse(missing.stdout.trim())).toEqual({refused:true,denied:true});
  });
  it('withholds all personal grants when the initial durable marker cannot be written', () => {
    const {store}=fixture();
    const write=vi.spyOn(secureFiles,'writeSecureHostFileSync').mockImplementationOnce(()=>{throw new Error('initial_epoch_eroffs');});
    expect(store.isDenied('app','A','c','r')).toBe(true);
    write.mockRestore();
    expect(store.isDenied('app','A','c','r')).toBe(true);
    expect(store.isDenied('app','B','c','r')).toBe(false);
  });
  it('recovers a failed directory fence only after accounting for durable pending evidence',()=>{
    const {root,store}=fixture();
    const old=spawnSyncTsEvalWithRepoImports(`
      import {DocCommentNegativeStore} from './src/services/doc-comment-negative-store.js';
      import {readSecureHostFileSync,writeSecureHostFileSync} from './src/platform/secure-host-file.js';
      import {chmodSync} from 'node:fs';import{dirname}from'node:path';
      const s=new DocCommentNegativeStore(${JSON.stringify(root)});s.initialize('app','A');
      const p=s.paths('app','A').state;const state=JSON.parse(readSecureHostFileSync(p));
      writeSecureHostFileSync(p,JSON.stringify({...state,pending:{commentId:'c',replyId:'lost'}}));
      chmodSync(dirname(p),0o500);s.close();
    `,{encoding:'utf8',timeout:15_000});
    expect(old.status).toBe(0);
    const state=JSON.parse(readFileSync(store.paths('app','A').state,'utf8'));
    expect(()=>store.recoverOffline(signed({version:1,appId:'app',fileToken:'A',previousEpochId:state.uncertain.id,
      ingressStoppedAndDrained:true,authoritativeHistoryComplete:true,evidenceReference:'fixture',operator:'host',negatives:[]}))).toThrow('negative_recovery_pending_not_accounted');
    store.recoverOffline(signed({version:1,appId:'app',fileToken:'A',previousEpochId:state.uncertain.id,
      ingressStoppedAndDrained:true,authoritativeHistoryComplete:true,evidenceReference:'fixture',operator:'host',negatives:[{commentId:'c',replyId:'lost'}]}));
    const future=spawnSyncTsEvalWithRepoImports(trustPrelude()+`
      import{DocCommentNegativeStore}from'./src/services/doc-comment-negative-store.js';
      const s=new DocCommentNegativeStore(${JSON.stringify(root)});s.prepareIngress('app','A');
      console.log(JSON.stringify({lost:s.isDenied('app','A','c','lost'),old:s.isDenied('app','A','c','legitimate')}));s.close();
    `,{encoding:'utf8',timeout:15_000});
    expect(future.status).toBe(0);expect(JSON.parse(future.stdout.trim())).toEqual({lost:true,old:false});
  });
  it('refuses self-filled unsigned and tampered admin evidence without changing an old reply epoch',()=>{
    const {store}=fixture();store.initialize('app','A');
    const before=readFileSync(store.paths('app','A').state,'utf8');
    const fake={version:1,appId:'app',fileToken:'A',authoritativeHistoryComplete:true,negatives:[]};
    expect(()=>store.recoverOffline(fake as never)).toThrow();
    const envelope=signed(fake);envelope.payload=JSON.stringify({...fake,negatives:[{commentId:'c',replyId:'r'}]});
    expect(()=>store.recoverOffline(envelope)).toThrow('negative_recovery_admin_signature_required');
    expect(readFileSync(store.paths('app','A').state,'utf8')).toBe(before);
  });
});
