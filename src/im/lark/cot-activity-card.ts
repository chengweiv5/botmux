import { getBotClient } from '../../bot-registry.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { stampBotmuxCallbackMarkers } from './callback-button-marker.js';

/** Public, already-redacted activity events. Never accepts private reasoning
 * or re-reads raw tool results when rebuilding a historical card. */
export interface ActivityEvent { event_type: string; content: string; timestamp: number }
export interface ActivityCardRef {
  cardId: string;
  messageId: string;
  sequence: number;
  events: ActivityEvent[];
  pendingEvents?: ActivityEvent[];
  pendingRetired?: boolean;
  retired: boolean;
  appId?: string;
  chatId?: string;
  publishUuid?: string;
  page?: number;
  sequenceConflict?: boolean;
}

const liveRefs = new Map<string, ActivityCardRef>();
const writers = new Map<string, Promise<void>>();
function identity(appId: string, cardId: string): string {
  return `${config.session.dataDir}:${appId}:${cardId}`;
}
function canonicalRef(appId: string, candidate: ActivityCardRef): ActivityCardRef {
  const key = identity(appId, candidate.cardId);
  const existing = liveRefs.get(key);
  if (existing) return existing;
  candidate.appId = appId;
  liveRefs.set(key, candidate);
  return candidate;
}

/** Merge recovery checkpoints only while holding the entity writer. The
 * orphan journal is committed before the browsable record, so it can carry a
 * newer reserved sequence and pending history after a crash between writes. */
function mergeRecoverySnapshot(ref: ActivityCardRef, candidate: ActivityCardRef): void {
  if (ref === candidate) return;
  if (candidate.cardId !== ref.cardId || candidate.appId !== ref.appId
    || (candidate.chatId && ref.chatId && candidate.chatId !== ref.chatId)
    || (candidate.messageId && ref.messageId && candidate.messageId !== ref.messageId)) {
    throw new Error('Activity recovery identity mismatch');
  }
  const retired = ref.retired || candidate.retired;
  const pendingRetired = ref.pendingRetired === true || candidate.pendingRetired === true;
  const conflict = ref.sequenceConflict === true || candidate.sequenceConflict === true;
  // Sequence orders provider requests, including page changes; it does NOT
  // order content revisions. Only an append-only prefix proves one snapshot
  // contains the other. Never drop a longer pending history behind a page's
  // higher sequence, or guess between conflicting branches of content.
  const currentEvents = ref.pendingEvents ?? ref.events;
  const candidateEvents = candidate.pendingEvents ?? candidate.events;
  const common = Math.min(currentEvents.length, candidateEvents.length);
  for (let i = 0; i < common; i++) {
    const a = currentEvents[i], b = candidateEvents[i];
    if (a.event_type !== b.event_type || a.content !== b.content || a.timestamp !== b.timestamp) {
      throw new Error('Activity recovery history diverged');
    }
  }
  if (candidateEvents.length > currentEvents.length) ref.pendingEvents = candidateEvents;
  if (candidate.sequence > ref.sequence) ref.page = candidate.page;
  ref.sequence = Math.max(ref.sequence, candidate.sequence);
  ref.messageId ||= candidate.messageId;
  ref.chatId ??= candidate.chatId;
  ref.publishUuid ??= candidate.publishUuid;
  ref.retired = retired;
  if (pendingRetired) ref.pendingRetired = true;
  if (conflict) ref.sequenceConflict = true;
}

/** Read all durable sources before EVERY writer, including an early click
 * while startup recovery is blocked on another card. Missing files are normal;
 * unreadable/corrupt checkpoints cannot authorize overwriting remote history. */
function mergeDurableSnapshots(appId: string, ref: ActivityCardRef): void {
  const read = (path: string): unknown => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const durable = read(recordPath(ref)) as ActivityCardRef | undefined;
  if (durable) mergeRecoverySnapshot(ref, durable);
  const orphan = read(join(config.session.dataDir, 'cot-orphans', `card-${ref.cardId}.json`)) as
    { larkAppId?: string; activityCard?: ActivityCardRef } | undefined;
  if (orphan) {
    if (orphan.larkAppId !== appId || !orphan.activityCard) throw new Error('Activity orphan identity mismatch');
    mergeRecoverySnapshot(ref, orphan.activityCard);
  }
}
function recordPath(ref: Pick<ActivityCardRef, 'appId' | 'cardId'>): string {
  if (!ref.appId || !/^[A-Za-z0-9_-]+$/.test(ref.appId) || !/^[A-Za-z0-9_-]+$/.test(ref.cardId)) throw new Error('Invalid activity identity');
  return join(config.session.dataDir, 'cot-activity', ref.appId, `${ref.cardId}.json`);
}
export function persistActivityCard(ref: ActivityCardRef): void {
  if (!ref.appId) return;
  const key = identity(ref.appId, ref.cardId);
  const existing = liveRefs.get(key);
  if (existing && existing !== ref) throw new Error('Activity card must use its canonical entity');
  const path = recordPath(ref);
  mkdirSync(join(config.session.dataDir, 'cot-activity', ref.appId), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(ref), { mode: 0o600, followTargetSymlink: false });
  liveRefs.set(key, ref);
  // Active records keep their exact writer object; finished records can be
  // read from disk after eviction without retaining every turn in memory.
  if (liveRefs.size > 128) for (const [key, value] of liveRefs) {
    if (value.retired && !writers.has(key)) liveRefs.delete(key);
    if (liveRefs.size <= 128) break;
  }
}

type ActivityItem = { kind: 'text' | 'tool' | 'result'; text: string; toolName?: string };

export function readActivityCard(appId: string, cardId: string): ActivityCardRef | undefined {
  const existing = liveRefs.get(identity(appId, cardId));
  if (existing) return existing;
  try {
    const ref = JSON.parse(readFileSync(recordPath({ appId, cardId }), 'utf8')) as ActivityCardRef;
    return ref.appId === appId && ref.cardId === cardId ? canonicalRef(appId, ref) : undefined;
  } catch { return undefined; }
}

function itemsFrom(events: readonly ActivityEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const event of events) {
    let value;
    try { value = JSON.parse(event.content); } catch { continue; }
    if (event.event_type === 'REASONING_MESSAGE_CONTENT' && typeof value.delta === 'string') {
      items.push({ kind: 'text', text: value.delta });
    } else if (event.event_type === 'TOOL_CALL_START') {
      items.push({ kind: 'tool', text: String(value.title ?? value.toolCallName ?? ''), toolName: String(value.toolCallName ?? '') });
    } else if (event.event_type === 'TOOL_CALL_RESULT') {
      try {
        const result = JSON.parse(value.content);
        // Hidden/empty results are completion metadata, not an extra "Done"
        // label. Their original contents never enter the event history.
        items.push({ kind: 'result', text: result.type === 'code' && typeof result.code === 'string' ? result.code : '' });
      } catch { /* malformed display result */ }
    }
  }
  return items;
}

function plain(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/[<>*\[\]`_~#\\|\-+:!.()]/g, ch => `&#${ch.charCodeAt(0)};`)
    .replace(/\t/g, '&#160;'.repeat(4)).replace(/ {2,}/g, spaces => '&#160;'.repeat(spaces.length));
}

/** The header describes observed operations, never the overall task outcome. */
export function activitySummary(events: readonly ActivityEvent[], english = false): string {
  const counts = { read: 0, write: 0, command: 0, search: 0, other: 0 };
  const items = itemsFrom(events);
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const name = item.toolName!.toLowerCase();
    if (/bash|shell|command|(^|[^a-z])exec([^a-z]|$)/.test(name)) counts.command++;
    else if (/write|edit|patch/.test(name)) counts.write++;
    else if (/read|notebook/.test(name)) counts.read++;
    else if (/grep|glob|search|fetch/.test(name)) counts.search++;
    else counts.other++;
  }
  const labels = english
    ? { read: 'file reads', write: 'file edits', command: 'command calls', search: 'searches', other: 'tool calls' }
    : { read: '读取文件', write: '编辑文件', command: '执行命令', search: '搜索', other: '调用工具' };
  const summary = (Object.keys(counts) as Array<keyof typeof counts>).filter(key => counts[key])
    .map(key => english ? `${counts[key]} ${labels[key]}` : `${labels[key]} ${counts[key]} 次`).join(english ? ', ' : '，');
  if (summary) return summary;
  const text = items.find(item => item.kind === 'text' && item.text.trim())?.text.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 100) + (text.length > 100 ? '…' : '') : english ? 'Activity record' : '活动记录';
}

export function buildActivityCard(events: readonly ActivityEvent[], retired: boolean, english = false,
  navigation?: { cardId: string; page?: number }): string {
  const items = itemsFrom(events);
  const last = items.at(-1);
  const summary = activitySummary(events, english);
  const lastText = last?.kind === 'text' ? last.text.replace(/\s+/g, ' ').trim() : '';
  const live = last?.kind === 'tool'
    ? `${english ? 'In progress: ' : '正在'}${last.text.replace(/\s+/g, ' ').slice(0, 150)}…`
    : lastText ? lastText.slice(0, 150) + (lastText.length > 150 ? '…' : '')
      : english ? 'Processing…' : '正在处理…';
  // Split on code-point boundaries BEFORE escaping. Budget the doubly encoded
  // wire text so CJK, entities, quotes and newlines cannot exceed 30 KB.
  const raw = (items.filter(item => item.text).map(item => item.text).join('\n\n')
    || (english ? 'Waiting for activity updates.' : '等待活动更新。'))
    .replace(/\t/g, '\u00a0'.repeat(4)).replace(/ {2,}/g, spaces => '\u00a0'.repeat(spaces.length));
  const pages: string[] = [];
  let chunk = '', bytes = 0;
  for (const char of raw) {
    const encoded = plain(char);
    const cost = Buffer.byteLength(JSON.stringify(JSON.stringify(encoded)), 'utf8');
    if (bytes + cost > 20_000 && chunk) { pages.push(chunk); chunk = ''; bytes = 0; }
    chunk += encoded; bytes += cost;
  }
  pages.push(chunk);
  const page = Math.min(Math.max(0, navigation?.page ?? 0), pages.length - 1);
  const detail = pages[page];
  const title = retired ? `<font color='grey'>${plain(summary)}</font>` : plain(live);
  const pageButtons = pages.length > 1 && navigation ? [{ tag: 'column_set', columns: [
    { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: english ? 'Previous' : '上一页' }, disabled: page === 0,
      behaviors: [{ type: 'callback', value: { action: 'get_cot_activity_page', card_id: navigation.cardId, page: page - 1 } }] }] },
    { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: english ? 'Next' : '下一页' }, disabled: page === pages.length - 1,
      behaviors: [{ type: 'callback', value: { action: 'get_cot_activity_page', card_id: navigation.cardId, page: page + 1 } }] }] },
  ] }] : [];
  const card = stampBotmuxCallbackMarkers(JSON.stringify({ schema: '2.0', config: { update_multi: true, width_mode: 'default', summary: { content: retired ? summary : live } },
    body: { padding: '4px 8px 4px 8px', elements: [{
      tag: 'collapsible_panel', expanded: false, padding: '0px',
      header: { title: { tag: 'markdown', content: title },
        icon: { tag: 'standard_icon', token: 'down_outlined', color: retired ? 'grey' : 'blue', size: '16px 16px' },
        icon_position: 'follow_text', icon_expanded_angle: -180 },
      elements: [{ tag: 'markdown', content: `<font color='grey'>${english ? 'Full activity record for this turn' : '本轮完整活动记录'}${pages.length > 1 ? ` · ${page + 1}/${pages.length}` : ''}</font>` },
        { tag: 'markdown', content: detail }, ...pageButtons],
    }] } }));
  if (Buffer.byteLength(JSON.stringify({ card: { type: 'card_json', data: card }, sequence: 2147483647 }), 'utf8') > 30_000) {
    throw new Error('Activity card exceeds byte budget');
  }
  return card;
}

async function request(appId: string, options: Record<string, unknown>): Promise<any> {
  const response = await getBotClient(appId).request({ ...options, timeout: 15_000 } as any);
  if (response?.code !== 0) throw Object.assign(new Error(`Activity card request failed: ${response?.code}`), { code: response?.code });
  return response.data;
}

export async function createActivityCard(
  appId: string, chatId: string, placement: { origin_message_id?: string; reply_in_thread?: boolean },
  english: boolean, canPublish: () => boolean,
  onEntity: (ref: ActivityCardRef) => void = () => {}, initialEvents: readonly ActivityEvent[] = [],
): Promise<ActivityCardRef | undefined> {
  const data = await request(appId, { method: 'POST', url: '/open-apis/cardkit/v1/cards',
    data: { type: 'card_json', data: buildActivityCard(initialEvents, false, english) } });
  if (typeof data?.card_id !== 'string' || !data.card_id) throw new Error('Activity card missing card_id');
  const ref: ActivityCardRef = { cardId: data.card_id, messageId: '', sequence: 0, events: [...initialEvents], retired: false,
    appId, chatId, publishUuid: randomUUID() };
  // A newly-created provider entity owns a new identity. Register it before
  // publication so every update, callback and recovery uses this same object.
  liveRefs.set(identity(appId, ref.cardId), ref);
  onEntity(ref); // must durably save identity + history before visible publication
  persistActivityCard(ref);
  // Install paging controls once the entity id is known, before publication.
  await updateActivityCard(appId, ref, [], false, english, () => onEntity(ref));
  // Entity creation is invisible. A terminal/superseding input received during
  // it must not publish a late empty card below the answer or next turn.
  if (!canPublish()) {
    await updateActivityCard(appId, ref, [], true, english, () => onEntity(ref));
    return undefined;
  }
  const reply = !!placement.origin_message_id;
  const sent = await request(appId, {
    method: 'POST', url: reply ? `/open-apis/im/v1/messages/${encodeURIComponent(placement.origin_message_id!)}/reply` : '/open-apis/im/v1/messages',
    ...(!reply ? { params: { receive_id_type: 'chat_id' } } : {}),
    data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: data.card_id } }), uuid: ref.publishUuid,
      ...(reply ? { reply_in_thread: placement.reply_in_thread === true } : { receive_id: chatId }) },
  });
  if (typeof sent?.message_id !== 'string' || !sent.message_id) throw new Error('Activity card missing message_id');
  ref.messageId = sent.message_id;
  onEntity(ref);
  persistActivityCard(ref);
  return ref;
}

export async function updateActivityCard(
  appId: string, ref: ActivityCardRef, events: readonly ActivityEvent[], retired: boolean, english: boolean,
  checkpoint: (ref: ActivityCardRef) => void, selectedPage?: number,
): Promise<void> {
  const candidate = ref;
  ref = canonicalRef(appId, ref);
  const key = identity(appId, ref.cardId);
  const previous = writers.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    mergeRecoverySnapshot(ref, candidate);
    mergeDurableSnapshots(appId, ref);
    if (ref.sequenceConflict) throw new Error('Activity card sequence conflicts with remote state');
    if (selectedPage !== undefined) ref.page = selectedPage;
    const next = [...(ref.pendingEvents ?? ref.events), ...events];
    const terminal = ref.retired || ref.pendingRetired === true || retired || next.some(e => e.event_type === 'RUN_FINISHED');
    // Reserve before the network call. Recovery must use a newer sequence even
    // when the server accepted an update but the response was lost.
    ref.sequence++;
    ref.pendingEvents = next;
    ref.pendingRetired = terminal;
    checkpoint(ref);
    persistActivityCard(ref);
    try {
      await request(appId, { method: 'PUT', url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(ref.cardId)}`,
        data: { card: { type: 'card_json', data: buildActivityCard(next, terminal, english, { cardId: ref.cardId, page: ref.page }) }, sequence: ref.sequence } });
    } catch (error) {
      if (((error as { code?: number }).code ?? (error as { response?: { data?: { code?: number } } }).response?.data?.code) === 300317) {
        ref.sequenceConflict = true;
        checkpoint(ref); persistActivityCard(ref);
      }
      throw error;
    }
    ref.events = next;
    ref.pendingEvents = undefined;
    ref.pendingRetired = undefined;
    ref.retired = terminal;
    checkpoint(ref);
    persistActivityCard(ref);
  });
  writers.set(key, work);
  try { await work; } finally { if (writers.get(key) === work) writers.delete(key); }
}

/** Read-only paging: the callback may only address its own published card in
 * the same app/chat. It never dispatches an agent or forwards transcript text. */
export async function showActivityPage(appId: string, messageId: string, chatId: string, cardId: string, page: number, english: boolean): Promise<void> {
  const ref = await validateActivityPage(appId, messageId, chatId, cardId, page);
  await updateActivityCard(appId, ref, [], ref.retired, english, persistActivityCard, page);
}

async function validateActivityPage(appId: string, messageId: string, chatId: string, cardId: string, page: number): Promise<ActivityCardRef> {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid activity page');
  const ref = readActivityCard(appId, cardId);
  if (!ref || ref.appId !== appId || ref.cardId !== cardId || !messageId || !chatId || ref.chatId !== chatId) {
    throw new Error('Activity card identity mismatch');
  }
  if (!ref.messageId) {
    // A trusted click supplies the visible message, but never trust its
    // client-controlled value.card_id. Verify both ownership/chat and the
    // provider's message -> entity mapping before repairing a lost response.
    const message = await request(appId, { method: 'GET', url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` });
    const item = message?.items?.find((item: any) => item.message_id === messageId);
    if (item?.chat_id !== chatId || item?.sender?.id !== appId || item?.sender?.sender_type !== 'app' || item?.deleted) {
      throw new Error('Activity card message ownership mismatch');
    }
    const mapped = await request(appId, { method: 'POST', url: '/open-apis/cardkit/v1/cards/id_convert', data: { message_id: messageId } });
    if (mapped?.card_id !== cardId) throw new Error('Activity card mapping mismatch');
    // No await between recheck and the durable binding. Concurrent clicks
    // must agree on the same provider-confirmed message.
    if (ref.messageId && ref.messageId !== messageId) throw new Error('Activity card identity mismatch');
    ref.messageId = messageId;
    persistActivityCard(ref);
  }
  if (ref.messageId !== messageId) throw new Error('Activity card identity mismatch');
  return ref;
}

export async function handleActivityPageAction(appId: string, messageId: string, chatId: string, cardId: string, page: number, english: boolean) {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid activity page');
  const ref = readActivityCard(appId, cardId);
  if (!ref || ref.appId !== appId || ref.cardId !== cardId || !messageId || !chatId || ref.chatId !== chatId
    || (ref.messageId && ref.messageId !== messageId)) throw new Error('Activity card identity mismatch');
  // The dispatcher recognizes this envelope as an empty ACK and executes the
  // fresh publisher afterward. Missing-message verification also runs after
  // ACK: it can require two provider reads. No remote write precedes proof.
  return { afterAck: () => showActivityPage(appId, messageId, chatId, cardId, page, english) };
}
