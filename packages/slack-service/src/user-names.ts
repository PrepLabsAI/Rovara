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
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { name: string | undefined; at: number }>();
  return async (userId) => {
    const cached = cache.get(userId);
    if (cached && now() - cached.at < (cached.name === undefined ? FAILURE_TTL_MS : NAME_TTL_MS)) return cached.name;
    let name: string | undefined;
    try {
      const response = await fetchFn(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${await options.token()}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      const body = await response.json() as { ok?: boolean; user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } };
      if (body.ok) name = body.user?.profile?.display_name || body.user?.profile?.real_name || body.user?.real_name || body.user?.name || undefined;
    } catch { name = undefined; }
    cache.set(userId, { name, at: now() });
    return name;
  };
}
