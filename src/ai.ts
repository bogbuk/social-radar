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
  // chat-completions (gpt-oss на {messages}): content — ответ, reasoning — размышления (не берём).
  const choice = Array.isArray(r.choices) ? r.choices[0] : undefined;
  if (typeof choice?.message?.content === 'string') return choice.message.content;
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
  // max_tokens: дефолт 256 обрезал JSON (finish_reason=length); reasoning low — размышления съедали бюджет.
  const input = {
    messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }],
    max_tokens: 1500,
    reasoning: { effort: 'low' },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.run(model, input);
      const text = extractText(raw);
      const verdict = parseVerdict(text);
      if (verdict) return verdict;
      log('ai: unparseable verdict', attempt, text.slice(0, 200), 'raw=', JSON.stringify(raw).slice(0, 600));
    } catch (e) {
      log('ai: run failed', attempt, String(e));
    }
  }
  return null;
}
