// A fake Linear for the OAuth app (guided onboarding PR 7): the consent page's approval, the token endpoint (authorization_code with PKCE S256, refresh_token with ROTATION and
// the 30-minute retry window of the previous refresh token), revoke, and the GraphQL reads Rovara makes (the workspace, the teams). No real Linear address is ever called:
// everything goes through the `fetch` seam. Tokens and secrets are built at run time (public push protection refuses key-shaped literals).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import type { LinearSealer } from "../../packages/broker/src/aws/linear-connections.js";

export const LINEAR_CLIENT_ID = "lin_client_0123456789";
export const LINEAR_CLIENT_SECRET = ["lin", "client", "secret", "canary"].join("-");
export const LINEAR_WEBHOOK_SECRET = ["lin", "webhook", "secret", "canary"].join("-");
export const LINEAR_REDIRECT = "https://app.rovara.example/api/connect/linear/callback";
export const LINEAR_APP = { clientId: LINEAR_CLIENT_ID, clientSecret: LINEAR_CLIENT_SECRET, webhookSecret: LINEAR_WEBHOOK_SECRET, redirectUri: LINEAR_REDIRECT };

export interface FakeWorkspace { id: string; name: string; urlKey: string; teams: Array<{ id: string; key: string; name: string }> }
export const WORKSPACE_A: FakeWorkspace = { id: "aaaa1111-0000-4000-8000-00000000000a", name: "Acme Linear", urlKey: "acme", teams: [{ id: "team-a-eng", key: "ENG", name: "Engineering" }, { id: "team-a-ops", key: "OPS", name: "Ops" }] };
export const WORKSPACE_B: FakeWorkspace = { id: "bbbb2222-0000-4000-8000-00000000000b", name: "Beta Linear", urlKey: "beta", teams: [{ id: "team-b-web", key: "WEB", name: "Web" }] };
export const WORKSPACE_C: FakeWorkspace = { id: "cccc3333-0000-4000-8000-00000000000c", name: "Gamma Linear", urlKey: "gamma", teams: [{ id: "team-c-x", key: "GX", name: "Gamma" }] };

const WINDOW_MS = 30 * 60_000;

interface Grant { workspace: FakeWorkspace; current: string; previous?: { token: string; until: number }; access: Set<string>; revoked: boolean }

export function fakeLinear(now: () => number) {
  let counter = 0;
  const mint = (kind: string) => [kind, "tok", String(++counter).padStart(4, "0"), randomBytes(6).toString("hex")].join("_");
  const approvals = new Map<string, { workspace: FakeWorkspace; challenge: string; used: boolean }>();
  const grants: Grant[] = [];
  const accessOf = new Map<string, Grant>();
  const revoked: string[] = [];
  const requests: Array<{ url: string; body: string; authorization: string }> = [];
  let refreshCalls = 0;
  const apiKeys = new Map<string, FakeWorkspace>();
  const issues = new Map<string, { id: string; identifier: string; title: string; description: string; labels: string[] }>();
  const comments: Array<{ workspace: string; authorization: string; id: string; issueId: string; body: string }> = [];
  let refreshGate: Promise<void> | undefined;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const issue = (grant: Grant) => {
    const access = mint("access"); grant.access.add(access); accessOf.set(access, grant);
    return { access_token: access, refresh_token: grant.current, token_type: "Bearer", expires_in: 86_400, scope: "read,comments:create,issues:create" };
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ url, body, authorization });
    if (init?.redirect !== "error") return json({ error: "redirects must be refused" }, 500);
    if (url === "https://api.linear.app/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== LINEAR_CLIENT_ID || form.get("client_secret") !== LINEAR_CLIENT_SECRET) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        const approval = approvals.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (approval === undefined || approval.used || form.get("redirect_uri") !== LINEAR_REDIRECT || createHash("sha256").update(verifier).digest("base64url") !== approval.challenge) return json({ error: "invalid_grant" }, 400);
        approval.used = true;
        const grant: Grant = { workspace: approval.workspace, current: mint("refresh"), access: new Set(), revoked: false };
        grants.push(grant);
        return json(issue(grant));
      }
      if (form.get("grant_type") === "refresh_token") {
        refreshCalls++;
        const token = form.get("refresh_token") ?? "";
        const grant = grants.find((g) => !g.revoked && (g.current === token || (g.previous?.token === token && now() < g.previous.until)));
        // Linear rotates when the request ARRIVES; a held answer (holdRefreshes) only reaches the caller late, as a slow network would deliver it.
        const gate = refreshGate; refreshGate = undefined;
        if (grant === undefined) { if (gate !== undefined) await gate; return json({ error: "invalid_grant" }, 400); }
        grant.previous = { token, until: now() + WINDOW_MS };
        grant.current = mint("refresh");
        const answer = issue(grant);
        if (gate !== undefined) await gate;
        return json(answer);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url === "https://api.linear.app/oauth/revoke") {
      const token = new URLSearchParams(body).get("token") ?? "";
      revoked.push(token);
      const grant = accessOf.get(token) ?? grants.find((g) => g.current === token);
      if (grant !== undefined) grant.revoked = true;
      return new Response("", { status: 200 });
    }
    if (url === "https://api.linear.app/graphql") {
      // An OAuth access token is sent as `Bearer <token>`; a per-project API key (PR 20's golden path) as the bare key.
      const keyWorkspace = apiKeys.get(authorization);
      const token = authorization.replace(/^Bearer /, "");
      const grant = authorization.startsWith("Bearer ") ? accessOf.get(token) : undefined;
      if (keyWorkspace === undefined && (grant === undefined || grant.revoked)) return json({ errors: [{ message: "Authentication required" }] }, 401);
      const workspace = keyWorkspace ?? grant!.workspace;
      const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      // PR 20: the tracker's reads and comment writes, each only within the caller's own workspace.
      if (query.includes("issue(id: $id)")) {
        const found = issues.get(`${workspace.id}:${String(variables["id"])}`);
        if (found === undefined) return json({ errors: [{ message: "Entity not found: Issue", extensions: { code: "NOT_FOUND" } }] });
        return json({ data: { issue: { id: found.id, identifier: found.identifier, title: found.title, description: found.description, url: `https://linear.app/${workspace.urlKey}/issue/${found.identifier}/x`,
          updatedAt: "2026-11-17T10:00:00.000Z", state: { type: "unstarted", name: "Todo" }, labels: { nodes: found.labels.map((name) => ({ name })) }, team: { states: { nodes: [] } } } } });
      }
      if (query.includes("commentCreate")) {
        const input = variables["input"] as { id: string; issueId: string; body: string };
        comments.push({ workspace: workspace.id, authorization, ...input });
        return json({ data: { commentCreate: { success: true } } });
      }
      if (keyWorkspace !== undefined) return json({ errors: [{ message: "unknown query" }] });
      if (query.includes("viewer { organization")) return json({ data: { viewer: { organization: { id: grant!.workspace.id, name: grant!.workspace.name, urlKey: grant!.workspace.urlKey } } } });
      if (query.includes("teams(")) return json({ data: { teams: { nodes: grant!.workspace.teams, pageInfo: { hasNextPage: false } } } });
      return json({ errors: [{ message: "unknown query" }] });
    }
    return json({ error: "not linear" }, 404);
  });
  return {
    fetch, requests, revoked, grants, comments,
    /** A per-project Linear API key for `workspace` (the path PR 20's goldens compare with). */
    apiKeyFor(workspace: FakeWorkspace): string { const key = ["lin", "api", String(++counter), randomBytes(6).toString("hex")].join("_"); apiKeys.set(key, workspace); return key; },
    /** An issue in `workspace`, readable by its key (`ENG-1`) or its id. */
    addIssue(workspace: FakeWorkspace, issue: { id: string; identifier: string; title: string; description?: string; labels?: string[] }) {
      const full = { description: "", labels: [], ...issue };
      issues.set(`${workspace.id}:${issue.identifier}`, full); issues.set(`${workspace.id}:${issue.id}`, full);
    },
    /** The person approves on Linear's consent page for `workspace`: the code Linear would send back, bound to the authorize address's PKCE challenge. */
    approve(authorizeUrl: string, workspace: FakeWorkspace): string {
      const challenge = new URL(authorizeUrl).searchParams.get("code_challenge") ?? "";
      const code = `code${String(++counter)}${randomBytes(4).toString("hex")}`;
      approvals.set(code, { workspace, challenge, used: false });
      return code;
    },
    get refreshCalls() { return refreshCalls; },
    /** The NEXT refresh's answer is held until the returned function is called (the rotation itself happens at once). */
    holdNextRefresh() { let release!: () => void; refreshGate = new Promise((resolve) => { release = resolve; }); return () => release(); },
    /** Whether Linear would accept `refresh` for a refresh after the retry window (the one long-lived refresh token of a grant). */
    isCurrentRefresh(refresh: string) { return grants.some((g) => !g.revoked && g.current === refresh); },
    validAccess(access: string) { const g = accessOf.get(access); return g !== undefined && !g.revoked; },
    revokeGrantOf(workspace: FakeWorkspace) { for (const g of grants) if (g.workspace === workspace) g.revoked = true; },
  };
}

/** A real AES-GCM sealer with the encryption context as additional data: a value sealed for one company, workspace or field does not open for another. */
export function testSealer(): LinearSealer & { opened: Array<Record<string, string>> } {
  const key = randomBytes(32);
  const aad = (context: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));
  const opened: Array<Record<string, string>> = [];
  return {
    opened,
    async seal(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(context));
      const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
    },
    async open(sealed, context) {
      opened.push(context);
      const raw = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); decipher.setAAD(aad(context)); decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
