import type { DaemonSession } from './types.js';
import type { Session, TrustedCaller } from '../types.js';
import { config } from '../config.js';
import { DocCommentNegativeStore } from '../services/doc-comment-negative-store.js';
import { logger } from '../utils/logger.js';

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
  cliLifetime: number;
  /** Absent means an admitted comment without positive human testimony. */
  authorOpenId?: string;
}

// Host memory only: never restore authority from a Session projection, CLI
// payload, subscription owner, display cache, or document reply destination.
const records = new WeakMap<DaemonSession, Map<string, CommentTurnRecord>>();
const cliLifetimes = new WeakMap<DaemonSession, number>();
/** Exact negatives live on disk, with a bounded connection working set. */
let negativeStore: DocCommentNegativeStore | undefined;
let negativeDataDir: string | undefined;
function negatives(): DocCommentNegativeStore {
  if (!negativeStore || negativeDataDir !== config.session.dataDir) {
    negativeStore?.close(); negativeDataDir = config.session.dataDir;
    negativeStore = new DocCommentNegativeStore(negativeDataDir);
  }
  return negativeStore;
}

export function docCommentCliLifetime(ds: DaemonSession): number {
  return cliLifetimes.get(ds) ?? 0;
}

/** Restart/exit invalidates even an in-flight read that has not registered yet. */
export function revokeDocCommentCliLifetime(ds: DaemonSession): boolean {
  const hadHuman = [...(records.get(ds)?.values() ?? [])].some(record => !!record.authorOpenId);
  cliLifetimes.set(ds, docCommentCliLifetime(ds) + 1);
  for (const record of records.get(ds)?.values() ?? []) record.authorOpenId = undefined;
  return hadHuman
    || !!ds.managedTurnOrigin?.turnId && isDocCommentTurn(ds, ds.managedTurnOrigin.turnId);
}

/** Ingress veto is independent of delivery claim ownership and survives later
 * admission/retry. An operator is only negative testimony, never a principal. */
export function vetoDocCommentHuman(app: string, file: string, comment: string, reply: string): void {
  try { negatives().deny(app, file, comment, reply); }
  catch (error) {
    logger.error('[doc-comment-negative] exact veto persistence failed; document withheld', {
      appId: app, fileToken: file, code: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerDocCommentTurn(
  ds: DaemonSession,
  input: Omit<CommentTurnRecord, 'session' | 'appId' | 'sessionId' | 'cliLifetime'> & { cliLifetime?: number },
): void {
  const turns = records.get(ds) ?? new Map<string, CommentTurnRecord>();
  records.set(ds, turns);
  turns.set(input.turnId, { ...input, cliLifetime: input.cliLifetime ?? docCommentCliLifetime(ds), session: ds.session,
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
    || record.cliLifetime !== docCommentCliLifetime(ds)
    || negatives().isDenied(record.appId, record.fileToken, record.commentId, record.replyId)
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
