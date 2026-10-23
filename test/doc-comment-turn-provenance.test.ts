import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { registerDocCommentTurn, resolveDocCommentTurnCaller, isDocCommentTurn,
  currentDocCommentHuman, forgetDocCommentTurn, clearDocCommentTurnProvenance,
  docCommentCliLifetime, revokeDocCommentCliLifetime } from '../src/core/doc-comment-turn-provenance.js';
import { currentGatewayCallerOpenId } from '../src/core/worker-pool.js';

function fixture() {
  const target = { fileToken: 'file', fileType: 'docx', commentId: 'comment', replyId: 'reply', turnId: 'reply', replyToOpenId: 'ou_owner' };
  const ds = { larkAppId: 'cli_app', workerGeneration: 1, worker: { killed: false },
    session: { sessionId: 'session', larkAppId: 'cli_app', status: 'active', workerGeneration: 1,
      docCommentTargets: { reply: target }, replyTargets: { reply: { senderOpenId: 'ou_oldIM' } } },
    managedTurnOrigin: { capability: 'cap', turnId: 'reply', callerOpenId: 'ou_author' },
  } as unknown as DaemonSession;
  const record = { ...target, workerGeneration: 1, authorOpenId: 'ou_author' };
  registerDocCommentTurn(ds, record);
  return { ds, record, target };
}

describe('daemon-owned exact comment turn provenance', () => {
  it('resolves the admitted author through worker gateway, not destination or stale IM', () => {
    const { ds } = fixture();
    expect(resolveDocCommentTurnCaller(ds, 'reply')).toEqual({ requestLarkAppId: 'cli_app', requestUserOpenId: 'ou_author', senderType: 'user' });
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBe('ou_author');
    expect(currentDocCommentHuman(ds, 'reply')).toBe('ou_author');
  });
  it.each(['fileToken', 'fileType', 'commentId', 'replyId', 'turnId'] as const)('refuses mismatched %s', key => {
    const { ds, target } = fixture(); target[key] = 'different';
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBeUndefined();
    expect(currentDocCommentHuman(ds, 'reply')).toBeUndefined();
  });
  it.each(['app', 'session', 'session-object', 'generation', 'persisted-generation', 'closed', 'worker', 'origin'])(
    'fails closed on %s boundary', boundary => {
      const { ds } = fixture();
      if (boundary === 'app') ds.larkAppId = 'cli_other';
      if (boundary === 'session') ds.session.sessionId = 'other';
      if (boundary === 'session-object') ds.session = { ...ds.session };
      if (boundary === 'generation') ds.workerGeneration = 2;
      if (boundary === 'persisted-generation') ds.session.workerGeneration = 2;
      if (boundary === 'closed') ds.session.status = 'closed';
      if (boundary === 'worker') ds.worker!.killed = true;
      if (boundary === 'origin') ds.managedTurnOrigin!.callerOpenId = 'ou_owner';
      expect(currentDocCommentHuman(ds, 'reply')).toBeUndefined();
    });
  it('withholds an unknown/nonhuman author even when IM and owner slots are populated', () => {
    const { ds, record } = fixture(); registerDocCommentTurn(ds, { ...record, authorOpenId: undefined });
    expect(isDocCommentTurn(ds, 'reply')).toBe(true);
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBeUndefined();
  });
  it('does not restore records from disk or into a replacement daemon/session', () => {
    const { ds } = fixture(); const restored = { ...ds, session: { ...ds.session } };
    expect(isDocCommentTurn(restored, 'reply')).toBe(true);
    expect(currentGatewayCallerOpenId(restored, 'reply')).toBeUndefined();
    clearDocCommentTurnProvenance(ds);
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBeUndefined();
  });
  it('does not treat a fresh authorized Ask answer as comment origin merely because its sink is a document', () => {
    const { ds } = fixture();
    ds.session.docCommentTargets!['codex-async-answer-fresh'] = { fileToken: 'file', fileType: 'docx', commentId: 'comment', turnId: 'codex-async-answer-fresh' };
    ds.session.replyTargets!['codex-async-answer-fresh'] = { rootMessageId: 'om_root', turnId: 'codex-async-answer-fresh', createdAt: new Date().toISOString(), senderOpenId: 'ou_answer' };
    expect(isDocCommentTurn(ds, 'codex-async-answer-fresh')).toBe(false);
    expect(currentGatewayCallerOpenId(ds, 'codex-async-answer-fresh')).toBe('ou_answer');
  });
  it('isolates concurrent comments and retires only the exact terminal turn', () => {
    const { ds, record } = fixture();
    ds.session.docCommentTargets!.next = { ...ds.session.docCommentTargets!.reply, turnId: 'next', replyId: 'next' };
    registerDocCommentTurn(ds, { ...record, turnId: 'next', replyId: 'next', authorOpenId: 'ou_next' });
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBe('ou_author');
    expect(currentGatewayCallerOpenId(ds, 'next')).toBe('ou_next');
    forgetDocCommentTurn(ds, 'reply');
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBeUndefined();
    expect(currentGatewayCallerOpenId(ds, 'next')).toBe('ou_next');
  });
  it('invalidates an admission read crossing a CLI restart without clearing unrelated IM identities', () => {
    const { ds, record } = fixture();
    const lifetime = docCommentCliLifetime(ds);
    expect(revokeDocCommentCliLifetime(ds)).toBe(true);
    registerDocCommentTurn(ds, { ...record, cliLifetime: lifetime });
    expect(currentGatewayCallerOpenId(ds, 'reply')).toBeUndefined();
    forgetDocCommentTurn(ds, 'reply');
    ds.managedTurnOrigin = { turnId: 'om_fresh', capability: 'cap', callerOpenId: 'ou_IM' };
    expect(revokeDocCommentCliLifetime(ds)).toBe(false);
  });
});
