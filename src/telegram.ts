export async function sendTelegram(token: string, chatId: string, text: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('telegram', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error('telegram', String(e));
    return false;
  }
}
