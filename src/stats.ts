import type { KVLike } from './seen';
import type { TickResult } from './tick';

// Итог последнего тика: крон-события не видны в `wrangler tail`, а Workers Logs хранятся ограниченно —
// одна KV-запись даёт проверку состояния одним запросом к /health.
export const STATS_KEY = 'stats:last';

export interface TickStats extends TickResult {
  at: number; // мс UTC, старт тика
  durationMs: number;
}

export async function saveStats(kv: KVLike, stats: TickStats): Promise<void> {
  await kv.put(STATS_KEY, JSON.stringify(stats));
}

export async function loadStats(kv: KVLike): Promise<TickStats | null> {
  const raw = await kv.get(STATS_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && typeof o.at === 'number' ? (o as TickStats) : null;
  } catch {
    return null;
  }
}
