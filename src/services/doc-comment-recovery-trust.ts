import { verify, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

// Fixed OS-admin trust anchor. Never environment/workingDir/dataDir controlled.
const KEY_PATH = '/etc/botmux/comment-recovery/public-key.pem';
export interface SignedCommentRecovery { payload: string; signature: string }

export function verifyCommentRecoverySignature(envelope: SignedCommentRecovery, publicKey: string): string {
  const key = createPublicKey(publicKey);
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string'
    || key.asymmetricKeyType !== 'ed25519'
    || envelope.payload.length > 16 * 1024 * 1024
    || !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('negative_recovery_admin_signature_required');
  }
  return envelope.payload;
}

export function readVerifiedCommentRecovery(envelope: SignedCommentRecovery): string {
  if (process.platform === 'win32') throw new Error('negative_recovery_admin_trust_unsupported');
  for (const path of ['/etc', '/etc/botmux', '/etc/botmux/comment-recovery', KEY_PATH]) {
    const s = lstatSync(path);
    if (s.uid !== 0 || s.isSymbolicLink() || (s.mode & 0o022) !== 0
      || (path === KEY_PATH ? !s.isFile() : !s.isDirectory())) throw new Error('negative_recovery_admin_trust_unsafe');
  }
  return verifyCommentRecoverySignature(envelope, readFileSync(KEY_PATH, 'utf8'));
}
