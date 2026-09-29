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
import { activitySummary, buildActivityCard, updateActivityCard, showActivityPage, handleActivityPageAction, type ActivityEvent } from '../src/im/lark/cot-activity-card.js';
import { handleCotThinkingUpdate, finalizeCotMessage, abortCotMessage, sweepOrphanCotMessages, settleCotMessageForShutdown } from '../src/im/lark/cot-message.js';

const isOneLineHistory = (card: any): boolean => {
  const element = card.body.elements[0];
  const row = element.tag === 'interactive_container' ? element.elements[0] : element;
  return card.body.padding === '0px' && row.tag === 'div' && row.text.tag === 'plain_text'
    && row.text.lines === 1 && row.text.text_color === 'grey';
};

const ev = (event_type: string, data: unknown): ActivityEvent => ({ event_type, content: JSON.stringify(data), timestamp: 100 });
const eventHistory = [ev('REASONING_MESSAGE_CONTENT', { delta: 'Inspect access controls.' }),
  ev('TOOL_CALL_START', { toolCallName: 'Read', title: '读取文件 · a.ts' }),
  ev('TOOL_CALL_START', { toolCallName: 'Bash', title: '执行命令 · bun test' }),
  ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'code', code: 'All tests passed.' }) })];

describe('activity card presentation', () => {
  it('uses a gray concrete action summary without implying task completion', () => {
    const card = JSON.parse(buildActivityCard(eventHistory, true));
    expect(isOneLineHistory(card)).toBe(true);
    expect(card.body.elements[0].text.content).toBe('本段记录：读取文件 1 次，运行命令 1 次');
    expect(card.body.elements).toHaveLength(1);
    expect(JSON.stringify(card)).not.toMatch(/任务已完成|Completed|done_outlined/);
    const expanded = buildActivityCard(eventHistory, true, false, { cardId: 'history', expanded: true });
    expect(expanded).toContain('Inspect access controls&#46;');
    expect(expanded).toContain('All tests passed&#46;');
  });

  it.each([
    [false, '正在处理中，我会继续运行下一步。', '本段活动记录'],
    [true, 'Processing and working on the next step', 'Activity record'],
  ] as const)('never reuses ongoing or future narrative as a finished summary (english=%s)', (english, narrative, summary) => {
    const events = [ev('REASONING_MESSAGE_CONTENT', { delta: narrative })];
    const collapsed = JSON.parse(buildActivityCard(events, true, english, { cardId: 'history' }));
    expect(collapsed.body.elements[0].elements[0].text.content).toBe(`› ${summary}`);
    expect(collapsed.config.summary.content).toBe(summary);
    expect(JSON.stringify(collapsed)).not.toContain(narrative);

    const expanded = JSON.parse(buildActivityCard(events, true, english, { cardId: 'history', expanded: true }));
    expect(expanded.body.elements[0].header.title.content).toBe(`<font color='grey'>${summary}</font>`);
    expect(expanded.config.summary.content).toBe(summary);
    expect(expanded.body.elements[0].elements[1].content).toBe(narrative);
    const live = JSON.parse(buildActivityCard(events, false, english));
    expect(live.config.summary.content).toBe(narrative);
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
    const card = buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: raw })], true, false, { cardId: 'escaped', expanded: true });
    const detail = JSON.parse(card).body.elements[0].elements[1].content;
    expect(detail).toContain('&#60;at');
    expect(detail).not.toContain('<at');
    expect(detail).not.toContain('[secret]');
  });

  it('keeps long histories complete without exceeding the component limit', () => {
    const text = '活动记录'.repeat(15_000);
    const card = JSON.parse(buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: text })], true, false, { cardId: 'pages', expanded: true }));
    expect(Buffer.byteLength(JSON.stringify({ card: { type: 'card_json', data: JSON.stringify(card) }, sequence: 2147483647 }))).toBeLessThanOrEqual(30000);
    let rebuilt = '';
    const total = Number(card.body.elements[0].elements[0].content.match(/1\/(\d+)/)[1]);
    for (let page = 0; page < total; page++) {
      const next = JSON.parse(buildActivityCard([ev('REASONING_MESSAGE_CONTENT', { delta: text })], true, false, { cardId: 'pages', page, expanded: true }));
      rebuilt += next.body.elements[0].elements[1].content;
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(30000);
    }
    expect(rebuilt).toBe(text);
  });

  it('does not show a completion label for redacted tool results', () => {
    const card = buildActivityCard([ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'text', text: '✓ 已完成' }) })], true);
    expect(card).not.toContain('已完成');
    expect(activitySummary([], true)).toBe('Activity record');
    const empty = JSON.parse(buildActivityCard([], true, false, { cardId: 'empty', expanded: true }));
    expect(empty.body.elements[0].elements[1].content).toBe('本段无可展示的活动内容。');
    expect(JSON.stringify(empty)).not.toMatch(/等待|正在/);
    const live = JSON.parse(buildActivityCard([eventHistory[2], ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'text', text: '✓ 已完成' }) })], false));
    expect(live.body.elements[0].header.title.content).toBe('正在处理…');
  });

  it('renders raw tables and other block syntax as literal text', () => {
    const text = '| a | b |\n|---|---|\n|1|2|\n\n'.repeat(5) + '---\n- list\n1. item\n:DONE:\n    indented';
    const card = JSON.parse(buildActivityCard([ev('TOOL_CALL_RESULT', { content: JSON.stringify({ type: 'code', code: text }) })], true, false, { cardId: 'literal', expanded: true }));
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
    await drain(() => isOneLineHistory(lastCard('card1')));
    expect(sends()).toHaveLength(2);
    expect(sends()[0].data.reply_in_thread).toBe(true);
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
    expect(JSON.stringify(lastCard('card2'))).toContain('first');
    handleCotThinkingUpdate(ds, { type: 'thinking_update', turnId: 'om_turn', entries: [{ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' }] });
    await drain(() => JSON.stringify(lastCard('card2')).includes('second'));
    expect(JSON.stringify(lastCard('card1'))).not.toContain('second');
    expect(JSON.stringify(lastCard('card2'))).toContain('first');
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await drain(() => !existsSync(join(directory(), 'card-card2.json')));
    expect(sends()).toHaveLength(2);
    expect(isOneLineHistory(lastCard('card2'))).toBe(true);
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
    await drain(() => JSON.parse(readFileSync(path, 'utf8')).activityCard.messageId === 'om_card1');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    abortCotMessage(ds);
    await drain(() => !existsSync(path));
    writeFileSync(path, JSON.stringify(saved));
    const maxSequence = saved.activityCard.sequence;
    await sweepOrphanCotMessages('app');
    expect(existsSync(path)).toBe(false);
    expect(writes().at(-1).data.sequence).toBeGreaterThan(maxSequence);
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
    await showActivityPage('app', 'om_card1', 'oc_chat', 'card1', 0, false);
    expect(JSON.stringify(lastCard('card1'))).toContain('saved history');
  });

  it('serializes shutdown and updates without restoring a working title', async () => {
    update('history');
    await drain(() => JSON.stringify(lastCard('card1')).includes('history'));
    await settleCotMessageForShutdown(ds);
    const sequences = writes().map(r => r.data.sequence);
    expect(sequences.every((n, i) => i === 0 || n > sequences[i - 1])).toBe(true);
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
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
    await showActivityPage('app', 'om_card1', 'oc_chat', 'card1', 0, false);
    expect(JSON.stringify(lastCard('card1'))).toContain('last saved step');
    expect(lastCard('card1').body.elements[0].header.title.content).toContain("color='grey'");
  });

  it('does not reactivate a card after a failed retirement request', async () => {
    const ref = { cardId: 'standalone', messageId: 'om_test', sequence: 0, events: eventHistory, retired: false };
    request.mockResolvedValueOnce({ code: 999 });
    await expect(updateActivityCard('app', ref, [], true, false, () => {})).rejects.toThrow();
    await updateActivityCard('app', ref, [ev('REASONING_MESSAGE_CONTENT', { delta: 'late' })], false, false, () => {});
    expect(isOneLineHistory(lastCard('standalone'))).toBe(true);
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
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
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
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
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

  it('returns an afterAck publisher without updating the card during the callback', async () => {
    update('history');
    await drain(() => existsSync(join(directory(), 'card-card1.json'))
      && JSON.parse(readFileSync(join(directory(), 'card-card1.json'), 'utf8')).messageId === 'om_card1');
    const before = writes().length;
    const response = await handleActivityPageAction('app', 'om_card1', 'oc_chat', 'card1', 0, false);
    expect(response).toEqual({ afterAck: expect.any(Function) });
    expect(writes()).toHaveLength(before);
    await response.afterAck();
    expect(writes()).toHaveLength(before + 1);
  });

  it('retired cards occupy one text line and expand only after an explicit click', async () => {
    update('Full detail '.repeat(100));
    await drain(() => existsSync(join(directory(), 'card-card1.json'))
      && JSON.parse(readFileSync(join(directory(), 'card-card1.json'), 'utf8')).messageId === 'om_card1');
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await drain(() => !existsSync(join(directory(), 'card-card1.json')));
    const compact = lastCard('card1');
    expect(isOneLineHistory(compact)).toBe(true);
    expect(compact.body.elements[0]).toMatchObject({ height: '20px', padding: '0px', margin: '0px', has_border: false });
    expect(compact.body.elements[0].elements).toHaveLength(1);
    expect(JSON.stringify(compact)).not.toContain('collapsible_panel');
    expect(JSON.stringify(compact)).not.toContain('本轮完整活动记录');

    const expand = await handleActivityPageAction('app', 'om_card1', 'oc_chat', 'card1', 0, false, true);
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
    await expand.afterAck();
    expect(lastCard('card1').body.elements[0].expanded).toBe(true);
    expect(lastCard('card1').body.elements[0].elements[1].content).toBe('Full detail '.repeat(100));
    const collapse = await handleActivityPageAction('app', 'om_card1', 'oc_chat', 'card1', 0, false, false);
    await collapse.afterAck();
    expect(isOneLineHistory(lastCard('card1'))).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  it('repairs a lost message binding only after verifying provider ownership and entity mapping', async () => {
    const normal = request.getMockImplementation()!;
    let mapping = 'other-card';
    request.mockImplementation(async r => {
      if (r.url.endsWith('/reply')) throw new Error('response lost after accepted');
      if (r.method === 'GET') return { code: 0, data: { items: [{ message_id: 'om_card1', chat_id: 'oc_chat', sender: { id: 'app', sender_type: 'app' }, deleted: false }] } };
      if (r.url.endsWith('/id_convert')) return { code: 0, data: { card_id: mapping } };
      return normal(r);
    });
    update('a'.repeat(40_000) + ' LAST PAGE');
    await drain(() => sends().length === 1);
    for (let i = 0; i < 80; i++) await Promise.resolve();
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await drain(() => !existsSync(join(directory(), 'card-card1.json')));
    const beforeVerify = request.mock.calls.length;
    const ack = await handleActivityPageAction('app', 'om_card1', 'oc_chat', 'card1', 999, false);
    expect(request.mock.calls).toHaveLength(beforeVerify);
    await expect(ack.afterAck()).rejects.toThrow('mapping');
    await expect(showActivityPage('app', 'om_card1', 'oc_chat', 'card1', 999, false)).rejects.toThrow('mapping');
    mapping = 'card1';
    await showActivityPage('app', 'om_card1', 'oc_chat', 'card1', 999, false);
    const saved = JSON.parse(readFileSync(join(config.session.dataDir, 'cot-activity/app/card1.json'), 'utf8'));
    expect(saved.messageId).toBe('om_card1');
    expect(JSON.stringify(lastCard('card1'))).toContain('LAST PAGE');
    expect(sends()).toHaveLength(1);
  });

  it('serializes startup recovery with paging on the same entity', async () => {
    mkdirSync(directory(), { recursive: true });
    mkdirSync(join(config.session.dataDir, 'cot-activity/app'), { recursive: true });
    for (const cardId of ['recovery1', 'recovery2']) {
      const ref = { appId: 'app', chatId: 'oc_chat', cardId, messageId: `om_${cardId}`, sequence: 5, events: eventHistory, retired: false };
      writeFileSync(join(directory(), `card-${cardId}.json`), JSON.stringify({ larkAppId: 'app', cotId: `card-${cardId}`, messageId: ref.messageId, activityCard: ref }));
      writeFileSync(join(config.session.dataDir, `cot-activity/app/${cardId}.json`), JSON.stringify(ref));
    }
    // Directory enumeration order differs between Bun and Node. Block the
    // first card the real sweep will encounter, then page the other one.
    const [firstId, secondId] = readdirSync(directory()).map(name =>
      JSON.parse(readFileSync(join(directory(), name), 'utf8')).activityCard.cardId as string);
    const normal = request.getMockImplementation()!;
    let releaseFirst!: (value: unknown) => void;
    let releasePage!: (value: unknown) => void;
    request.mockImplementation(async r => {
      if (r.method === 'PUT' && r.url.endsWith('/' + firstId)) return new Promise(resolve => { releaseFirst = resolve; });
      if (r.method === 'PUT' && r.url.endsWith('/' + secondId) && r.data.sequence === 6) return new Promise(resolve => { releasePage = resolve; });
      return normal(r);
    });
    const recovery = sweepOrphanCotMessages('app');
    await drain(() => !!releaseFirst);
    const page = showActivityPage('app', `om_${secondId}`, 'oc_chat', secondId, 0, false);
    await drain(() => !!releasePage);
    releaseFirst({ code: 0, data: {} });
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(writes().filter(r => r.url.endsWith('/' + secondId)).map(r => r.data.sequence)).toEqual([6]);
    releasePage({ code: 0, data: {} });
    await Promise.all([page, recovery]);
    expect(writes().filter(r => r.url.endsWith('/' + secondId)).map(r => r.data.sequence)).toEqual([6, 7]);
    const saved = JSON.parse(readFileSync(join(config.session.dataDir, `cot-activity/app/${secondId}.json`), 'utf8'));
    expect(saved).toMatchObject({ sequence: 7, retired: true });
    expect(saved.sequenceConflict).not.toBe(true);
  });

  it.each([5, 6])('merges a newer orphan snapshot with reserved sequence %s into the canonical entity', async sequence => {
    const cardId = `newer-orphan-${sequence}`;
    const events = [ev('REASONING_MESSAGE_CONTENT', { delta: 'a' })];
    const ref = { appId: 'app', chatId: 'oc_chat', cardId, messageId: `om_${cardId}`, sequence: 5, events, retired: false };
    mkdirSync(directory(), { recursive: true });
    mkdirSync(join(config.session.dataDir, 'cot-activity/app'), { recursive: true });
    writeFileSync(join(config.session.dataDir, `cot-activity/app/${cardId}.json`), JSON.stringify(ref));
    const orphan = { ...ref, sequence, pendingEvents: [...events, ev('REASONING_MESSAGE_CONTENT', { delta: 'b' })], pendingRetired: true };
    const marker = join(directory(), `card-${cardId}.json`);
    writeFileSync(marker, JSON.stringify({ larkAppId: 'app', cotId: `card-${cardId}`, messageId: ref.messageId, activityCard: orphan }));
    await sweepOrphanCotMessages('app');
    const published = writes().find(r => r.url.endsWith('/' + cardId));
    expect(published.data.sequence).toBe(sequence + 1);
    expect(isOneLineHistory(JSON.parse(published.data.card.data))).toBe(true);
    await showActivityPage('app', ref.messageId, 'oc_chat', cardId, 0, false);
    const detail = lastCard(cardId).body.elements[0].elements[1].content;
    expect(detail).toBe('a\n\nb');
    expect(existsSync(marker)).toBe(false);
    const saved = JSON.parse(readFileSync(join(config.session.dataDir, `cot-activity/app/${cardId}.json`), 'utf8'));
    expect(saved).toMatchObject({ sequence: sequence + 2, retired: true, events: orphan.pendingEvents });
  });

  it('loads orphan content before page writes can overtake startup recovery', async () => {
    mkdirSync(directory(), { recursive: true });
    mkdirSync(join(config.session.dataDir, 'cot-activity/app'), { recursive: true });
    const events = [ev('REASONING_MESSAGE_CONTENT', { delta: 'a'.repeat(5000) })];
    for (const cardId of ['page-first1', 'page-first2']) {
      const ref = { appId: 'app', chatId: 'oc_chat', cardId, messageId: `om_${cardId}`, sequence: 5, events, retired: false };
      writeFileSync(join(directory(), `card-${cardId}.json`), JSON.stringify({ larkAppId: 'app', cotId: `card-${cardId}`, messageId: ref.messageId, activityCard: ref }));
      writeFileSync(join(config.session.dataDir, `cot-activity/app/${cardId}.json`), JSON.stringify(ref));
    }
    const [firstId, targetId] = readdirSync(directory()).map(name => JSON.parse(readFileSync(join(directory(), name), 'utf8')).activityCard.cardId as string);
    const targetMarker = join(directory(), `card-${targetId}.json`);
    const target = JSON.parse(readFileSync(targetMarker, 'utf8'));
    target.activityCard.sequence = 6;
    target.activityCard.pendingEvents = [...events, ev('REASONING_MESSAGE_CONTENT', { delta: 'B_PENDING' })];
    writeFileSync(targetMarker, JSON.stringify(target));
    const normal = request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    request.mockImplementation(async r => r.method === 'PUT' && r.url.endsWith('/' + firstId)
      ? new Promise(resolve => { release = resolve; }) : normal(r));
    const recovery = sweepOrphanCotMessages('app');
    await drain(() => !!release);
    await showActivityPage('app', `om_${targetId}`, 'oc_chat', targetId, 1, false);
    await showActivityPage('app', `om_${targetId}`, 'oc_chat', targetId, 0, false);
    const beforeRecovery = JSON.parse(readFileSync(join(config.session.dataDir, `cot-activity/app/${targetId}.json`), 'utf8'));
    expect(beforeRecovery.events).toEqual(target.activityCard.pendingEvents);
    release({ code: 0, data: {} });
    await recovery;
    expect(writes().filter(r => r.url.endsWith('/' + targetId)).map(r => r.data.sequence)).toEqual([7, 8, 9]);
    const saved = JSON.parse(readFileSync(join(config.session.dataDir, `cot-activity/app/${targetId}.json`), 'utf8'));
    expect(saved.events).toEqual(target.activityCard.pendingEvents);
    expect(saved.retired).toBe(true);
    expect(existsSync(targetMarker)).toBe(false);
  });

  it('keeps conflicting recovery histories for investigation without a remote overwrite', async () => {
    const cardId = 'conflicting';
    const canonical = { appId: 'app', chatId: 'oc_chat', cardId, messageId: 'om_conflicting', sequence: 4,
      events: [ev('REASONING_MESSAGE_CONTENT', { delta: 'canonical' })], retired: false };
    mkdirSync(directory(), { recursive: true });
    mkdirSync(join(config.session.dataDir, 'cot-activity/app'), { recursive: true });
    writeFileSync(join(config.session.dataDir, `cot-activity/app/${cardId}.json`), JSON.stringify(canonical));
    const damaged = { ...canonical, sequence: 7, pendingEvents: [ev('REASONING_MESSAGE_CONTENT', { delta: 'other history' })] };
    const marker = join(directory(), `card-${cardId}.json`);
    writeFileSync(marker, JSON.stringify({ larkAppId: 'app', cotId: `card-${cardId}`, messageId: canonical.messageId, activityCard: damaged }));
    const before = writes().length;
    await expect(showActivityPage('app', canonical.messageId, 'oc_chat', cardId, 0, false)).rejects.toThrow('diverged');
    await sweepOrphanCotMessages('app');
    expect(writes()).toHaveLength(before);
    expect(existsSync(marker)).toBe(true);
  });
});
