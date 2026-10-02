import { Agent, fetch as fetchWithDispatcher } from "undici";

/** Independent control connection: no OCR upload socket, dispatcher, or cancelled upload signal. */
export async function jobControlFetch(request: Request): Promise<Response> {
  const dispatcher = new Agent({ connections: 1, pipelining: 0 });
  try {
    const response = await fetchWithDispatcher(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      redirect: request.redirect,
      cache: request.cache,
      signal: request.signal,
      dispatcher,
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
  } finally {
    await dispatcher.destroy();
  }
}
