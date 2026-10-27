import { describe, expect, it } from "vitest";
import { classifyString, credentialKey, keyWords } from "../../packages/verifier/src/executor/credential-classifier.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { headerSecrets, urlSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { BROWSER_STATE_IDB_MAX_BYTES, BROWSER_STATE_IDB_MAX_RECORDS, BrowserStateCapError, tellBrowserState, type BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { isSessionStorageCredential } from "../../packages/verifier/src/executor/session-storage-secret.js";
import type { ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";

// MIDSTEP-2: the tiered classifier, JSON leaves, URL parameters, headers, session storage and IndexedDB, as pure functions (the end-to-end tests are in e2e-midstep2-end-to-end.test.ts).

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"user-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const OPAQUE = "Zk3pQ9xW2mV7cL4nR8tY1bH6jD5sA0gF";
const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;

describe("the key reading", () => {
  it("splits a key into words and reads credential words, with metadata words after them and route words anywhere taking the key out", () => {
    expect(keyWords("firebase:authUser:KEY")).toEqual(["firebase", "auth", "user", "key"]);
    expect(keyWords("sb-xyz-auth-token")).toEqual(["sb", "xyz", "auth", "token"]);
    for (const name of ["token", "access_token", "idToken", "sb-xyz-auth-token", "user_token", "Authorization", "sessionId", "client_secret", "password", "apiKey", "api_key", "x-api-key", "refreshToken", "rememberMe"]) {
      expect(credentialKey(name).credential, name).toBe(true);
    }
    for (const name of ["LastAuthUser", "redirectAfterAuth", "tokenType", "sessionExpiresAt", "authUser", "accessibilityMode", "cookieConsent", "returnTo", "author", "theme", "locale", "draft", "key"]) {
      expect(credentialKey(name).credential, name).toBe(false);
    }
    expect(credentialKey("password").strongest).toBe(true);
    expect(credentialKey("session").strongest).toBe(false);
  });
});

describe("tiers (gap 2)", () => {
  it("a JWT, a long opaque base64 or hex run is strong under any key", () => {
    for (const name of ["anything", "x", "user"]) {
      expect(tierOf(classifyString(name, JWT), JWT), name).toBe("strong");
      expect(tierOf(classifyString(name, OPAQUE), OPAQUE), name).toBe("strong");
    }
    const hex = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
    expect(tierOf(classifyString("anything", hex), hex)).toBe("strong");
  });

  it("a value under a credential key is strong, from 8 characters for the strongest key words and 16 for the others, and a short or common one is not registered", () => {
    expect(tierOf(classifyString("password", "hunter2222"), "hunter2222")).toBe("strong");
    // 8 to 15 characters under a looser credential word: scrubbed, not refused.
    expect(classifyString("session", "abcdef12").map((item) => item.tier)).toEqual(["weak"]);
    expect(tierOf(classifyString("session", "opaque-session-value-1234"), "opaque-session-value-1234")).toBe("strong");
    expect(classifyString("token", "short")).toEqual([]);
    expect(classifyString("token", "undefined")).toEqual([]);
    expect(classifyString("theme", "dark")).toEqual([]);
  });

  it("the known false positive: a 32+ character path or slug with a digit is NOT strong (it is scrub-only at the top level: scrubbed from evidence, never refused, never masked for the model)", () => {
    for (const slug of ["/projects/alpha/settings/notifications2", "my-quarterly-report-for-the-board-2024-final", "projects/alpha/settings/notifications2/edit", "internationalization-and-localization-settings2"]) {
      expect(slug.length, slug).toBeGreaterThanOrEqual(32);
      expect(tierOf(classifyString("lastVisited", slug), slug), slug).toBe("scrub");
      expect(tierOf(classifyString("anything", slug), slug), slug).toBe("scrub");
    }
    // ... also under a key the old rule matched ("redirectAfterAuth", "lastSessionAt", a UUID under a neutral key).
    expect(tierOf(classifyString("redirectAfterAuth", "/dashboard/overview/orders"), "/dashboard/overview/orders")).toBe("scrub");
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(tierOf(classifyString("lastWorkspaceId", uuid), uuid)).toBe("scrub");
    expect(tierOf(classifyString("lastSessionAt", "2026-10-27T09:15:00.000Z"), "2026-10-27T09:15:00.000Z")).toBe("weak");
    // A credential key wins over the path, URL and email shapes (fix round 4); only a key that is about a date or a route (`sessionStart`, `redirectAfterAuth`) takes the value out.
    for (const [name, value] of [["session", "https://app.example.com/orders/overview"], ["auth", "/dashboard/overview"], ["token", "maya@example.com"]] as const) {
      expect(tierOf(classifyString(name, value), value), `${name}=${value}`).toBe("strong");
    }
    expect(tierOf(classifyString("sessionStart", "2026-10-27T09:15:00.000Z"), "2026-10-27T09:15:00.000Z")).toBe("weak");
    // R4-5: each metadata word of the "when" family is pinned on its own (removing `end`/`ended` or `created`/`updated`/`modified` from the list turns these dates strong).
    for (const name of ["sessionEnd", "sessionEnded", "tokenCreated", "sessionUpdated", "authModified"]) {
      expect(tierOf(classifyString(name, "2026-10-27T09:15:00.000Z"), "2026-10-27T09:15:00.000Z"), name).toBe("weak");
      expect(credentialKey(name).credential, name).toBe(false);
    }
    for (const name of ["sessionEnd", "sessionEnded"]) expect(credentialKey(name).loose, name).toBe(true);
    // A UUID kept as a session id IS a credential: the key says so.
    expect(tierOf(classifyString("sessionId", uuid), uuid)).toBe("strong");
  });

  it("a random base64url token with separators in it is still strong (the slug test looks for words)", () => {
    for (const token of ["Qw3-rT9_yU2iO5pA8sD1fG4hJ7kL0zXc", "aB3dE-fG5hI_jK7lM9nO1pQ3rS5tU7vW9xY", "N7vB2-c9X4zL_q8W5eR1tY6uI3oP0aSd"]) expect(tierOf(classifyString("anything", token), token), token).toBe("strong");
  });

  it("Bearer, Basic and Token schemes kept in storage: the value after the scheme is strong even though the whole has whitespace", () => {
    const bearer = classifyString("authorization", `Bearer ${OPAQUE}`);
    expect(tierOf(bearer, OPAQUE)).toBe("strong");
    expect(tierOf(classifyString("anything", `Basic ${Buffer.from("maya:hunter2222").toString("base64")}`), Buffer.from("maya:hunter2222").toString("base64"))).toBe("strong");
  });

  it("dotted and piped tokens (a PASETO, a Sanctum token, a JWE) are strong", () => {
    const sanctum = `12|${OPAQUE}`;
    expect(tierOf(classifyString("anything", sanctum), sanctum)).toBe("strong");
    expect(tierOf(classifyString("anything", sanctum), OPAQUE)).toBe("strong");
    const paseto = `v2.local.${OPAQUE}${OPAQUE}`;
    expect(tierOf(classifyString("anything", paseto), paseto)).toBe("strong");
  });

  it("any other value of 16+ characters is scrub-only (scrubbed from evidence as before, not masked for the model), and one under 16 is not registered", () => {
    expect(tierOf(classifyString("draft", "Quarterly report for ACME"), "Quarterly report for ACME")).toBe("scrub");
    expect(classifyString("locale", "en-US")).toEqual([]);
  });

  it("the old boolean keeps its answers (the cookie fix's table)", () => {
    const jwt = JWT;
    for (const entry of [{ name: "anything", value: jwt }, { name: "anything", value: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c" }, { name: "sb-project-auth-token", value: "keyed-opaque-value-1234" }, { name: "ID_TOKEN", value: "keyed-opaque-value-1234" }]) {
      expect(isSessionStorageCredential(entry), entry.name).toBe(true);
    }
    for (const entry of [{ name: "draft", value: "Quarterly report for ACME" }, { name: "returnTo", value: "https://app.example.com/settings" }, { name: "searchHistory", value: "orders,invoices,customers-with-open-balances" },
      { name: "access_token", value: "short" }, { name: "locale", value: "en-US" }, { name: "i18nextLng", value: "x".repeat(40) }, { name: "sessionDraft", value: "a draft that is text and has spaces" }]) {
      expect(isSessionStorageCredential(entry), `${entry.name}=${entry.value}`).toBe(false);
    }
  });
});

describe("JSON leaves (gap 1)", () => {
  const TOKEN = "tok_live_9f8e7d6c5b4a3928";
  it("a token inside compact JSON under a neutral key is registered on its own, and the draft beside it is not strong", () => {
    const items = classifyStorageEntry({ name: "user", value: `{"user":"maya","token":"${TOKEN}","draft":"Quarterly report for ACME"}` });
    expect(tierOf(items, TOKEN)).toBe("strong");
    expect(tierOf(items, "Quarterly report for ACME")).toBeNull();
    expect(items.filter((item) => item.tier === "strong").map((item) => item.value)).toEqual([TOKEN]);
  });

  it("the same with whitespace (pretty-printed JSON), which the old rule rejected outright", () => {
    const value = JSON.stringify({ user: "maya", session: { token: TOKEN, expiresAt: "2026-10-27T09:15:00.000Z" } }, null, 2);
    expect(value).toMatch(/\s/);
    const items = classifyStorageEntry({ name: "persist:root", value });
    expect(tierOf(items, TOKEN)).toBe("strong");
    expect(tierOf(items, "2026-10-27T09:15:00.000Z")).not.toBe("strong");
  });

  it("JSON inside JSON (redux-persist) and arrays are walked", () => {
    const inner = JSON.stringify({ auth: JSON.stringify({ accessToken: JWT, refreshToken: OPAQUE }), list: [{ apiKey: "key-abcdef123456" }] });
    const items = classifyStorageEntry({ name: "persist:root", value: JSON.stringify({ _persist: "{\"version\":1}", state: inner }) });
    expect(tierOf(items, JWT)).toBe("strong");
    expect(tierOf(items, OPAQUE)).toBe("strong");
    expect(tierOf(items, "key-abcdef123456")).toBe("strong");
  });

  it("the blob itself is not registered, and a blob that shows no token is not a credential by being under a key like `auth`", () => {
    const value = `{"name":"Maya Q","theme":"dark","plan":"professional-annual"}`;
    const items = classifyStorageEntry({ name: "auth_profile", value });
    expect(items.filter((item) => item.tier === "strong")).toEqual([]);
    expect(tierOf(items, value)).toBeNull();
  });

  it("metadata beside a token is not a credential (`tokenType`, `expiresAt`, `authUser`)", () => {
    const items = classifyStorageEntry({ name: "okta-token-storage", value: JSON.stringify({ accessToken: { accessToken: JWT, tokenType: "Bearer", scopes: ["openid", "profile"], authUser: "maya@example.com" } }) });
    expect(items.filter((item) => item.tier === "strong").map((item) => item.value)).toEqual([JWT]);
  });

  it("an oversized or too-deep value is not parsed: its token-shaped substrings are registered (bounded, never a crash)", () => {
    const big = JSON.stringify({ filler: "x".repeat(1_100_000), token: JWT });
    expect(tierOf(classifyStorageEntry({ name: "cache", value: big }), JWT)).toBe("strong");
    let deep: unknown = { token: JWT };
    for (let level = 0; level < 40; level += 1) deep = { child: deep };
    expect(tierOf(classifyStorageEntry({ name: "deep", value: JSON.stringify(deep) }), JWT)).toBe("strong");
  });

  it("text that merely starts with a brace is a plain value", () => {
    expect(classifyStorageEntry({ name: "note", value: "{not json at all" })).toEqual([{ value: "{not json at all", tier: "scrub" }]);
  });
});

describe("URL parameters (gap 3)", () => {
  it("registers secret-looking query and fragment parameters of a page URL", () => {
    const items = urlSecrets(`https://app.test/cb?token=${OPAQUE}&page=2&q=${"long search text ".repeat(3)}#access_token=${JWT}&token_type=bearer&state=xyz12345678`);
    expect(tierOf(items, OPAQUE)).toBe("strong");
    expect(tierOf(items, JWT)).toBe("strong");
    expect(tierOf(items, "xyz12345678")).toBe("weak");
    expect(items.map((item) => item.value)).not.toContain("bearer");
    expect(items.map((item) => item.value).filter((value) => value.includes("search"))).toEqual([]);
  });

  it("reads hash-router fragments, a `+` that stays a plus, and percent-encoded values", () => {
    expect(tierOf(urlSecrets("https://app.test/#/callback?id_token=abc%2Bdef%2Fghij12345"), "abc+def/ghij12345")).toBe("strong");
    expect(tierOf(urlSecrets("https://app.test/x?session_id=ab+cd1234efgh"), "ab+cd1234efgh")).toBe("strong");
  });

  it("an OAuth code, a signature and a generic key are weak (scrubbed, not refused); ids, hashes and short values are not registered", () => {
    const items = urlSecrets(`https://app.test/cb?code=4/0AbCdEf123456&sig=${OPAQUE}&key=abcdef123456&order=${OPAQUE}&n=1`);
    expect(tierOf(items, "4/0AbCdEf123456")).toBe("weak");
    expect(tierOf(items, OPAQUE)).toBe("weak");
    expect(tierOf(items, "abcdef123456")).toBe("weak");
    // A hex trace id is not registered; a neutral parameter whose value is an opaque token is weak (masked, never refused: MASKMAYBE F-4).
    expect(urlSecrets(`https://app.test/orders?trace=${"a1".repeat(20)}`)).toEqual([]);
    expect(urlSecrets(`https://app.test/orders?id=${OPAQUE}`)).toEqual([{ value: OPAQUE, tier: "weak" }]);
    expect(urlSecrets("https://app.test/?token=short")).toEqual([]);
  });

  it("a non-http URL and a malformed one give nothing", () => {
    expect(urlSecrets("data:text/html,token=abcdefgh12345")).toEqual([]);
    expect(urlSecrets("not a url")).toEqual([]);
  });
});

describe("request headers (gap 4)", () => {
  it("registers Bearer and Basic Authorization values, cookies, and API-key style headers", () => {
    const basic = Buffer.from("maya:hunter2222").toString("base64");
    const items = headerSecrets([
      { name: "Authorization", value: `Bearer ${OPAQUE}` }, { name: "Proxy-Authorization", value: `Basic ${basic}` },
      { name: "Cookie", value: "theme=dark; sid=0123456789abcdef0123; consent=1" },
      { name: "X-API-Key", value: "key-abcdef123456" }, { name: "x-auth-token", value: JWT }, { name: "X-CSRF-Token", value: "csrf-abcdef123456789" },
      { name: "User-Agent", value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" }, { name: "traceparent", value: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      { name: "Accept", value: "application/json" },
    ]);
    expect(tierOf(items, OPAQUE)).toBe("strong");
    expect(tierOf(items, basic)).toBe("strong");
    expect(tierOf(items, "0123456789abcdef0123")).toBe("strong");
    expect(tierOf(items, "key-abcdef123456")).toBe("strong");
    expect(tierOf(items, JWT)).toBe("strong");
    expect(tierOf(items, "csrf-abcdef123456789")).toBe("weak");
    // Another scheme than Bearer or Basic: everything after the scheme is the credential. A bare token with no scheme too.
    const hawk = 'id="dh37fgj492je", ts="1353832234", mac="Zk3pQ9xW2mV7cL4nR8tY1bH6jD5sA0gF"';
    expect(tierOf(headerSecrets([{ name: "Authorization", value: `Hawk ${hawk}` }]), hawk)).toBe("strong");
    expect(tierOf(headerSecrets([{ name: "Authorization", value: OPAQUE }]), OPAQUE)).toBe("strong");
    // Not credentials: a user agent, a trace id, a theme cookie.
    expect(items.map((item) => item.value).filter((value) => /Mozilla|4bf92f|dark|json/.test(value))).toEqual([]);
  });
});

describe("browser state: session storage, IndexedDB and URLs (gap 5), with bounds", () => {
  const told = (state: BrowserSecretState): ClassifiedValue[] => { const out: ClassifiedValue[] = []; tellBrowserState(state, (item) => out.push(item)); return out; };
  const idbRecord = (value: unknown) => ({ valueEncoded: { o: Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v: typeof v === "object" ? { o: Object.entries(v as Record<string, unknown>).map(([k2, v2]) => ({ k: k2, v: v2 })) } : v })) } });

  it("reads session storage entries and IndexedDB records through the same classifier", () => {
    const items = told({ cookies: [], origins: [{ localStorage: [], sessionStorage: [{ name: "msal.idtoken", value: JWT }], indexedDB: [{ name: "firebaseLocalStorageDb", stores: [{ name: "firebaseLocalStorage", records: [
      idbRecord({ fbase_key: "firebase:authUser:KEY", value: { accessToken: OPAQUE, displayName: "Maya Q" } })] }] }] }], urls: [`https://app.test/#access_token=${"Ab1".repeat(8)}`] });
    expect(tierOf(items, JWT)).toBe("strong");
    expect(tierOf(items, OPAQUE)).toBe("strong");
    expect(tierOf(items, "Ab1".repeat(8))).toBe("strong");
    expect(tierOf(items, "Maya Q")).toBeNull();
  });

  it("with a memo, an entry classified before is not classified again, and a changed one is (the sync reads the whole browser before every model call)", () => {
    const memo = new Set<string>();
    const state = (token: string): BrowserSecretState => ({ cookies: [], origins: [{ localStorage: [{ name: "persist:root", value: `{"token":"${token}"}` }], sessionStorage: [{ name: "msal.idtoken", value: JWT }], indexedDB: [{ name: "db", stores: [{ name: "s", records: [{ valueEncoded: OPAQUE }] }] }] }], urls: [`https://app.test/#access_token=${OPAQUE}`] });
    const learn = (): string[] => { const out: string[] = []; tellBrowserState(state("tok_live_9f8e7d6c5b4a3928"), (item) => out.push(item.value), memo); return out; };
    expect(learn().length).toBeGreaterThan(0);
    expect(learn()).toEqual([]);
    const changed: string[] = [];
    tellBrowserState(state("tok_live_aaaaaaaaaaaaaaaa"), (item) => changed.push(item.value), memo);
    expect(changed).toContain("tok_live_aaaaaaaaaaaaaaaa");
    expect(changed).not.toContain(JWT);
    // Without a memo every read classifies everything.
    const twice: string[][] = [[], []];
    for (const out of twice) tellBrowserState(state("tok_live_9f8e7d6c5b4a3928"), (item) => out.push(item.value));
    expect(twice[1]!.length).toBe(twice[0]!.length);
  });

  it("fails closed when IndexedDB holds more records or bytes than the bounds, or is not in the shape the driver gives", () => {
    const manyRecords = Array.from({ length: BROWSER_STATE_IDB_MAX_RECORDS + 1 }, (_unused, index) => ({ value: `r${index}` }));
    expect(() => told({ cookies: [], origins: [{ localStorage: [], indexedDB: [{ name: "db", stores: [{ name: "s", records: manyRecords }] }] }] })).toThrow(BrowserStateCapError);
    const bigRecord = { value: "x".repeat(BROWSER_STATE_IDB_MAX_BYTES / 2 + 1) };
    expect(() => told({ cookies: [], origins: [{ localStorage: [], indexedDB: [{ name: "db", stores: [{ name: "s", records: [bigRecord, bigRecord] }] }] }] })).toThrow(expect.objectContaining({ code: "indexeddb-bytes" }));
    expect(() => told({ cookies: [], origins: [{ localStorage: [], indexedDB: "garbage" }] })).toThrow(expect.objectContaining({ code: "indexeddb-shape" }));
    // Exactly at the record bound is fine.
    expect(() => told({ cookies: [], origins: [{ localStorage: [], indexedDB: [{ name: "db", stores: [{ name: "s", records: manyRecords.slice(1) }] }] }] })).not.toThrow();
  });
});

describe("fix round 1 (review of 334c7ced)", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const strong = (items: readonly ClassifiedValue[]) => items.filter((item) => item.tier === "strong").map((item) => item.value);

  it("B-1: a cache of ordinary ids, paths, URLs, dates and emails registers nothing (no weak leaf that a page, a trace or a report would show)", () => {
    const cache = { lastPage: "http://127.0.0.1:4173/dashboard", at: "2026-10-27T12:00:00.000Z", owner: "someone@example.com", id: UUID, path: "/projects/alpha/settings", href: `/orders/${UUID}`, slug: "my-quarterly-report-for-the-board-2024" };
    expect(classifyStorageEntry({ name: "react-query-cache", value: JSON.stringify(cache) })).toEqual([]);
    // An opaque token-like leaf is still scrubbed (weak), and anything under a credential key still counts.
    const items = classifyStorageEntry({ name: "cache", value: JSON.stringify({ blob: "a1b2c3d4e5f6g7h8i9j0", authCookie: "plain-words-here" }) });
    expect(tierOf(items, "a1b2c3d4e5f6g7h8i9j0")).toBe("weak");
    expect(tierOf(items, "plain-words-here")).toBe("strong");
  });

  it("I-3: a standard-base64 token that starts with a slash is a credential under a credential key and by its shape; a real path is still not", () => {
    const token = "/k3JqZ8vR2mT9wXyB4nL7pQ1sD6fH0gA5eC8uV3iO2Y=";
    expect(tierOf(classifyString("token", token), token)).toBe("strong");
    expect(tierOf(classifyString("anything", token), token)).toBe("strong");
    expect(tierOf(urlSecrets(`https://app.test/cb?access_token=${encodeURIComponent(token)}`), token)).toBe("strong");
    // A path under a neutral key stays scrub-only; under a credential key the key wins.
    expect(tierOf(classifyString("lastRoute", "/dashboard/overview/orders"), "/dashboard/overview/orders")).toBe("scrub");
  });

  it("I-4: a token stored with JSON.stringify is classified bare as well as quoted", () => {
    const items = classifyStorageEntry({ name: "accessToken", value: JSON.stringify(JWT) });
    expect(tierOf(items, JWT)).toBe("strong");
    expect(tierOf(items, `"${JWT}"`)).toBe("strong");
    // Inside a container too (a JSON-encoded string leaf).
    expect(tierOf(classifyStorageEntry({ name: "store", value: JSON.stringify({ idToken: JSON.stringify(JWT) }) }), JWT)).toBe("strong");
  });

  it("I-5: a short neutral key under a credential key takes the parent's reading for an opaque value, and `plan` under `auth` does not", () => {
    const sid = "a8Kd93mZp2Lq7xW4vB1n";
    expect(tierOf(classifyStorageEntry({ name: "state", value: JSON.stringify({ session: { id: sid } }) }), sid)).toBe("strong");
    expect(tierOf(classifyStorageEntry({ name: "state", value: JSON.stringify({ auth: { key: sid } }) }), sid)).toBe("strong");
    expect(tierOf(classifyStorageEntry({ name: "state", value: JSON.stringify({ credentials: { id: sid } }) }), sid)).toBe("strong");
    expect(strong(classifyStorageEntry({ name: "state", value: JSON.stringify({ auth: { plan: "pro-annual-2026-plan" }, profile: { id: sid } }) }))).toEqual([]);
    // Only the short neutral keys inherit: an opaque value under `theme` beside the credential key does not.
    expect(strong(classifyStorageEntry({ name: "state", value: JSON.stringify({ auth: { theme: sid } }) }))).toEqual([]);
    // A path under a credential key is a credential (the key wins); under a neutral key it is nothing.
    expect(tierOf(classifyStorageEntry({ name: "state", value: JSON.stringify({ session: `/orders/${UUID}` }) }), `/orders/${UUID}`)).toBe("strong");
    expect(classifyStorageEntry({ name: "state", value: JSON.stringify({ href: `/orders/${UUID}` }) })).toEqual([]);
  });

  it("I-6: a pure hex id, an address, a git sha or a dashless UUID inside JSON is not registered under a neutral key, and is a credential under a credential key; a base64 mix is still strong", () => {
    const hexes = ["3f2504e04f8911d39a0c0305e82c3301", "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", "0x5290AbCdEf1234567890aBcDeF1234567890Ee7f", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"];
    for (const hex of hexes) {
      expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ id: hex, commit: hex }) }), hex).toEqual([]);
      expect(tierOf(classifyStorageEntry({ name: "cache", value: JSON.stringify({ sessionToken: hex }) }), hex), hex).toBe("strong");
    }
    expect(tierOf(classifyStorageEntry({ name: "cache", value: JSON.stringify({ blob: OPAQUE }) }), OPAQUE)).toBe("strong");
    // A whole stored value (not a leaf) keeps the cookie fix's rule.
    expect(tierOf(classifyStorageEntry({ name: "anything", value: hexes[1]! }), hexes[1]!)).toBe("strong");
  });
});
