import { join, relative, resolve } from 'node:path';

/** Mandatory authority roots, never user policy. PID files are not proof, but
 * hiding them also prevents the old offline-gate bypass via a writable project. */
export function docCommentHostOnlyPaths(dataDir: string): string[] {
  return [join(dataDir, 'doc-comment-negative'), join(dataDir, 'daemon.pid')];
}

export function assertDocCommentHostStorageOutsideWritableRoots(dataDir: string, roots: readonly string[], isolated: boolean): void {
  if (isolated) return;
  const authority = resolve(dataDir, 'doc-comment-negative');
  const covers = (a: string, b: string) => { const r = relative(resolve(a), resolve(b)); return !r || !r.startsWith('..') && !r.startsWith('/'); };
  if (roots.some(root => covers(root, authority) || covers(authority, root))) {
    throw new Error('doc_comment_host_storage_overlaps_unisolated_writable_root');
  }
}
