// DEC 254p (a): a GitHub person is named (their GitHub name, else their login) and pictured in admin tools the way a Slack person is named.
// The name is untrusted text: cut, no markup. The picture is built from GitHub's numeric id, never from an address someone supplied.
import { describe, expect, it } from "vitest";
import { developerIdForSlackUser, resolveDeveloper, type AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { GITHUB_AVATAR_BASE, githubAvatarUrl, githubDisplayName, profileAvatarUrl, profileDisplayName } from "../../packages/broker/src/developer/github-profile.js";
import { GITHUB_ISSUER, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, fakeGithub, type FakeGithubUser } from "../support/fake-github.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const HOSTILE = [
  `<script>alert(1)</script>Octo`,
  `<img src=x onerror=alert(1)>`,
  `[click here](https://evil.example/phish) **bold** _it_ \`code\` ~~x~~ | a | b |`,
  `Octo‮evil\u0000​ name`,
  `Octo ${"x".repeat(5_000)}`,
  `${"é".repeat(200)}`,
  `a@b.example.test Octo`,
];
const MARKUP = /[<>&`[\]*_~|\\]/u;

describe("the GitHub name (untrusted text)", () => {
  it("keeps an ordinary name as it is and uses the login when there is no name", () => {
    expect(githubDisplayName("Octo Verified", "octo")).toBe("Octo Verified");
    expect(githubDisplayName("Ada (she/her)", "octo")).toBe("Ada (she/her)");
    expect(githubDisplayName(undefined, "octo")).toBe("octo");
    expect(githubDisplayName(null, "octo")).toBe("octo");
    expect(githubDisplayName(42, "octo")).toBe("octo");
    expect(githubDisplayName("   ", "octo")).toBe("octo");
    expect(githubDisplayName("", "octo")).toBe("octo");
  });

  it.each(HOSTILE.map((name) => [name.slice(0, 40), name]))("cuts a hostile name to plain text of at most 80 code points: %s", (_label, name) => {
    const clean = githubDisplayName(name, "octo");
    expect(Array.from(clean).length).toBeLessThanOrEqual(80);
    expect(clean).not.toMatch(MARKUP);
    // eslint-disable-next-line no-control-regex
    expect(clean).not.toMatch(/[\u0000-\u001f\u007f​‪-‮]/u);
    expect(clean).not.toContain("@");
    expect(clean.length).toBeGreaterThan(0);
  });

  it("uses the login when nothing but markup is left, or the name looks like a placeholder", () => {
    expect(githubDisplayName("<<<>>>***", "octo")).toBe("octo");
    expect(githubDisplayName("Member 3fa9c1d2", "octo")).toBe("octo");
    expect(githubDisplayName("member   3FA9C1D2", "octo")).toBe("octo");
  });

  it("reads only the first 1,000 characters of a name", () => {
    expect(githubDisplayName(`Octo${" ".repeat(2_000)}tail`, "octo")).toBe("Octo");
    expect(githubDisplayName(`${"<".repeat(1_500)}tail`, "octo")).toBe("octo");
  });

  it("reads a huge name in bounded time", () => {
    const start = Date.now();
    githubDisplayName("<a>".repeat(2_000_000), "octo");
    githubDisplayName("​".repeat(5_000_000) + "x", "octo");
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("the GitHub picture", () => {
  it("is built from the numeric id on GitHub's avatar host and nothing else", () => {
    expect(githubAvatarUrl(GITHUB_ISSUER, "1001")).toBe(`${GITHUB_AVATAR_BASE}1001?s=96`);
    expect(GITHUB_AVATAR_BASE).toBe("https://avatars.githubusercontent.com/u/");
    for (const subject of ["", "0", "01", "-1", "1e3", "1001/../x", "1001?x=1", "1001#a", " 1001", "9".repeat(17), "9007199254740993", "javascript:alert(1)", "https://evil.example/a.png", "octo"]) {
      expect(githubAvatarUrl(GITHUB_ISSUER, subject)).toBeUndefined();
    }
    expect(githubAvatarUrl(GITHUB_ISSUER, 1001)).toBeUndefined();
    expect(githubAvatarUrl("https://evil.example", "1001")).toBeUndefined();
    expect(githubAvatarUrl(undefined, "1001")).toBeUndefined();
  });

  it("is only for a GitHub person; a stored avatar address is never read", () => {
    expect(profileAvatarUrl({ provider: "github", issuer: GITHUB_ISSUER, subject: "1001", avatarUrl: "https://evil.example/a.png" } as never)).toBe(`${GITHUB_AVATAR_BASE}1001?s=96`);
    expect(profileAvatarUrl({ provider: "slack", issuer: GITHUB_ISSUER, subject: "1001" })).toBeUndefined();
    expect(profileAvatarUrl({ provider: "oidc", issuer: GITHUB_ISSUER, subject: "1001" })).toBeUndefined();
    expect(profileAvatarUrl({ provider: "github", issuer: "https://evil.example", subject: "1001" })).toBeUndefined();
  });

  it("names are as stored for everyone but GitHub people", () => {
    const stored = "<b>Maya</b> `Chen`";
    expect(profileDisplayName({ provider: "slack", displayName: stored })).toBe(stored);
    expect(profileDisplayName({ provider: "oidc", displayName: stored })).toBe(stored);
    expect(profileDisplayName({ displayName: stored })).toBe(stored);
    expect(profileDisplayName({ provider: "github", subject: "1001", displayName: stored })).toBe("b Maya /b Chen");
    expect(profileDisplayName({ provider: "github", subject: "1001", displayName: "<>" })).toBe("GitHub user 1001");
    expect(profileDisplayName({ provider: "github", subject: "x", displayName: "<>" })).toBe("GitHub user");
    expect(profileDisplayName({ provider: "github", displayName: 5 })).toBeUndefined();
  });
});

const users: FakeGithubUser[] = [
  { id: 2001, login: "octo-named", name: "Octo Named", emails: [] },
  { id: 2002, login: "octo-login", emails: [] },
  { id: 2003, login: "octo-evil", name: `<img src=x onerror=alert(1)>[a](https://evil.example) ${"y".repeat(500)}`, emails: [] },
  { id: 2004, login: "octo-markup", name: "<>**", emails: [] },
];
async function signIn(login: string) {
  const gh = fakeGithub(users);
  const p = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: () => 0 });
  const nonce = "n".repeat(43), redirectUri = "https://signin.example.test/v1/auth/callback/github";
  const code = new URL(gh.approve(await p.authorizeUrl({ state: "s", nonce, redirectUri }), login)).searchParams.get("code")!;
  return p.complete({ code, nonce, redirectUri });
}

describe("the name stored at GitHub sign-in", () => {
  it("is the GitHub name, else the login", async () => {
    expect(await signIn("octo-named")).toMatchObject({ ok: true, identity: { subject: "2001", displayName: "Octo Named" } });
    expect(await signIn("octo-login")).toMatchObject({ ok: true, identity: { subject: "2002", displayName: "octo-login" } });
  });
  it("is plain text, cut, for a hostile name; markup only gives the login", async () => {
    const evil = await signIn("octo-evil");
    expect(evil).toMatchObject({ ok: true });
    const name = (evil as { identity: { displayName: string } }).identity.displayName;
    expect(Array.from(name).length).toBeLessThanOrEqual(80);
    expect(name).not.toMatch(MARKUP);
    expect(await signIn("octo-markup")).toMatchObject({ ok: true, identity: { displayName: "octo-markup" } });
  });
});

function deps(db: FakeDynamoDb): AdminActionDependencies {
  return { documentClient: db, tableName: "state", signInTableName: "signin", slackTeamId: "T0BSHLLUGBD", limitDefaults: { member: 3, organization: 20 }, now: () => 0 } as unknown as AdminActionDependencies;
}
const GH = "a".repeat(64), SL = developerIdForSlackUser("U0ADA00001");

describe("who an admin tool says a GitHub person is (the operator's resolve)", () => {
  function world() {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVELOPER#${GH}`, sk: "META", developerId: GH, provider: "github", issuer: GITHUB_ISSUER, subject: "2001", displayName: "Octo Named", email: "octo@example.test", revoked: false });
    db.set({ ...emailIndexKey("octo@example.test"), developerId: GH });
    db.set({ pk: `DEVELOPER#${SL}`, sk: "META", developerId: SL, provider: "slack", issuer: "https://slack.com", subject: "U0ADA00001", displayName: "Ada", slackUserId: "U0ADA00001", revoked: false });
    return db;
  }
  it("gives a GitHub person their name and picture by id and by email, and no more than a Slack person gets", async () => {
    const d = deps(world());
    const picture = `${GITHUB_AVATAR_BASE}2001?s=96`;
    expect(await resolveDeveloper(d, GH)).toEqual({ developerId: GH, via: "id", profile: { displayName: "Octo Named", provider: "github", avatarUrl: picture } });
    expect(await resolveDeveloper(d, "Octo@Example.test")).toEqual({ developerId: GH, via: "email", profile: { displayName: "Octo Named", provider: "github", avatarUrl: picture } });
    // A Slack person's profile is exactly as before: no picture.
    expect(await resolveDeveloper(d, "U0ADA00001")).toEqual({ developerId: SL, via: "slack", slackUserId: "U0ADA00001", profile: { displayName: "Ada", provider: "slack", slackUserId: "U0ADA00001" } });
  });
  it("cleans a hostile stored name and refuses a forged picture address", async () => {
    const db = world();
    db.set({ ...db.get(`DEVELOPER#${GH}`, "META")!, displayName: `<script>alert(1)</script>${"z".repeat(300)}`, subject: "2001", avatarUrl: "https://evil.example/x.png" });
    const answer = await resolveDeveloper(deps(db), GH);
    expect(answer.profile?.displayName).not.toMatch(MARKUP);
    expect(Array.from(answer.profile?.displayName ?? "").length).toBeLessThanOrEqual(80);
    expect(answer.profile?.avatarUrl).toBe(`${GITHUB_AVATAR_BASE}2001?s=96`);
    expect(JSON.stringify(answer)).not.toContain("evil.example");
  });
  it("gives no picture when the stored subject is not a GitHub id, and keeps a Slack person's markup as stored", async () => {
    const db = world();
    db.set({ ...db.get(`DEVELOPER#${GH}`, "META")!, subject: "octo/../x" });
    expect((await resolveDeveloper(deps(db), GH)).profile).toEqual({ displayName: "Octo Named", provider: "github" });
    db.set({ ...db.get(`DEVELOPER#${SL}`, "META")!, displayName: "<b>Ada</b>" });
    expect((await resolveDeveloper(deps(db), SL)).profile?.displayName).toBe("<b>Ada</b>");
  });
  it("still refuses an unknown provider", async () => {
    const db = world();
    db.set({ ...db.get(`DEVELOPER#${GH}`, "META")!, provider: "saml" });
    expect((await resolveDeveloper(deps(db), GH)).profile).toBeUndefined();
  });
});

describe("the CLI caller's name (DEC 254p (a))", () => {
  it("reaches tasks and admin screens as clean text for a GitHub person, and as stored for anyone else", async () => {
    const { authenticateDeveloper } = await import("../../packages/broker/src/aws/developer-routes.js");
    const { DEVELOPER_TOKEN_AUDIENCE } = await import("@agentx/contracts");
    const db = new FakeDynamoDb();
    const NOW = Date.parse("2026-11-17T12:00:00.000Z");
    const config = { issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true, github: true }, signInTableName: "SignIn", verifyAccessToken: async () => undefined, channelMembers: async () => ({ ok: true as const, memberOf: [] }) };
    const deps = { documentClient: db, tableName: "State", now: () => NOW, developer: config } as never;
    const person = (provider: "github" | "slack", displayName: string) => {
      db.set({ pk: `DEVELOPER#${GH}`, sk: "META", developerId: GH, provider, issuer: provider === "github" ? GITHUB_ISSUER : "https://slack.com", subject: "2001", displayName, revoked: false });
      db.set({ pk: "SESSION#s1", sk: "META", sessionId: "s1", developerId: GH, amr: provider, startedAt: new Date(NOW - 1000).toISOString(), endsAt: NOW / 1000 + 3600 });
      return authenticateDeveloper(deps, { iss: config.issuer, aud: DEVELOPER_TOKEN_AUDIENCE, env: "test", sub: GH, sid: "s1", amr: provider });
    };
    expect((await person("github", "Octo Named")).name).toBe("Octo Named");
    const hostile = (await person("github", `<script>alert(1)</script>[x](https://evil.example)${"h".repeat(900)}`)).name;
    expect(hostile).not.toMatch(MARKUP);
    expect(Array.from(hostile).length).toBeLessThanOrEqual(80);
    expect((await person("slack", "<b>Ada</b>")).name).toBe("<b>Ada</b>");
  });
});
