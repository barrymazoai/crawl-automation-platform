// Text message to the Feishu group bot the crawler notifications use. The
// webhook URL lives in a private file on the server; without one, nothing is sent.
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
    async send(text) {
      if (!url) return { sent: false, reason: 'no webhook' };
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msg_type: 'text', content: { text } }),
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
