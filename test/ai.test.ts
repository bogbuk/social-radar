import { describe, it, expect, vi } from 'vitest';
import { extractText, judge } from '../src/ai';

const msgs = { system: 'S', user: 'U' };
const good = '{"relevant": 8, "reason": "r", "draft": "d"}';

describe('extractText', () => {
  it('handles Llama-style {response}', () => expect(extractText({ response: 'hi' })).toBe('hi'));
  it('handles Responses API output array (gpt-oss)', () => {
    const raw = { output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] };
    expect(extractText(raw)).toBe('hello');
  });
  it('handles chat-completions shape {choices[0].message.content} (what gpt-oss returns for {messages})', () => {
    const raw = { choices: [{ finish_reason: 'stop', message: { content: '{"relevant":9}', reasoning: 'We need to decide...' } }] };
    expect(extractText(raw)).toBe('{"relevant":9}');
    expect(extractText({ choices: [{ message: { content: null, reasoning: 'cut off' } }] })).toBe('');
  });
  it('handles output_text and plain string, else empty', () => {
    expect(extractText({ output_text: 'x' })).toBe('x');
    expect(extractText('s')).toBe('s');
    expect(extractText({})).toBe('');
    expect(extractText(null)).toBe('');
  });
});

describe('judge', () => {
  it('passes system+user messages to the model and returns the verdict', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: good }) };
    const v = await judge(ai, '@cf/x', msgs, () => {});
    expect(v).toEqual({ relevant: 8, reason: 'r', draft: 'd' });
    expect(ai.run).toHaveBeenCalledWith('@cf/x', {
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
      max_tokens: 1500,
      reasoning: { effort: 'low' },
    });
  });
  it('retries once on unparseable output, then succeeds', async () => {
    const ai = { run: vi.fn().mockResolvedValueOnce({ response: 'garbage' }).mockResolvedValueOnce({ response: good }) };
    expect(await judge(ai, 'm', msgs, () => {})).not.toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(2);
  });
  it('retries once on thrown error, returns null after two failures', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('quota')) };
    const log = vi.fn();
    expect(await judge(ai, 'm', msgs, log)).toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
  });
});
