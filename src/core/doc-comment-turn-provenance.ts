import type { DaemonSession } from './types.js';
import type { Session, TrustedCaller } from '../types.js';

interface CommentTurnRecord {
  session: Session;
  appId: string;
  sessionId: string;
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  turnId: string;
  workerGeneration: number;
  /** Absent means an admitted comment without positive human testimony. */
  authorOpenId?: string;
}

// Host memory only: never restore authority from a Session projection, CLI
// payload, subscription owner, display cache, or document reply destination.
const records = new WeakMap<DaemonSession, Map<string, CommentTurnRecord>>();

export function registerDocCommentTurn(
  ds: DaemonSession,
  input: Omit<CommentTurnRecord, 'session' | 'appId' | 'sessionId'>,
): void {
  const turns = records.get(ds) ?? new Map<string, CommentTurnRecord>();
  records.set(ds, turns);
  turns.set(input.turnId, { ...input, session: ds.session,
    appId: ds.larkAppId, sessionId: ds.session.sessionId });
}

export function isDocCommentTurn(ds: DaemonSession, turnId: string): boolean {
  // Async Ask answers may use a document delivery sink but are fresh IM/card
  // turns with their existing independent authorization. A sink is not origin.
  const target = ds.session.docCommentTargets?.[turnId] ?? ds.docCommentTurns?.get(turnId);
  return /^\d+$/.test(turnId) || records.get(ds)?.has(turnId) === true
    || !!target && (!!target.replyId || turnId === target.commentId);
}

export function resolveDocCommentTurnCaller(ds: DaemonSession, turnId: string): TrustedCaller | undefined {
  const record = records.get(ds)?.get(turnId);
  const target = ds.session.docCommentTargets?.[turnId];
  if (!record || !record.authorOpenId || !/^ou_[A-Za-z0-9]+$/.test(record.authorOpenId)
    || !target || ds.session.status !== 'active'
    || record.session !== ds.session || record.appId !== ds.larkAppId
    || ds.session.larkAppId !== record.appId || record.sessionId !== ds.session.sessionId
    || record.turnId !== turnId || record.replyId !== turnId
    || !Number.isSafeInteger(record.workerGeneration) || record.workerGeneration <= 0
    || record.workerGeneration !== ds.workerGeneration
    || record.workerGeneration !== ds.session.workerGeneration
    || target.turnId !== turnId || target.fileToken !== record.fileToken
    || target.fileType !== record.fileType || target.commentId !== record.commentId
    || target.replyId !== record.replyId) return undefined;
  return { requestLarkAppId: record.appId, requestUserOpenId: record.authorOpenId, senderType: 'user' };
}

/** Comment routes must not accept a stale worker's caller or an IM/delegation
 * fallback when their exact host record is unavailable. */
export function currentDocCommentHuman(ds: DaemonSession, turnId: string): string | undefined {
  const caller = resolveDocCommentTurnCaller(ds, turnId)?.requestUserOpenId;
  return ds.worker && !ds.worker.killed && ds.managedTurnOrigin?.turnId === turnId
    && ds.managedTurnOrigin.callerOpenId === caller ? caller : undefined;
}

export function forgetDocCommentTurn(ds: DaemonSession, turnId: string): void {
  const record = records.get(ds)?.get(turnId);
  // Keep an anonymous tombstone until generation rotation: a late publication
  // must not fall back to an IM slot after the delivery target was consumed.
  if (record) record.authorOpenId = undefined;
}

export function clearDocCommentTurnProvenance(ds: DaemonSession): void {
  records.delete(ds);
}
