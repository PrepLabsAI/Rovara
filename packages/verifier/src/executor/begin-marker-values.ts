import { E2E_MODEL_CHANNEL_MAX_COOKIE_VALUES, E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES, boundSessionValue } from "@agentx/contracts";

/**
 * The session values a begin marker carries (the newest ones; the session sync carries all of them before the first call anyway). Each is bounded the way the sync bounds it
 * (`boundSessionValue`: a value over 4096 characters is its head and its tail), because the marker schema refuses a value over 4096 characters and a refused marker would end every
 * agent step of the app. The list is also kept within the marker's count and well within its byte limit, newest first kept.
 */
export function beginMarkerSessionValues(values: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const value of [...values].reverse()) {
    for (const form of boundSessionValue(value).reverse()) {
      const size = Buffer.byteLength(JSON.stringify(form), "utf8") + 1;
      if (kept.length >= E2E_MODEL_CHANNEL_MAX_COOKIE_VALUES || bytes + size > E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES) return kept.reverse();
      kept.push(form);
      bytes += size;
    }
  }
  return kept.reverse();
}
