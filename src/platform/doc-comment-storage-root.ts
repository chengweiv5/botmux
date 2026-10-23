import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { secureHostFilePath } from './secure-host-file.js';

/** Host mask preparation shared with the worker's credential-only launch. */
export function prepareDocCommentNegativeMaskRoot(dataDir: string): string {
  const root = join(realpathSync(dataDir), 'doc-comment-negative');
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700
    || process.getuid && stats.uid !== process.getuid()) throw new Error('negative_mask_root_unsafe');
  // Reuse strict ancestry validation, without creating an authority leaf.
  const canonical = dirname(secureHostFilePath(join(root, '.mask-root-probe')));
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = fstatSync(fd);
    const current = lstatSync(canonical);
    if (pinned.dev !== stats.dev || pinned.ino !== stats.ino
      || pinned.dev !== current.dev || pinned.ino !== current.ino) throw new Error('negative_mask_root_changed');
    fsyncSync(fd);
    const parentFd = openSync(dirname(canonical), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } finally { closeSync(fd); }
  return canonical;
}
