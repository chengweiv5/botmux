import { getBotClient } from '../../bot-registry.js';

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
}

type ActivityItem = { kind: 'text' | 'tool' | 'result'; text: string; toolName?: string };

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
  return text.replace(/&/g, '&amp;').replace(/[<>*\[\]`_~#\\]/g, ch => `&#${ch.charCodeAt(0)};`);
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

export function buildActivityCard(events: readonly ActivityEvent[], retired: boolean, english = false): string {
  const items = itemsFrom(events);
  const last = items.at(-1);
  const summary = activitySummary(events, english);
  const lastText = last?.kind === 'text' ? last.text.replace(/\s+/g, ' ').trim() : '';
  const live = last?.kind === 'tool'
    ? `${english ? 'In progress: ' : '正在'}${last.text.replace(/\s+/g, ' ').slice(0, 150)}…`
    : lastText ? lastText.slice(0, 150) + (lastText.length > 150 ? '…' : '')
      : english ? 'Processing…' : '正在处理…';
  // One Markdown detail element avoids the 200-component limit. Escape source
  // text, including <at> and links, so transcript data cannot notify people.
  const detail = items.filter(item => item.text).map(item => item.kind === 'tool' ? `**${plain(item.text)}**` : plain(item.text)).join('\n\n')
    || (english ? 'Waiting for activity updates.' : '等待活动更新。');
  const title = retired ? `<font color='grey'>${plain(summary)}</font>` : plain(live);
  return JSON.stringify({ schema: '2.0', config: { update_multi: true, width_mode: 'default', summary: { content: retired ? summary : live } },
    body: { padding: '4px 8px 4px 8px', elements: [{
      tag: 'collapsible_panel', expanded: false, padding: '0px',
      header: { title: { tag: 'markdown', content: title },
        icon: { tag: 'standard_icon', token: 'down_outlined', color: retired ? 'grey' : 'blue', size: '16px 16px' },
        icon_position: 'follow_text', icon_expanded_angle: -180 },
      elements: [{ tag: 'markdown', content: `<font color='grey'>${english ? 'Full activity record for this turn' : '本轮完整活动记录'}</font>` },
        { tag: 'markdown', content: detail }],
    }] } });
}

async function request(appId: string, options: Record<string, unknown>): Promise<any> {
  const response = await getBotClient(appId).request({ ...options, timeout: 15_000 } as any);
  if (response?.code !== 0) throw new Error(`Activity card request failed: ${response?.code}`);
  return response.data;
}

export async function createActivityCard(
  appId: string, chatId: string, placement: { origin_message_id?: string; reply_in_thread?: boolean },
  english: boolean, canPublish: () => boolean,
): Promise<ActivityCardRef | undefined> {
  const data = await request(appId, { method: 'POST', url: '/open-apis/cardkit/v1/cards',
    data: { type: 'card_json', data: buildActivityCard([], false, english) } });
  if (typeof data?.card_id !== 'string' || !data.card_id) throw new Error('Activity card missing card_id');
  // Entity creation is invisible. A terminal/superseding input received during
  // it must not publish a late empty card below the answer or next turn.
  if (!canPublish()) return undefined;
  const reply = !!placement.origin_message_id;
  const sent = await request(appId, {
    method: 'POST', url: reply ? `/open-apis/im/v1/messages/${encodeURIComponent(placement.origin_message_id!)}/reply` : '/open-apis/im/v1/messages',
    ...(!reply ? { params: { receive_id_type: 'chat_id' } } : {}),
    data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: data.card_id } }),
      ...(reply ? { reply_in_thread: placement.reply_in_thread === true } : { receive_id: chatId }) },
  });
  if (typeof sent?.message_id !== 'string' || !sent.message_id) throw new Error('Activity card missing message_id');
  return { cardId: data.card_id, messageId: sent.message_id, sequence: 0, events: [], retired: false };
}

const writers = new WeakMap<ActivityCardRef, Promise<void>>();
export async function updateActivityCard(
  appId: string, ref: ActivityCardRef, events: readonly ActivityEvent[], retired: boolean, english: boolean,
  checkpoint: () => void,
): Promise<void> {
  const previous = writers.get(ref) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const next = [...(ref.pendingEvents ?? ref.events), ...events];
    const terminal = ref.retired || ref.pendingRetired === true || retired || next.some(e => e.event_type === 'RUN_FINISHED');
    // Reserve before the network call. Recovery must use a newer sequence even
    // when the server accepted an update but the response was lost.
    ref.sequence++;
    ref.pendingEvents = next;
    ref.pendingRetired = terminal;
    checkpoint();
    await request(appId, { method: 'PUT', url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(ref.cardId)}`,
      data: { card: { type: 'card_json', data: buildActivityCard(next, terminal, english) }, sequence: ref.sequence } });
    ref.events = next;
    ref.pendingEvents = undefined;
    ref.pendingRetired = undefined;
    ref.retired = terminal;
    checkpoint();
  });
  writers.set(ref, work);
  try { await work; } finally { if (writers.get(ref) === work) writers.delete(ref); }
}
