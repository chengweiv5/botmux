import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface CotDelivery {
  messageId: string;
  deliveredAtMs: number;
  final: boolean;
}

/** Incremental reader of the session's existing send journal. Only completed
 * in-session deliveries explicitly marked by cmdSend can move the bubble.
 * Journal message ids are only dedupe keys, never mutation targets. */
export class CotSendObserver {
  private offset = 0;
  private inode = '';
  private tail = '';
  private seen = new Set<string>();
  /** False means this read only scanned a prefix (or an incomplete last row).
   * Callers must not interpret an empty batch as proof no final was sent. */
  caughtUp = false;

  constructor(private path: string, private turnId: string, private dispatchAttempt?: number) {}

  read(): CotDelivery[] {
    let fd: number | undefined;
    this.caughtUp = false;
    try {
      fd = openSync(this.path, 'r');
      const stat = fstatSync(fd);
      const inode = `${stat.dev}:${stat.ino}`;
      if (this.inode !== inode || stat.size < this.offset) {
        this.offset = 0;
        this.tail = '';
        this.inode = inode;
      }
      if (stat.size === this.offset) {
        this.caughtUp = this.tail.length === 0;
        return [];
      }
      // A marker contains at most a bounded preview; do not let a corrupted
      // journal allocate arbitrary memory or pin a daemon event loop.
      const length = Math.min(stat.size - this.offset, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, this.offset);
      this.offset += count;
      const lines = (this.tail + buffer.toString('utf8', 0, count)).split('\n');
      this.tail = lines.pop() ?? '';
      if (this.tail.length > 32_768) this.tail = '';
      this.caughtUp = this.offset >= stat.size && this.tail.length === 0;
      const result: CotDelivery[] = [];
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          const deliveredAtMs = row.cotFinal === true && row.responseKind === 'final'
            ? row.sentAtMs : row.cotDelivery?.deliveredAtMs;
          if (row.turnId !== this.turnId || row.dispatchAttempt !== this.dispatchAttempt
            || typeof row.messageId !== 'string' || !row.messageId.startsWith('om_')
            || typeof deliveredAtMs !== 'number' || !Number.isFinite(deliveredAtMs)
            || !['progress', 'final', 'auxiliary'].includes(row.responseKind)) continue;
          const key = `${row.messageId}:${row.responseKind}`;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          result.push({ messageId: row.messageId, deliveredAtMs, final: row.responseKind === 'final' });
        } catch { /* partial/corrupt/legacy row */ }
      }
      return result;
    } catch (error) {
      this.caughtUp = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return [];
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
