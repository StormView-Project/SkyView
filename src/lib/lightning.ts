import type { LightningStrike } from './types';

/**
 * Live lightning from the Blitzortung.org community network (a public
 * WebSocket used by their own map). Data is free for non-commercial use with
 * attribution, which the map shows.
 *
 * Messages are JSON compressed with a small LZW variant; `decode` undoes it.
 * Only connected while the lightning layer is on and the tab is visible.
 */
const HOSTS = ['ws1', 'ws8', 'ws2', 'ws5', 'ws6', 'ws7'];
export const KEEP_MS = 15 * 60_000;
const MAX_STRIKES = 8000;
const FLUSH_MS = 500;

/** Blitzortung's LZW decoding (the inverse of their server-side packer). */
function decode(data: string): string {
  const dict = new Map<number, string>();
  const chars = [...data];
  let cur = chars[0] ?? '';
  let prev = cur;
  const out = [cur];
  let code = 256;
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i].codePointAt(0)!;
    const entry = c < 256 ? chars[i] : dict.get(c) ?? prev + cur;
    out.push(entry);
    cur = entry[0];
    dict.set(code++, prev + cur);
    prev = entry;
  }
  return out.join('');
}

type Listener = (strikes: LightningStrike[]) => void;

class LightningFeed {
  private strikes: LightningStrike[] = [];
  private ws: WebSocket | null = null;
  private host = 0;
  private wanted = false;
  private retry = 0;
  private retryTimer: number | undefined;
  private flushTimer: number | undefined;
  private dirty = false;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.recent());
    return () => this.listeners.delete(fn);
  }

  /** Strikes from the last 15 minutes, oldest first. */
  recent() {
    const cutoff = Date.now() - KEEP_MS;
    let i = 0;
    while (i < this.strikes.length && this.strikes[i].time < cutoff) i++;
    if (i) this.strikes.splice(0, i);
    return this.strikes;
  }

  start() {
    this.wanted = true;
    if (!this.ws && !document.hidden) this.connect();
    document.addEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.flushTimer);
    this.flushTimer = window.setInterval(() => this.flush(), FLUSH_MS);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.flushTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.ws?.close();
    this.ws = null;
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.ws?.close();
      this.ws = null;
    } else if (this.wanted && !this.ws) {
      this.connect();
    }
  };

  private connect() {
    const ws = new WebSocket(`wss://${HOSTS[this.host]}.blitzortung.org/`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send('{"a":111}'); // subscribe to the worldwide stream
    };
    ws.onmessage = (m) => {
      try {
        const s = JSON.parse(decode(String(m.data)));
        if (typeof s.lat !== 'number' || typeof s.lon !== 'number' || typeof s.time !== 'number') return;
        // `time` is nanoseconds since the epoch.
        this.strikes.push({ time: Math.round(s.time / 1e6), lat: s.lat, lon: s.lon });
        if (this.strikes.length > MAX_STRIKES) this.strikes.splice(0, this.strikes.length - MAX_STRIKES);
        this.dirty = true;
      } catch { /* skip malformed message */ }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wanted || document.hidden) return;
      // Next host, backing off up to 30 s.
      this.host = (this.host + 1) % HOSTS.length;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.wanted && !this.ws && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private flush() {
    // Re-emit even without new strikes so old ones fade out as they age.
    const strikes = this.recent();
    if (!this.dirty && !strikes.length) return;
    this.dirty = false;
    for (const l of this.listeners) l(strikes);
  }
}

export const lightning = new LightningFeed();
