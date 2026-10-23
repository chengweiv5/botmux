import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { readSecureHostFileSync, writeSecureHostFileSync, withSecureHostParentSync } from '../platform/secure-host-file.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';
import { logger } from '../utils/logger.js';
import { readVerifiedCommentRecovery, type SignedCommentRecovery } from './doc-comment-recovery-trust.js';

interface PendingVeto { commentId: string; replyId: string }
interface Epoch { id: string; pid: number; identity: string }
interface FileState { version: 1; appId: string; fileToken: string; pending?: PendingVeto; dbDev?: number; dbIno?: number;
  uncertain?: Epoch; recovery?: { id: string; issuedAt: number; auditDigest: string } }
interface Connection { db: DatabaseSyncLike; dev: number; ino: number }

export interface DocCommentRecoveryEvidence {
  version: 1; appId: string; fileToken: string; previousEpochId: string;
  ingressStoppedAndDrained: true; authoritativeHistoryComplete: true;
  evidenceReference: string; operator: string; negatives: PendingVeto[];
}

// Process-wide: closing/recreating a store must not erase a failed write. Only
// successful writes may retire their temporary guard. A failed document never
// recovers in this process. Bound exceptional failures, not normal edit traffic;
// if this working set fills, fail-stop comment personal authorization globally.
const uncertainDocuments = new Set<string>();
const MAX_UNCERTAIN_DOCUMENTS = 1024;
let personalAuthorizationStopped = false;
const runtimeStartedAt = Date.now();
const processEpoch: Epoch = { id: randomUUID(), pid: process.pid, identity: readDurableProcessIdentity(process.pid) ?? '' };

/** One local DB per app/document isolates capacity/corruption. Disk is O(exact
 * negative entries), not TTL-limited. Only connections are cached; a cache miss
 * always reads persistent authority, never infers an allow from eviction.
 * No retirement API: removal needs proof that old pending/replays cannot return.
 */
export class DocCommentNegativeStore {
  private readonly connections = new Map<string, Connection>();
  private documentGuardKey(appId: string, fileToken: string): string {
    const root = existsSync(this.dataDir) ? realpathSync(this.dataDir) : resolve(this.dataDir);
    return createHash('sha256').update(JSON.stringify([root, appId, fileToken])).digest('hex');
  }
  constructor(private readonly dataDir: string, private readonly maxConnections = 8,
    private readonly openDb = openDatabaseSyncOrThrow) {
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) throw new Error('negative_cache_capacity_invalid');
  }

  paths(appId: string, fileToken: string): { state: string; db: string } {
    const digest = createHash('sha256').update(JSON.stringify([appId, fileToken])).digest('hex');
    const dir = join(this.dataDir, 'doc-comment-negative', digest);
    return { state: join(dir, 'state.json'), db: join(dir, 'negative.sqlite') };
  }

  private readState(appId: string, fileToken: string, allowFenced = false): FileState | null {
    const dir = join(this.paths(appId, fileToken).state, '..');
    if (existsSync(dir) && (lstatSync(dir).mode & 0o777) !== 0o700
      && !(allowFenced && (lstatSync(dir).mode & 0o777) === 0o500)) throw new Error('negative_document_fenced');
    const raw = readSecureHostFileSync(this.paths(appId, fileToken).state, 16_384);
    if (raw === null) return null;
    const state = JSON.parse(raw) as FileState;
    if (state.version !== 1 || state.appId !== appId || state.fileToken !== fileToken
      || state.pending && (typeof state.pending.commentId !== 'string' || !state.pending.commentId
        || typeof state.pending.replyId !== 'string' || !state.pending.replyId)) throw new Error('negative_state_invalid');
    if (state.uncertain && (typeof state.uncertain.id !== 'string' || !state.uncertain.id
      || !Number.isSafeInteger(state.uncertain.pid) || state.uncertain.pid <= 1
      || typeof state.uncertain.identity !== 'string' || !state.uncertain.identity)) throw new Error('negative_epoch_invalid');
    if (state.recovery && (!state.uncertain || typeof state.recovery.id !== 'string'
      || !Number.isSafeInteger(state.recovery.issuedAt) || typeof state.recovery.auditDigest !== 'string')) throw new Error('negative_recovery_invalid');
    return state;
  }

  private assertPersonalEpoch(appId: string, fileToken: string): void {
    if (!processEpoch.identity) throw new Error('negative_process_identity_unavailable');
    let state = this.readState(appId, fileToken);
    if (!state) { this.initialize(appId, fileToken); state = this.readState(appId, fileToken); }
    if (!state?.uncertain || state.uncertain.id !== processEpoch.id
      || state.uncertain.pid !== processEpoch.pid || state.uncertain.identity !== processEpoch.identity
      || state.pending || state.recovery) throw new Error('negative_epoch_recovery_required');
  }

  private claimRecoveredEpoch(appId: string, fileToken: string): void {
    const paths = this.paths(appId, fileToken);
    const state = this.readState(appId, fileToken);
    if (state?.recovery && state.recovery.issuedAt < runtimeStartedAt) {
      // Only an explicit offline recovery can issue this single-use handoff.
      // Claim and replace with durable uncertain BEFORE any allow. A running
      // process predating recovery cannot silently pick it up.
      withSecureHostParentSync(paths.state, host => host.withLeafLock(() => {
        const fresh = this.readState(appId, fileToken);
        if (!fresh?.recovery || fresh.recovery.issuedAt >= runtimeStartedAt) return;
        const audit = readSecureHostFileSync(join(paths.state, '..', `recovery-${fresh.recovery.auditDigest}.json`), 16 * 1024 * 1024);
        if (!audit || createHash('sha256').update(audit).digest('hex') !== fresh.recovery.auditDigest) throw new Error('negative_recovery_audit_missing');
        const evidence = JSON.parse(readVerifiedCommentRecovery(JSON.parse(audit) as SignedCommentRecovery)) as DocCommentRecoveryEvidence;
        if (evidence.appId !== appId || evidence.fileToken !== fileToken
          || evidence.previousEpochId !== fresh.uncertain?.id || evidence.authoritativeHistoryComplete !== true
          || evidence.ingressStoppedAndDrained !== true) throw new Error('negative_recovery_signed_scope_mismatch');
        this.connection(appId, fileToken);
        const next = { ...fresh, uncertain: processEpoch, recovery: undefined };
        host.writeLeaf(JSON.stringify(next));
      }));
    }
    this.assertPersonalEpoch(appId, fileToken);
  }

  /** Must run before enabling comment ingress after an offline handoff. A
   * failed durable claim aborts ingress startup; otherwise a failed veto could
   * leave the old unused recovery permit claimable by a later process. */
  prepareIngress(appId: string, fileToken: string): void {
    let state: FileState | null;
    try { state = this.readState(appId, fileToken, true); }
    catch { return; /* invalid ordinary documents remain anonymous in resolver */ }
    try {
      if (!state) this.initialize(appId, fileToken);
      else if (state.recovery) this.claimRecoveredEpoch(appId, fileToken);
    } catch (error) {
      this.quarantine(appId, fileToken);
      if (state?.recovery) throw error; // no ingress after unclaimed recovery
      logger.error('[doc-comment-negative] initial epoch unavailable; document anonymous', { appId, fileToken });
    }
  }

  /** Include retired/unsubscribed documents: an unused offline handoff must
   * not outlive ingress that can later re-subscribe the same file. */
  prepareStoredIngress(appId: string): void {
    const root = join(this.dataDir, 'doc-comment-negative');
    if (!existsSync(root)) return;
    for (const dir of readdirSync(root)) {
      if (!/^[a-f0-9]{64}$/.test(dir)) continue;
      let state: FileState;
      try {
        const raw = readSecureHostFileSync(join(root, dir, 'state.json'), 16_384);
        if (!raw) continue; // missing state cannot mint authority
        state = JSON.parse(raw) as FileState;
      } catch { continue; /* corrupt documents cannot authorize in resolver */ }
      if (state.appId === appId) this.prepareIngress(appId, state.fileToken);
    }
  }

  private connection(appId: string, fileToken: string): DatabaseSyncLike {
    const path = this.paths(appId, fileToken).db;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || process.getuid && stats.uid !== process.getuid()
      || (stats.mode & 0o077) !== 0) throw new Error('negative_db_unsafe');
    const state = this.readState(appId, fileToken);
    if (!state || state.dbDev !== stats.dev || state.dbIno !== stats.ino) throw new Error('negative_db_identity_changed');
    const canonical = join(realpathSync(join(path, '..')), 'negative.sqlite');
    const parent = lstatSync(join(canonical, '..'));
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0
      || process.getuid && parent.uid !== process.getuid()) throw new Error('negative_parent_unsafe');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (existsSync(path + suffix) && lstatSync(path + suffix).isSymbolicLink()) throw new Error('negative_db_sidecar_unsafe');
    }
    const old = this.connections.get(canonical);
    if (old) { this.connections.delete(canonical); this.connections.set(canonical, old); return old.db; }
    while (this.connections.size >= this.maxConnections) {
      const first = this.connections.keys().next().value!;
      this.connections.get(first)!.db.close(); this.connections.delete(first);
    }
    const db = this.openDb(canonical);
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-64;');
      const meta = db.prepare('SELECT app_id, file_token, version FROM authority').get() as Record<string, unknown> | undefined;
      if (!meta || meta.app_id !== appId || meta.file_token !== fileToken || meta.version !== 1) throw new Error('negative_db_identity_invalid');
      this.connections.set(canonical, { db, dev: stats.dev, ino: stats.ino });
      return db;
    } catch (error) { db.close(); throw error; }
  }

  /** Enroll an empty document only when neither durable state nor DB exists.
   * A pending marker is written FIRST; crashes cannot turn a half-enrollment
   * or deleted/corrupt DB into a fresh empty authority.
   */
  initialize(appId: string, fileToken: string): void {
    try { this.initializeDurable(appId, fileToken); }
    catch (error) { this.quarantine(appId, fileToken); throw error; }
  }

  private quarantine(appId: string, fileToken: string): void {
    try {
      if (uncertainDocuments.size >= MAX_UNCERTAIN_DOCUMENTS) personalAuthorizationStopped = true;
      else uncertainDocuments.add(this.documentGuardKey(appId, fileToken));
    } catch { personalAuthorizationStopped = true; }
  }

  private initializeDurable(appId: string, fileToken: string): void {
    if (!processEpoch.identity) throw new Error('negative_process_identity_unavailable');
    const paths = this.paths(appId, fileToken);
    const state = this.readState(appId, fileToken);
    if (state) {
      if (state.pending) throw new Error('negative_write_pending');
      this.connection(appId, fileToken); return;
    }
    // A missing state beside any existing DB (including dangling symlinks) is
    // corruption, never an instruction to reset historical negative evidence.
    try { lstatSync(paths.db); throw new Error('negative_state_missing'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    writeSecureHostFileSync(paths.state, JSON.stringify({ version: 1, appId, fileToken,
      pending: { commentId: '__initialization__', replyId: '__initialization__' } }));
    mkdirSync(join(paths.db, '..'), { recursive: true, mode: 0o700 });
    const db = this.openDb(paths.db);
    try {
      chmodSync(paths.db, 0o600);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      db.exec('CREATE TABLE authority (version INTEGER NOT NULL, app_id TEXT NOT NULL, file_token TEXT NOT NULL);'
        + 'CREATE TABLE veto (comment_id TEXT NOT NULL, reply_id TEXT NOT NULL, PRIMARY KEY(comment_id, reply_id)) WITHOUT ROWID;');
      db.prepare('INSERT INTO authority VALUES (1, ?, ?)').run(appId, fileToken);
      db.exec('COMMIT;');
    } finally { db.close(); }
    const stats = lstatSync(paths.db);
    // There is NO clean epoch. Persist before the first personal allow and
    // retain through normal exit/crash/deny writes. A new OS process is anonymous.
    writeSecureHostFileSync(paths.state, JSON.stringify({ version: 1, appId, fileToken,
      dbDev: stats.dev, dbIno: stats.ino, uncertain: processEpoch }));
    // atomic leaf fsync is insufficient for a newly-created document/root
    // directory: persist their entries too before allowing personal authority.
    for (const dir of [join(paths.state, '..'), join(this.dataDir, 'doc-comment-negative'), this.dataDir]) {
      const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }

  deny(appId: string, fileToken: string, commentId: string, replyId: string): void {
    let guard: string;
    try { guard = this.documentGuardKey(appId, fileToken); }
    catch (error) { personalAuthorizationStopped = true; throw error; }
    if (personalAuthorizationStopped || uncertainDocuments.has(guard)) throw new Error('negative_process_quarantine');
    if (uncertainDocuments.size >= MAX_UNCERTAIN_DOCUMENTS) {
      personalAuthorizationStopped = true;
      logger.error('[doc-comment-negative] comment personal authorization fail-stopped; recovery required', { appId, fileToken });
      throw new Error('negative_process_fail_stop');
    }
    // BEFORE any persistence I/O: a failed marker AND failed metadata fence
    // cannot leave later resolvers reading the old clean authority as an allow.
    uncertainDocuments.add(guard);
    try { this.persistVeto(appId, fileToken, commentId, replyId); uncertainDocuments.delete(guard); }
    catch (error) {
      // Even ENOSPC before the pending leaf rename must not leave a clean
      // document readable. A permission fence changes inode metadata without
      // allocating another denial record; later readers explicitly reject it.
      const dir = join(this.paths(appId, fileToken).state, '..');
      try {
        chmodSync(dir, 0o500);
        const fd = openSync(dir, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch (fenceError) {
        logger.error('[doc-comment-negative] unable to persist document failure fence', { appId, fileToken,
          code: fenceError instanceof Error ? fenceError.message : String(fenceError) });
      }
      throw error;
    }
  }

  private persistVeto(appId: string, fileToken: string, commentId: string, replyId: string): void {
    // An unfinished write may have lost additional negatives after the first
    // failure. Never clear that document fence just because a later write
    // succeeds. Recovery must verify all outstanding negatives offline.
    let state = this.readState(appId, fileToken);
    if (!state) { this.initialize(appId, fileToken); state = this.readState(appId, fileToken); }
    if (state!.pending) throw new Error('negative_write_pending');
    writeSecureHostFileSync(this.paths(appId, fileToken).state,
      JSON.stringify({ ...state, pending: { commentId, replyId } }));
    const db = this.connection(appId, fileToken);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO veto (comment_id, reply_id) VALUES (?, ?)');
      insert.run(commentId, replyId);
      db.exec('COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK;'); } catch { /* retain pending */ } throw error; }
    writeSecureHostFileSync(this.paths(appId, fileToken).state, JSON.stringify(state));
  }

  isDenied(appId: string, fileToken: string, commentId: string, replyId: string): boolean {
    try {
      if (personalAuthorizationStopped || uncertainDocuments.has(this.documentGuardKey(appId, fileToken))) {
        throw new Error('negative_process_quarantine');
      }
      const state = this.readState(appId, fileToken);
      if (!state) this.initialize(appId, fileToken);
      else if (state.pending) throw new Error('negative_write_pending');
      this.assertPersonalEpoch(appId, fileToken);
      return !!this.connection(appId, fileToken).prepare('SELECT 1 FROM veto WHERE comment_id=? AND reply_id=?').get(commentId, replyId);
    } catch (error) {
      // An epoch write whose fsync failed must not be trusted on a retry just
      // because its bytes became visible in the page cache.
      if ((error as Error).message !== 'negative_epoch_recovery_required') this.quarantine(appId, fileToken);
      logger.error('[doc-comment-negative] document personal authorization withheld', {
        appId, fileToken, code: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  get cachedConnections(): number { return this.connections.size; }
  close(): void { for (const entry of this.connections.values()) entry.db.close(); this.connections.clear(); }

  /** Host OFFLINE management only. Evidence is an explicit operator attestation
   * of audited authoritative history, never a CLI/IM identity proof. Cannot run
   * alongside the original epoch holder, clear negatives, or grant a caller. */
  recoverOffline(signed: SignedCommentRecovery): void {
    const evidence = JSON.parse(readVerifiedCommentRecovery(signed)) as DocCommentRecoveryEvidence;
    const { appId, fileToken } = evidence;
    if (evidence.version !== 1 || !appId || !fileToken || !evidence.previousEpochId
      || evidence.ingressStoppedAndDrained !== true || evidence.authoritativeHistoryComplete !== true
      || !evidence.evidenceReference?.trim() || !evidence.operator?.trim() || !Array.isArray(evidence.negatives)
      || evidence.negatives.some(n => !n || typeof n.commentId !== 'string' || !n.commentId
        || typeof n.replyId !== 'string' || !n.replyId)) throw new Error('negative_recovery_evidence_required');
    const paths = this.paths(appId, fileToken);
    // A 0500 failed document cannot create a lock leaf. Validate the audited
    // offline transition BEFORE lifting that fence; uncertain remains durable.
    const before = this.readState(appId, fileToken, true);
    if (!before?.uncertain || before.uncertain.id !== evidence.previousEpochId || before.recovery) throw new Error('negative_recovery_epoch_mismatch');
    try { process.kill(before.uncertain.pid, 0); throw new Error('negative_recovery_holder_live_or_unverified'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (before.pending && !evidence.negatives.some(n => n.commentId === before.pending!.commentId && n.replyId === before.pending!.replyId)) throw new Error('negative_recovery_pending_not_accounted');
    chmodSync(join(paths.state, '..'), 0o700);
    const directoryFd = openSync(join(paths.state, '..'), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    withSecureHostParentSync(paths.state, host => host.withLeafLock(() => {
      const state = this.readState(appId, fileToken, true);
      if (!state?.uncertain || state.uncertain.id !== evidence.previousEpochId || state.recovery) throw new Error('negative_recovery_epoch_mismatch');
      // kill(0) is conservative: PID reuse/permission uncertainty also refuses.
      let dead = false;
      try { process.kill(state.uncertain.pid, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new Error('negative_recovery_holder_live_or_unverified');
      if (state.pending && !evidence.negatives.some(n => n.commentId === state.pending!.commentId && n.replyId === state.pending!.replyId)) {
        throw new Error('negative_recovery_pending_not_accounted');
      }
      // Only after offline audited evidence validation; uncertain is retained
      // while lifting the filesystem fence and through every failure below.
      const dir = join(paths.state, '..');
      chmodSync(dir, 0o700);
      const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      const db = this.connection(appId, fileToken);
      const audit = JSON.stringify(signed);
      const digest = createHash('sha256').update(audit).digest('hex');
      // Preserve evidence/audit durably before changing the handoff state.
      writeSecureHostFileSync(join(paths.state, '..', `recovery-${digest}.json`), audit);
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const negative of evidence.negatives) db.prepare('INSERT OR IGNORE INTO veto VALUES (?, ?)').run(negative.commentId, negative.replyId);
        db.exec('COMMIT;');
      } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
      host.writeLeaf(JSON.stringify({ ...state, pending: undefined,
        recovery: { id: randomUUID(), issuedAt: Date.now(), auditDigest: digest } }));
    }));
  }
}
