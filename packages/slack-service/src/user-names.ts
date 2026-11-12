import { createSlackWebClient } from "./slack-web.js";

const NAME_TTL_MS = 60 * 60 * 1_000;
const FAILURE_TTL_MS = 5 * 60 * 1_000;
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Display names for attribution footers. Needs the optional users:read scope; any failure (missing
 * scope, timeout, network) yields undefined and is retried after five minutes, names after an hour.
 */
export function createSlackUserNames(options: {
  token: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}): (userId: string) => Promise<string | undefined> {
  const slack = createSlackWebClient({ token: options.token, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const now = options.now ?? Date.now;
  const cache = new Map<string, { name: string | undefined; at: number }>();
  return async (userId) => {
    const cached = cache.get(userId);
    if (cached && now() - cached.at < (cached.name === undefined ? FAILURE_TTL_MS : NAME_TTL_MS)) return cached.name;
    let name: string | undefined;
    try {
      const user = await slack.userInfo(userId, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || undefined;
    } catch { name = undefined; }
    cache.set(userId, { name, at: now() });
    return name;
  };
}
