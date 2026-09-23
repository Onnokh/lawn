/*
 * Server-side Rybbit events, sent from the Lawn itself.
 *
 * The page script counts visits. What a Mower does on the Lawn goes over the
 * WebSocket and never through a page load, so the Lawn is the one place that
 * sees it happen. It never throws and never rejects: analytics must not be
 * able to touch a Mow Stroke. Callers hand the promise to `waitUntil`.
 *
 * With no API key it does nothing, so `wrangler dev` stays silent unless a
 * `.dev.vars` supplies one.
 */

export interface RybbitEnv {
  RYBBIT_API_URL?: string;
  RYBBIT_SITE_ID?: string;
  /** Secret. Set with `wrangler secret put RYBBIT_API_KEY`, never committed. */
  RYBBIT_API_KEY?: string;
}

export interface RybbitEvent {
  name: string;
  /**
   * The Mower Key. It is hashed before it leaves, because the Key is what
   * opens a Score and must not be written down anywhere but the Lawn.
   */
  key?: string;
  properties?: Record<string, string | number | boolean>;
  /** The visitor's address and browser, so the event places them and not us. */
  ipAddress?: string;
  userAgent?: string;
}

const TIMEOUT_MS = 3_000;

// Rybbit drops agents that do not look like a browser, and the Workers fetch
// default does not. This stands in when the visitor's own agent is unknown.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/** A stable pseudonym for a Mower Key: the same Key, the same user, no Key. */
async function pseudonym(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function trackEvent(env: RybbitEnv, event: RybbitEvent): Promise<void> {
  const { RYBBIT_API_URL: apiUrl, RYBBIT_SITE_ID: siteId, RYBBIT_API_KEY: apiKey } = env;
  if (!apiUrl || !siteId || !apiKey) return;

  try {
    const response = await fetch(`${apiUrl}/api/track`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": event.userAgent || USER_AGENT,
      },
      body: JSON.stringify({
        site_id: siteId,
        type: "custom_event",
        event_name: event.name,
        user_id: event.key ? await pseudonym(event.key) : undefined,
        properties: JSON.stringify(event.properties ?? {}),
        // `undefined` serializes away, and Rybbit then falls back to the
        // address and agent of this request, which are Cloudflare's.
        ip_address: event.ipAddress || undefined,
        user_agent: event.userAgent || undefined,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.debug(`[rybbit] track "${event.name}" failed with ${response.status}`);
  } catch (cause) {
    console.debug(`[rybbit] track "${event.name}" errored`, cause);
  }
}
