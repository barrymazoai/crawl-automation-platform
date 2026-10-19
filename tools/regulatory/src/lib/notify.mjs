// Card to the crawler Feishu group bot (owner 2026-10-19: Server 一 sends it
// directly). Same card as the crawler's other notifications: a coloured header
// and a markdown body. The webhook URL lives in a private file on the server
// and is never logged; without one, nothing is sent.
import { readFile } from 'node:fs/promises';

export async function feishuNotifier(file, { log }) {
  let url = null;
  if (file) {
    try {
      url = (await readFile(file, 'utf8')).trim() || null;
    } catch (error) {
      log.warn({ file, err: error.message }, 'webhook file not readable; no notifications');
    }
  }
  return {
    enabled: Boolean(url),
    async send({ title, markdown, color }) {
      if (!url) return { sent: false, reason: 'no webhook' };
      const card = {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: title }, template: color },
        body: { elements: [{ tag: 'markdown', content: markdown.trim() || '(空)' }] },
      };
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msg_type: 'interactive', card }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json().catch(() => ({}));
        // Feishu answers 200 with a non-zero code for a refused message.
        const code = body.code ?? body.StatusCode ?? (response.ok ? 0 : response.status);
        if (code !== 0) {
          log.error({ status: response.status, code, msg: body.msg ?? body.StatusMessage }, 'notification refused');
          return { sent: false, reason: `code ${code} ${body.msg ?? ''}`.trim() };
        }
        return { sent: true };
      } catch (error) {
        log.error({ err: error.message }, 'notification failed');
        return { sent: false, reason: error.message };
      }
    },
  };
}
