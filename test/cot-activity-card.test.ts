import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';

const request = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { cotEnabled: true, cotDisplay: 'activity' } })),
  getBotClient: vi.fn(() => ({ request })),
}));
import { config } from '../src/config.js';
import { getBot } from '../src/bot-registry.js';
import { activitySummary, buildActivityCard, updateActivityCard, showActivityPage, type ActivityEvent } from '../src/im/lark/cot-activity-card.js';
import { handleCotThinkingUpdate, finalizeCotMessage, abortCotMessage, sweepOrphanCotMessages, settleCotMessageForShutdown } from '../src/im/lark/cot-message.js';

const ev = (event_type: string, data: unknown): ActivityEvent => ({ event_type, content: JSON.stringify(data), timestamp: 100 });
const eventHistory = [ev('REASONING_MESSAGE_CONTENT', { delta: 'Inspect access controls.' }),
  ev('TOOL_CALL_START', { toolCallName: 'Read', title: '读取文件 · a.ts' }),
  ev('TOOL_CALL_START', { toolCallName: 'Bash', title: '执行命令 · bun test' }),
  ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'code', code: 'All tests passed.' }) })];

describe('activity card presentation', () => {
  it('uses a gray concrete action summary without implying task completion', () => {
    const card = JSON.parse(buildActivityCard(eventHistory, true));
    const panel = card.body.elements[0];
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toBe("<font color='grey'>读取文件 1 次，执行命令 1 次</font>");
    expect(panel.header.icon.color).toBe('grey');
    expect(JSON.stringify(card)).not.toMatch(/任务已完成|Completed|done_outlined/);
    expect(JSON.stringify(card)).toContain('Inspect access controls&#46;');
    expect(JSON.stringify(card)).toContain('All tests passed&#46;');
  });

  it('shows a live operation and preserves earlier records in the expanded body', () => {
    const card = JSON.parse(buildActivityCard(eventHistory.slice(0, -1), false));
    expect(card.body.elements[0].header.title.content).toContain('正在执行命令');
    expect(JSON.stringify(card)).toContain('Inspect access controls&#46;');
    expect(JSON.stringify(card)).toContain('本轮完整活动记录');
  });

  it('does not label a returned tool result as still executing', () => {
    const card = JSON.parse(buildActivityCard(eventHistory, false));
    expect(card.body.elements[0].header.title.content).toBe('正在处理…');
  });

  it('does not turn transcript text into mentions, HTML or links', () => {
    const raw = '<at id=all></at> [secret](https://example.com) <font color=red>text</font>';
    const card = buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: raw })], true);
    const title = JSON.parse(card).body.elements[0].header.title.content;
    expect(title).toContain('&#60;at');
    expect(title).not.toContain('<at');
    expect(title).not.toContain('[secret]');
  });

  it('keeps long histories complete without exceeding the component limit', () => {
    const text = '活动记录'.repeat(15_000);
    const card = JSON.parse(buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: text })], true));
    expect(Buffer.byteLength(JSON.stringify({ card: { type: 'card_json', data: JSON.stringify(card) }, sequence: 2147483647 }))).toBeLessThanOrEqual(30000);
    let rebuilt = '';
    const total = Number(card.body.elements[0].elements[0].content.match(/1\/(\d+)/)[1]);
    for (let page = 0; page < total; page++) {
      const next = JSON.parse(buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: text })], true, false, { cardId: 'pages', page }));
      rebuilt += next.body.elements[0].elements[1].content;
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(30000);
    }
    expect(rebuilt).toBe(text);
  });

  it('does not show a completion label for redacted tool results', () => {
    const card = buildActivityCard([ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'text', text: '✓ 已完成' }) })], true);
    expect(card).not.toContain('已完成');
    expect(activitySummary([], true)).toBe('Activity record');
    const live = JSON.parse(buildActivityCard([eventHistory[2], ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'text', text: '✓ 已完成' }) })], false));
    expect(live.body.elements[0].header.title.content).toBe('正在处理…');
  });

  it('renders raw tables and other block syntax as literal text', () => {
    const text = '| a | b |\n|---|---|\n|1|2|\n\n'.repeat(5) + '---\n- list\n1. item\n:DONE:\n    indented';
    const card = JSON.parse(buildActivityCard([ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'code', code: text }) })], true));
    const detail = card.body.elements[0].elements[1].content;
    const tokens = new MarkdownIt().parse(detail, {});
    expect(tokens.some(t => ['table_open', 'hr', 'bullet_list_open', 'ordered_list_open', 'code_block'].includes(t.type))).toBe(false);
    expect(detail).toContain('&#124;');
    expect(detail).not.toContain(':DONE:');
  });
});

describe('activity card lifecycle', () => {
  let ds: any;
  let nextId: number;
  const directory = () => join(config.session.dataDir, 'cot-orphans');
  const journal = () => join(config.session.dataDir, 'turn-sends', 'activity-test.jsonl');
  const update = (text: string, turnId = 'om_turn') => handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId, entries: [{ kind: 'text', text }] });
  const drain = async (done: () => boolean) => {
    for (let i = 0; i < 150 && !done(); i++) await Promise.resolve();
    expect(done()).toBe(true);
  };
  const writes = () => request.mock.calls.map(([r]) => r).filter(r => r.method === 'PUT' && r.url.startsWith('/open-apis/cardkit/'));
  const sends = () => request.mock.calls.map(([r]) => r).filter(r => r.url.endsWith('/reply') || r.url === '/open-apis/im/v1/messages');
  const lastCard = (id: string) => JSON.parse(writes().filter(r => r.url.endsWith('/' + id)).at(-1)?.data.card.data ?? '{}');
  const sendMarker = (kind = 'progress') => appendFileSync(journal(), JSON.stringify({ turnId: 'om_turn', messageId: 'om_progress', responseKind: kind, cotDelivery: { deliveredAtMs: Date.now() } }) + '\n');

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    ds = { larkAppId: 'app', chatId: 'oc_chat', scope: 'thread', currentTurnId: 'om_turn',
      session: { sessionId: 'activity-test', rootMessageId: 'om_root', status: 'active' } };
    nextId = 0;
    mkdirSync(join(config.session.dataDir, 'turn-sends'), { recursive: true });
    writeFileSync(journal(), '');
    rmSync(directory(), { recursive: true, force: true });
    vi.mocked(getBot).mockReturnValue({ config: { cotEnabled: true, cotDisplay: 'activity' } } as any);
    request.mockReset().mockImplementation(async r => {
      if (r.method === 'POST' && r.url === '/open-apis/cardkit/v1/cards') return { code: 0, data: { card_id: `card${++nextId}` } };
      if (r.method === 'POST' && r.url.endsWith('/reply')) return { code: 0, data: { message_id: `om_card${nextId}` } };
      return { code: 0, data: {} };
    });
  });
  afterEach(async () => {
    abortCotMessage(ds);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(request.mock.calls.some(([r]) => r.method === 'DELETE')).toBe(false);
    vi.clearAllTimers(); vi.useRealTimers();
  });

  it('moves full displayed history to the newest card and grays the old one', async () => {
    update('first');
    await drain(() => JSON.stringify(lastCard('card1')).includes('first'));
    sendMarker(); await vi.advanceTimersByTimeAsync(2_000);
    await drain(() => JSON.stringify(lastCard('card1')).includes("color='grey'"));
    expect(sends()).toHaveLength(2);
    expect(sends()[0].data.reply_in_thread).toBe(true);
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("<font color='grey'>");
    expect(JSON.stringify(lastCard('card2'))).toContain('first');
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' }] });
    await drain(() => JSON.stringify(lastCard('card2')).includes('second'));
    expect(JSON.stringify(lastCard('card1'))).not.toContain('second');
    expect(JSON.stringify(lastCard('card2'))).toContain('first');
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await drain(() => !existsSync(join(directory(), 'card-card2.json')));
    expect(sends()).toHaveLength(2);
    expect(lastCard('card2').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it.each(['final', 'new-turn'])('does not publish an in-flight entity after %s', async cause => {
    const normal = request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    request.mockImplementation(async r => r.url === '/open-apis/cardkit/v1/cards'
      ? new Promise(resolve => { release = resolve; }) : normal(r));
    update('late');
    await drain(() => !!release);
    if (cause === 'final') sendMarker('final'); else ds.currentTurnId = 'om_next';
    release({ code: 0, data: { card_id: 'card1' } });
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(sends()).toHaveLength(0);
  });

  it('restores a gray history card after restart with a newer sequence', async () => {
    update('saved history');
    await drain(() => JSON.stringify(lastCard('card1')).includes('saved history'));
    const path = join(directory(), 'card-card1.json');
    await drain(() => readFileSync(path, 'utf8').includes('saved history'));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    abortCotMessage(ds);
    await drain(() => !existsSync(path));
    writeFileSync(path, JSON.stringify(saved));
    const maxSequence = saved.activityCard.sequence;
    await sweepOrphanCotMessages('app');
    expect(existsSync(path)).toBe(false);
    expect(writes().at(-1).data.sequence).toBeGreaterThan(maxSequence);
    expect(JSON.stringify(lastCard('card1'))).toContain('saved history');
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it('serializes shutdown and updates without restoring a working title', async () => {
    update('history');
    await drain(() => JSON.stringify(lastCard('card1')).includes('history'));
    await settleCotMessageForShutdown(ds);
    const sequences = writes().map(r => r.data.sequence);
    expect(sequences.every((n, i) => i === 0 || n > sequences[i - 1])).toBe(true);
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it('retains pending history for recovery when a card update response fails', async () => {
    update('initial');
    await drain(() => JSON.stringify(lastCard('card1')).includes('initial'));
    const path = join(directory(), 'card-card1.json');
    await drain(() => readFileSync(path, 'utf8').includes('initial'));
    const normal = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async r => r.method === 'PUT' && fail ? { code: 999 } : normal(r));
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'text', text: 'initial' }, { kind: 'text', text: 'last saved step' }] });
    await drain(() => readFileSync(path, 'utf8').includes('last saved step'));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(saved.activityCard.pendingEvents).toBeDefined();
    fail = false;
    await sweepOrphanCotMessages('app');
    expect(JSON.stringify(lastCard('card1'))).toContain('last saved step');
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it('does not reactivate a card after a failed retirement request', async () => {
    const ref = { cardId: 'standalone', messageId: 'om_test', sequence: 0, events: eventHistory, retired: false };
    request.mockResolvedValueOnce({ code: 999 });
    await expect(updateActivityCard('app', ref, [], true, false, () => {})).rejects.toThrow();
    await updateActivityCard('app', ref, [ev('REASONING_MESSAGE_CONTENT', { delta: 'late' })], false, false, () => {});
    expect(lastCard('standalone').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it('respects hidden tool results after a migration', async () => {
    vi.mocked(getBot).mockReturnValue({ config: { cotEnabled: true, cotDisplay: 'activity', thinkingCardToolResult: false } } as any);
    const entries: any[] = [{ kind: 'tool_call', id: 't1', name: 'Bash', args: '{}'}, { kind: 'tool_result', id: 't1', result: 'DO_NOT_EXPOSE' }];
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries });
    await drain(() => sends().length === 1);
    vi.mocked(getBot).mockReturnValue({ config: { cotEnabled: true, cotDisplay: 'activity', thinkingCardToolResult: true } } as any);
    sendMarker(); await vi.advanceTimersByTimeAsync(2_000);
    await drain(() => sends().length === 2 && writes().some(r => r.url.endsWith('/card2')));
    expect(JSON.stringify(lastCard('card2'))).not.toContain('DO_NOT_EXPOSE');
  });

  it('never sends updates after checkpoint storage becomes unavailable', async () => {
    update('a');
    await drain(() => sends().length === 1);
    await drain(() => existsSync(join(directory(), 'card-card1.json')));
    const before = writes().length;
    rmSync(directory(), { recursive: true, force: true });
    writeFileSync(directory(), 'unwritable marker directory');
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] });
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(writes()).toHaveLength(before);
    finalizeCotMessage(ds, 'om_turn', 'completed');
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(writes()).toHaveLength(before);
    rmSync(directory());
  });

  it('recovers the known entity after a lost publish response without publishing again', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async r => {
      if (r.url.endsWith('/reply')) {
        expect(existsSync(join(directory(), 'card-card1.json'))).toBe(true);
        expect(r.data.uuid).toMatch(/^[a-f0-9-]{36}$/);
        throw new Error('response lost after accepted');
      }
      return normal(r);
    });
    update('history before publication');
    await drain(() => sends().length === 1);
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const marker = JSON.parse(readFileSync(join(directory(), 'card-card1.json'), 'utf8'));
    expect(marker.activityCard.cardId).toBe('card1');
    expect(JSON.stringify(marker.activityCard.events)).toContain('history before publication');
    await sweepOrphanCotMessages('app');
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
    expect(sends()).toHaveLength(1);
  });

  it('keeps over-limit history available by paging and can retire every page', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async r => {
      const serialized = r.data?.card?.data ?? (r.url === '/open-apis/cardkit/v1/cards' ? r.data?.data : undefined);
      if (serialized) expect(Buffer.byteLength(JSON.stringify(r.data))).toBeLessThanOrEqual(30_000);
      return normal(r);
    });
    const text = 'begin ' + 'abc'.repeat(20_000) + ' FINAL_RECORD';
    update(text); await drain(() => sends().length === 1);
    await drain(() => JSON.parse(readFileSync(join(directory(), 'card-card1.json'), 'utf8')).messageId === 'om_card1');
    const panel = lastCard('card1').body.elements[0];
    const total = Number(panel.elements[0].content.match(/1\/(\d+)/)[1]);
    expect(total).toBeGreaterThan(1);
    await showActivityPage('app', 'om_card1', 'oc_chat', 'card1', total - 1, false);
    expect(JSON.stringify(lastCard('card1'))).toContain('FINAL&#95;RECORD');
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await drain(() => !existsSync(join(directory(), 'card-card1.json')));
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
    await expect(showActivityPage('app', 'om_other', 'oc_chat', 'card1', 0, false)).rejects.toThrow('identity');
    await expect(showActivityPage('app', 'om_card1', 'oc_other', 'card1', 0, false)).rejects.toThrow('identity');
  });

  it('does not repeatedly increase sequence to overwrite unrecognized remote state', async () => {
    update('safe'); await drain(() => sends().length === 1);
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async r => r.method === 'PUT' ? { code: 300317 } : normal(r));
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'text', text: 'safe' }, { kind: 'text', text: 'new' }] });
    await drain(() => writes().length === 2);
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const count = writes().length;
    await sweepOrphanCotMessages('app');
    await sweepOrphanCotMessages('app');
    expect(writes()).toHaveLength(count);
  });
});
