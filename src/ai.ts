import type { Verdict } from './types';
import { parseVerdict } from './prompt';

export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

// Биндинг Workers AI отдаёт разные формы: {response} у Llama-подобных, Responses API ({output:[...]}) у gpt-oss.
export function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const r = raw as any;
  if (!r || typeof r !== 'object') return '';
  if (typeof r.response === 'string') return r.response;
  if (Array.isArray(r.output)) {
    for (const item of r.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c?.text === 'string') return c.text;
      }
    }
  }
  if (typeof r.output_text === 'string') return r.output_text;
  return '';
}

export async function judge(
  ai: AiLike,
  model: string,
  msgs: { system: string; user: string },
  log: (...a: unknown[]) => void = console.error,
): Promise<Verdict | null> {
  const input = { messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = extractText(await ai.run(model, input));
      const verdict = parseVerdict(text);
      if (verdict) return verdict;
      log('ai: unparseable verdict', attempt, text.slice(0, 200));
    } catch (e) {
      log('ai: run failed', attempt, String(e));
    }
  }
  return null;
}
