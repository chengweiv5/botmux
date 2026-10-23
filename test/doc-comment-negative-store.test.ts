import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, renameSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocCommentNegativeStore } from '../src/services/doc-comment-negative-store.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import { logger } from '../src/utils/logger.js';
import * as secureFiles from '../src/platform/secure-host-file.js';
import { putDocSubscription, removeDocSubscription } from '../src/services/doc-subs-store.js';

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
    expect(() => store.deny('app', 'A', 'c', 'later')).toThrow('negative_document_fenced');
    store.close(); const reopened = new DocCommentNegativeStore(root); stores.push(reopened);
    expect(reopened.isDenied('app', 'A', 'c', 'r')).toBe(true);
    expect(reopened.isDenied('app', 'A', 'c', 'later')).toBe(true);
    expect(reopened.isDenied('app', 'B', 'c', 'r')).toBe(false);
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
});
