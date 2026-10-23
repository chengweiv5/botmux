import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {assertDocCommentHostStorageOutsideWritableRoots} from '../src/core/doc-comment-host-boundary.js';
import {verifyCommentRecoverySignature,readVerifiedCommentRecovery} from '../src/services/doc-comment-recovery-trust.js';

describe('comment host authority boundary',()=>{
  it('rejects unsafe unisolated workingDir and explicit write roots without affecting isolated configurations',()=>{
    expect(()=>assertDocCommentHostStorageOutsideWritableRoots('/project/data',['/project'],false)).toThrow();
    expect(()=>assertDocCommentHostStorageOutsideWritableRoots('/data',['/data/doc-comment-negative/nested'],false)).toThrow();
    expect(()=>assertDocCommentHostStorageOutsideWritableRoots('/data',['/project'],false)).not.toThrow();
    expect(()=>assertDocCommentHostStorageOutsideWritableRoots('/project/data',['/project'],true)).not.toThrow();
  });
  it('binds the exact evidence bytes to an independent administrator key',()=>{
    const k=generateKeyPairSync('ed25519');const pem=k.publicKey.export({type:'spki',format:'pem'}).toString();
    const payload=JSON.stringify({appId:'app',fileToken:'file',previousEpochId:'old',negatives:[]});
    const e={payload,signature:sign(null,Buffer.from(payload),k.privateKey).toString('base64')};
    expect(verifyCommentRecoverySignature(e,pem)).toBe(payload);
    expect(()=>verifyCommentRecoverySignature({...e,payload:payload+' '},pem)).toThrow();
    expect(()=>verifyCommentRecoverySignature({payload,signature:''},pem)).toThrow();
    // No environment-selected key. Current fixture has no installed OS trust
    // anchor; unsigned/self-asserted evidence must be rejected in production.
    expect(()=>readVerifiedCommentRecovery({payload,signature:''})).toThrow();
  });
});
