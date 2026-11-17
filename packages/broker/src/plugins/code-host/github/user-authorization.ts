// Guided onboarding PR 1 (design section 3a, DEC 254l item 3): which installations of THIS GitHub App a person controls, proved with a GitHub user
// authorization code. The code is exchanged for a user access token through the App client's own HTTP seam (its fetch), the token is used for three
// reads and then dropped: it is never returned, stored or logged, and no error carries it or anything GitHub said.
//
// "Controls" is stricter than GitHub's "can access" (GET /user/installations lists every installation in which the person can read any repository,
// including through a plain organization membership):
//   - a User account's installation: the person IS that account (same numeric id);
//   - an Organization's installation: the person's own membership of that organization is active and its role is admin (GET /user/memberships/orgs/{org});
//   - an Enterprise (or any other) account: never.
// Every read is bounded (bytes per answer, one page of at most 100 installations, at most MAX_ORGS organizations checked, one total deadline); past a bound
// the whole answer is refused, never a partial list.

export const USER_AUTHORIZATION_LIMITS = { answerBytes: 1_000_000, installations: 100, organizations: 25, requestMs: 5_000, totalMs: 20_000, parallel: 5 } as const;

/** One installation the person controls. */
export interface ControlledInstallation {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  suspended: boolean;
}

export interface UserControlInput {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  /** This App's numeric id: an installation of another App is never controlled here. */
  appId: string;
  code: string;
  now?: () => number;
}

/** The one refusal: no cause, no input, nothing GitHub said. */
export class UserAuthorizationRefused extends Error {
  constructor() { super("GitHub user authorization refused"); this.name = "UserAuthorizationRefused"; }
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const refuse = (): never => { throw new UserAuthorizationRefused(); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : refuse();
const positive = (value: unknown): number => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : refuse();

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader() as { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
  if (reader === undefined) return refuse();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done || part.value === undefined) break;
      bytes += part.value.byteLength;
      if (bytes > USER_AUTHORIZATION_LIMITS.answerBytes) refuse();
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/**
 * The installations of this App the person behind `code` controls, and who they are on GitHub. Throws UserAuthorizationRefused for anything else:
 * a bad or used code, a GitHub failure, an answer that does not read, more than the bounds allow, the deadline passed.
 */
export async function userControlledInstallations(input: UserControlInput): Promise<{ user: { id: number; login: string }; installations: ControlledInstallation[] }> {
  const now = input.now ?? Date.now;
  const started = now();
  const timeLeft = () => { const left = USER_AUTHORIZATION_LIMITS.totalMs - (now() - started); return left > 0 ? Math.min(left, USER_AUTHORIZATION_LIMITS.requestMs) : refuse(); };
  try {
    if (!CODE.test(input.code) || !/^[0-9]{1,20}$/.test(input.appId)) refuse();
    const exchange = await input.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "agentx-control-plane" },
      body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }).toString(),
      signal: AbortSignal.timeout(timeLeft()), redirect: "error",
    });
    if (!exchange.ok) refuse();
    const granted = record(await boundedJson(exchange));
    let token = typeof granted.access_token === "string" && /^[A-Za-z0-9_]{20,255}$/.test(granted.access_token) && granted.error === undefined ? granted.access_token : refuse();
    try {
      const read = async (path: string): Promise<{ status: number; body?: unknown }> => {
        const response = await input.fetch(`https://api.github.com${path}`, {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "agentx-control-plane", "x-github-api-version": "2022-11-28" },
          signal: AbortSignal.timeout(timeLeft()), redirect: "error",
        });
        if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { status: 404 }; }
        if (!response.ok) refuse();
        return { status: response.status, body: await boundedJson(response) };
      };
      const me = record((await read("/user")).body);
      const user = { id: positive(me.id), login: typeof me.login === "string" && GITHUB_LOGIN.test(me.login) ? me.login : refuse() };
      const listed = record((await read(`/user/installations?per_page=${USER_AUTHORIZATION_LIMITS.installations}&page=1`)).body);
      const total = Number.isSafeInteger(listed.total_count) && (listed.total_count as number) >= 0 ? listed.total_count as number : refuse();
      const rows = Array.isArray(listed.installations) ? listed.installations : refuse();
      // One page only: a person who can reach more installations than one page holds is refused whole (never a partial list).
      if (total > USER_AUTHORIZATION_LIMITS.installations || rows.length !== total) refuse();
      const ours: Array<ControlledInstallation & { accountId: number }> = [];
      const seen = new Set<number>();
      for (const value of rows) {
        const row = record(value);
        const installationId = positive(row.id);
        if (seen.has(installationId)) refuse();
        seen.add(installationId);
        if (String(positive(row.app_id)) !== input.appId) continue;
        const account = record(row.account);
        const type = account.type;
        if (type !== "User" && type !== "Organization") continue;
        const login = typeof account.login === "string" && GITHUB_LOGIN.test(account.login) ? account.login : refuse();
        const suspendedAt = row.suspended_at;
        if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== "string") refuse();
        ours.push({ installationId, accountLogin: login, accountType: type, suspended: typeof suspendedAt === "string", accountId: positive(account.id) });
      }
      const organizations = [...new Set(ours.filter((row) => row.accountType === "Organization").map((row) => row.accountLogin.toLowerCase()))];
      if (organizations.length > USER_AUTHORIZATION_LIMITS.organizations) refuse();
      const admin = new Map<string, boolean>();
      for (let index = 0; index < organizations.length; index += USER_AUTHORIZATION_LIMITS.parallel) {
        await Promise.all(organizations.slice(index, index + USER_AUTHORIZATION_LIMITS.parallel).map(async (org) => {
          const membership = await read(`/user/memberships/orgs/${encodeURIComponent(org)}`);
          if (membership.status === 404) { admin.set(org, false); return; }
          const body = record(membership.body);
          admin.set(org, body.state === "active" && body.role === "admin");
        }));
      }
      const installations = ours
        .filter((row) => row.accountType === "User" ? row.accountId === user.id : admin.get(row.accountLogin.toLowerCase()) === true)
        .map(({ installationId, accountLogin, accountType, suspended }) => ({ installationId, accountLogin, accountType, suspended }));
      return { user, installations };
    } finally { token = ""; }
  } catch { throw new UserAuthorizationRefused(); }
}
