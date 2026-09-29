import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CotSendObserver } from '../src/services/cot-send-observer.js';

describe('CotSendObserver', () => {
  let directory: string;
  let path: string;
  const marker = (fields = {}) => JSON.stringify({ turnId: 'turn1', dispatchAttempt: 2,
    messageId: 'om_reply1', responseKind: 'progress', cotDelivery: { deliveredAtMs: 100 }, ...fields }) + '\n';
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cot-observer-')); path = join(directory, 'sends.jsonl'); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads completed lines once, retaining a partial row until completed', () => {
    const reader = new CotSendObserver(path, 'turn1', 2);
    expect(reader.read()).toEqual([]);
    const line = marker();
    writeFileSync(path, line.slice(0, -5));
    expect(reader.read()).toEqual([]);
    appendFileSync(path, line.slice(-5));
    expect(reader.read()).toEqual([{ messageId: 'om_reply1', deliveredAtMs: 100, final: false }]);
    expect(reader.read()).toEqual([]);
    appendFileSync(path, line);
    expect(reader.read()).toEqual([]);
  });

  it('isolates turns and dispatch attempts, ignoring old fallback and document records', () => {
    writeFileSync(path, [marker({ turnId: 'turn2' }), marker({ dispatchAttempt: undefined }),
      marker({ cotDelivery: undefined, sentAtMs: 100 }), marker({ messageId: 'doc:comment' }),
      marker({ cotDelivery: { deliveredAtMs: '100' } }), 'not-json\n', marker()].join(''));
    expect(new CotSendObserver(path, 'turn1', 2).read()).toHaveLength(1);
  });

  it('recognizes the primary final immediately even before attachments finish', () => {
    writeFileSync(path, marker({ cotDelivery: undefined, responseKind: 'final', cotFinal: true, sentAtMs: 99 }));
    const reader = new CotSendObserver(path, 'turn1', 2);
    expect(reader.read()).toEqual([{ messageId: 'om_reply1', deliveredAtMs: 99, final: true }]);
    appendFileSync(path, marker({ responseKind: 'final' }));
    expect(reader.read()).toEqual([]);
  });

  it('recovers after journal replacement without replaying previously observed deliveries', () => {
    writeFileSync(path, marker());
    const reader = new CotSendObserver(path, 'turn1', 2);
    expect(reader.read()).toHaveLength(1);
    writeFileSync(join(directory, 'next'), marker() + marker({ messageId: 'om_reply2' }));
    renameSync(join(directory, 'next'), path);
    expect(reader.read().map(r => r.messageId)).toEqual(['om_reply2']);
  });
});
