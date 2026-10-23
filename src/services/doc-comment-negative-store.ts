import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';
import { logger } from '../utils/logger.js';

interface PendingVeto { commentId: string; replyId: string }
interface FileState { version: 1; appId: string; fileToken: string; pending?: PendingVeto; dbDev?: number; dbIno?: number }
interface Connection { db: DatabaseSyncLike; dev: number; ino: number }

/** One local DB per app/document isolates capacity/corruption. Disk is O(exact
 * negative entries), not TTL-limited. Only connections are cached; a cache miss
 * always reads persistent authority, never infers an allow from eviction.
 * No retirement API: removal needs proof that old pending/replays cannot return.
 */
export class DocCommentNegativeStore {
  private readonly connections = new Map<string, Connection>();
  constructor(private readonly dataDir: string, private readonly maxConnections = 8,
    private readonly openDb = openDatabaseSyncOrThrow) {
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) throw new Error('negative_cache_capacity_invalid');
  }

  paths(appId: string, fileToken: string): { state: string; db: string } {
    const digest = createHash('sha256').update(JSON.stringify([appId, fileToken])).digest('hex');
    const dir = join(this.dataDir, 'doc-comment-negative', digest);
    return { state: join(dir, 'state.json'), db: join(dir, 'negative.sqlite') };
  }

  private readState(appId: string, fileToken: string): FileState | null {
    const dir = join(this.paths(appId, fileToken).state, '..');
    if (existsSync(dir) && (lstatSync(dir).mode & 0o777) !== 0o700) throw new Error('negative_document_fenced');
    const raw = readSecureHostFileSync(this.paths(appId, fileToken).state, 16_384);
    if (raw === null) return null;
    const state = JSON.parse(raw) as FileState;
    if (state.version !== 1 || state.appId !== appId || state.fileToken !== fileToken
      || state.pending && (typeof state.pending.commentId !== 'string' || !state.pending.commentId
        || typeof state.pending.replyId !== 'string' || !state.pending.replyId)) throw new Error('negative_state_invalid');
    return state;
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
    writeSecureHostFileSync(paths.state, JSON.stringify({ version: 1, appId, fileToken, dbDev: stats.dev, dbIno: stats.ino }));
  }

  deny(appId: string, fileToken: string, commentId: string, replyId: string): void {
    try { this.persistVeto(appId, fileToken, commentId, replyId); }
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
      const state = this.readState(appId, fileToken);
      if (!state) this.initialize(appId, fileToken);
      else if (state.pending) throw new Error('negative_write_pending');
      return !!this.connection(appId, fileToken).prepare('SELECT 1 FROM veto WHERE comment_id=? AND reply_id=?').get(commentId, replyId);
    } catch (error) {
      logger.error('[doc-comment-negative] document personal authorization withheld', {
        appId, fileToken, code: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  get cachedConnections(): number { return this.connections.size; }
  close(): void { for (const entry of this.connections.values()) entry.db.close(); this.connections.clear(); }
}
