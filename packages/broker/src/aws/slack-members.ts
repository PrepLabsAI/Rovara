const MEMBER_TTL_MS = 60 * 60 * 1_000;
const LOOKUP_TIMEOUT_MS = 1_500;

/** Whether a Slack user is a person. A failed lookup is never treated as a person (spec 014 FR-008). */
export type SlackMemberCheck =
  | { outcome: "person" }
  | { outcome: "not_person" }
  | { outcome: "failed"; error: string };

/**
 * Checks with Slack users.info (bot scope users:read) whether a user is a person. Bot users,
 * Slackbot, deactivated users and profiles without an explicit `is_bot: false` are not people.
 * `is_app_user` marks a person who authorized the calling app, so it is deliberately not read.
 * Answers are kept for an hour; failures are never kept, so the next event asks again.
 */
export function createSlackMemberCheck(options: {
  token: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}): (userId: string) => Promise<SlackMemberCheck> {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { check: SlackMemberCheck; at: number }>();
  return async (userId) => {
    const cached = cache.get(userId);
    if (cached && now() - cached.at < MEMBER_TTL_MS) return cached.check;
    let body: { ok?: unknown; error?: unknown; user?: { id?: unknown; is_bot?: unknown; deleted?: unknown } };
    try {
      const response = await fetchFn(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${await options.token()}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      body = await response.json() as typeof body;
    } catch (error) {
      return { outcome: "failed", error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed" };
    }
    if (body.ok !== true || !body.user || body.user.id !== userId) {
      return { outcome: "failed", error: typeof body.error === "string" ? body.error : "unexpected_response" };
    }
    const person = body.user.is_bot === false && body.user.deleted !== true && userId !== "USLACKBOT";
    const check: SlackMemberCheck = person ? { outcome: "person" } : { outcome: "not_person" };
    cache.set(userId, { check, at: now() });
    return check;
  };
}
