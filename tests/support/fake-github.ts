// DEC 254h: a fake GitHub OAuth app and REST API for sign-in tests (no real GitHub call is ever made). It checks the client credentials, the
// redirect URI and PKCE (S256) exactly as GitHub does, and serves /user and /user/emails for the token it issued.
import { createHash, randomBytes } from "node:crypto";
import { routeFetch } from "./developer-fakes.js";

export const GITHUB_CLIENT_ID = "Ov23liFakeClientId01";
/** Built at runtime, so no key-shaped string sits in the source. */
export const GITHUB_CLIENT_SECRET = ["fake", "github", "client", "secret", "for", "tests"].join("-");
export interface FakeGithubUser { id: number; login: string; name?: string; emails: Array<{ email: string; primary: boolean; verified: boolean }> | "forbidden" }

export function fakeGithub(users: FakeGithubUser[]) {
  const codes = new Map<string, { user: FakeGithubUser; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, FakeGithubUser>();
  const state = { down: false, issued: [] as string[], tokenRequests: [] as Array<Record<string, string>> };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const handler = async (url: URL, init?: RequestInit): Promise<Response | undefined> => {
    if (url.origin !== "https://github.com" && url.origin !== "https://api.github.com") return undefined;
    if (state.down) return json(503, { message: "down" });
    if (url.href === "https://github.com/login/oauth/access_token") {
      const form = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      state.tokenRequests.push(form);
      const headers = new Headers(init?.headers);
      if (init?.method !== "POST" || headers.get("accept") !== "application/json") return json(400, { error: "bad_request" });
      if (form.client_id !== GITHUB_CLIENT_ID || form.client_secret !== GITHUB_CLIENT_SECRET) return json(200, { error: "incorrect_client_credentials" });
      const grant = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      if (grant === undefined || grant.redirectUri !== form.redirect_uri) return json(200, { error: "bad_verification_code" });
      if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== grant.challenge) return json(200, { error: "bad_verification_code" });
      const token = `gho_${randomBytes(18).toString("hex")}`;
      tokens.set(token, grant.user);
      state.issued.push(token);
      return json(200, { access_token: token, token_type: "bearer", scope: "read:user,user:email" });
    }
    const user = tokens.get(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (user === undefined) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user") return json(200, { id: user.id, login: user.login, ...(user.name === undefined ? {} : { name: user.name }) });
    if (url.pathname === "/user/emails") return user.emails === "forbidden" ? json(403, { message: "Resource not accessible" }) : json(200, user.emails);
    return json(404, { message: "Not Found" });
  };
  const fetch = routeFetch(handler);
  return {
    fetch, state, users,
    /** The person approves on GitHub's page: the callback URL GitHub sends the browser to. */
    approve(authorizeUrl: string, login: string): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://github.com/login/oauth/authorize") throw new Error(`test setup: not GitHub's authorize URL: ${authorizeUrl}`);
      const user = users.find((candidate) => candidate.login === login);
      if (user === undefined) throw new Error(`test setup: no GitHub user ${login}`);
      if (url.searchParams.get("client_id") !== GITHUB_CLIENT_ID || url.searchParams.get("code_challenge_method") !== "S256") throw new Error("test setup: bad authorize request");
      const code = randomBytes(10).toString("hex");
      const redirectUri = url.searchParams.get("redirect_uri")!;
      codes.set(code, { user, challenge: url.searchParams.get("code_challenge")!, redirectUri });
      return `${redirectUri}?${new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString()}`;
    },
  };
}
