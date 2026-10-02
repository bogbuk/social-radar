import { describe, it, expect, vi } from 'vitest';
import { sendTelegram } from '../src/telegram';

describe('sendTelegram', () => {
  it('posts plain text without preview and returns true on 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    expect(await sendTelegram('TOK', '42', 'hello', fetchFn as any)).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOK/sendMessage');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '42', text: 'hello', disable_web_page_preview: true });
  });
  it('returns false on non-200 and on network error', async () => {
    expect(await sendTelegram('T', '1', 'x', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })) as any)).toBe(false);
    expect(await sendTelegram('T', '1', 'x', vi.fn().mockRejectedValue(new Error('net')) as any)).toBe(false);
  });
});
