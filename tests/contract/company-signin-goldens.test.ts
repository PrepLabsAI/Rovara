// Deterministic absent-mode captures are compared after secret normalization.
// Non-secret wire bytes and decoded JWT header/claim bytes remain exact.
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import type * as CryptoModule from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { httpEvent, identityHarness, T0, VERIFIER, CLI_REDIRECT, authorizeQuery, OIDC_ISSUER } from "../support/developer-fakes.js";
import { signInClientsThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { expectLinearScaling } from "../support/scaling.js";
import { companyRouteHarness, PERSON } from "../support/company-route-harness.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { AgentXErrorCodeSchema, IMPLICIT_COMPANY_ID } from "@agentx/contracts";

const entropy = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof CryptoModule>(),
  randomBytes: (size: number) => Buffer.alloc(size, ++entropy.n),
  randomUUID: () => `00000000-0000-4000-8000-${String(++entropy.n).padStart(12, "0")}`,
}));
afterEach(() => vi.useRealTimers());

function world() {
  entropy.n = 0;
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const h = identityHarness({ slack: true, oidc: { administrator: { claim: "groups", values: ["admin"] } },
    slackUsers: [{ userId: "U0SHARED", name: "Person", email: "person@example.test" }],
    oidcUsers: [{ sub: "person", name: "Person", email: "person@example.test", email_verified: true, groups: ["admin"] }],
  });
  // FakeDynamoDb does not implement DeleteItem ALL_OLD. Model that wire response
  // here so the legacy removal golden records DynamoDB behavior, not an empty fake response.
  const send = h.db.send.bind(h.db);
  vi.spyOn(h.db, "send").mockImplementation(async (command) => {
    const old = command instanceof DeleteCommand && command.input.ReturnValues === "ALL_OLD"
      ? h.db.get(String(command.input.Key?.pk), String(command.input.Key?.sk)) : undefined;
    const response = await send(command);
    return old === undefined ? response : { Attributes: old };
  });
  h.deps.signer = {
    publicJwk: async () => ({ kty: "RSA", n: "test-only", e: "AQAB", kid: "golden", alg: "RS256", use: "sig" }),
    sign: async (input) => createHash("sha256").update(input).digest(),
  };
  return h;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const rows = (h: ReturnType<typeof world>, enabled: boolean) => canonical([...h.db.items.values()].filter((row) => !enabled || !["COMPANY_MEMBERSHIP", "SIGN_IN_CLIENT_REGISTRY"].includes(String(row.entityType))).sort((a, b) => `${String(a.pk)}/${String(a.sk)}`.localeCompare(`${String(b.pk)}/${String(b.sk)}`)));
const form = (h: ReturnType<typeof world>, path: string, body: Record<string, string>) => h.http(httpEvent("POST", path, body));
const code = (back: URL) => back.searchParams.get("code")!;
const client = { clientId: "golden-web", name: "Golden", audience: "golden-web", redirectUris: [], loopback: true, scopes: ["projects:members" as const], createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), updatedBy: "operator" };

export const GOLDEN_NAMES = ["slack", "oidc-admin", "registered-client", "browser", "wrong-team", "revoked-developer", "removed-client", "client-planners", "access-token", "access-id", "discovery", "configuration"] as const;
async function captureRaw(name: typeof GOLDEN_NAMES[number], enabled = false): Promise<unknown> {
  const h = world();
  const legacy = enabled && ["slack", "oidc-admin", "registered-client", "browser", "revoked-developer"].includes(name);
  if (enabled) h.deps.company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  if (legacy) {
    const method = name === "oidc-admin" || name === "registered-client" ? "oidc" : "slack";
    const issuer = method === "oidc" ? OIDC_ISSUER : "https://slack.com";
    const subject = method === "oidc" ? "person" : "U0SHARED";
    const developerId = ownerKeyForSubject(issuer, subject);
    await h.deps.store.upsertDeveloper({ developerId, provider: method, issuer, subject, displayName: "Person", email: "person@example.test", slackUserId: "U0SHARED" });
    const existing = await h.deps.store.createSession({ developerId, amr: method, slackUserId: "U0SHARED" });
    expect((await h.refresh(existing.refreshToken)).status).toBe(200);
    // The comparison starts after the legacy refresh; its disposable session is not part of the scenario.
    for (const item of [...h.db.items.values()]) if (!["DEVELOPER", "DEVELOPER_EMAIL", "COMPANY_MEMBERSHIP"].includes(item.entityType as string)) h.db.delete(item.pk as string, item.sk as string);
    entropy.n = 0;
  }
  const responses: unknown[] = [];
  if (name === "discovery" || name === "configuration") {
    responses.push(await h.http(httpEvent("GET", name === "discovery" ? "/v1/auth/.well-known/openid-configuration" : "/v1/auth/.well-known/agentx-configuration")));
  } else if (name === "client-planners") {
    const registry = signInClientsThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await h.handler(JSON.parse(new TextDecoder().decode(payload)) as Parameters<typeof h.handler>[0]))) }));
    const admin = await createAdminChangeBroker({ signInClients: registry });
    if (enabled) {
      const input = admin.brokerInput as { developer: { companies?: ReturnType<typeof companyMembershipFromDynamo> } };
      // Use the actual administrator fixture's owner key, not a token's company claim.
      const adminRow = admin.db.find((row) => row.entityType === "MEMBERSHIP" && row.role === "administrator")[0]!;
      const actualPerson = String(adminRow.ownerKey);
      admin.db.set({ pk: `COMPANY_MEMBER#${actualPerson}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: actualPerson, companyId: IMPLICIT_COMPANY_ID, role: "admin", joinedAt: new Date(T0).toISOString() });
      input.developer.companies = companyMembershipFromDynamo(admin.db, "signin");
    }
    for (const change of [
      { kind: "register_sign_in_client" as const, clientId: client.clientId, registration: { name: client.name, audience: client.audience, redirectUris: [], loopback: true } },
      { kind: "register_sign_in_client" as const, clientId: client.clientId, registration: { name: client.name, audience: client.audience, redirectUris: [], loopback: true, scopes: client.scopes } },
      { kind: "remove_sign_in_client" as const, clientId: client.clientId },
    ]) {
      const planned = await admin.propose(change, ["cli"]);
      responses.push(planned);
      expect(planned.status).toBe(201);
      responses.push(await admin.apply((planned.body.change as { changeId: string }).changeId, "cli"));
      // ANSWER-2 adds one opaque registry UUID per enabled mutation. Give the old
      // request-id stream its original deterministic inputs; response bytes stay untouched.
      if (enabled) entropy.n--;
      responses.push(await admin.admin("GET", "/v1/admin/sign-in-clients"));
    }
  } else if (name === "access-token" || name === "access-id") {
    const broker = companyRouteHarness();
    broker.project();
    const secret = ["golden", "secret"].join("-");
    broker.db.set({ pk: "SIGNIN_CLIENTS", sk: `CLIENT#${client.clientId}`, entityType: "SIGN_IN_CLIENT", ...client, secretHash: createHash("sha256").update(secret).digest("hex") });
    broker.db.set({ ...broker.db.get("SESSION#session", "META")!, clientId: client.clientId });
    Object.assign(broker.claims, { aud: client.audience, azp: client.clientId });
    if (enabled) {
      broker.db.set({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: IMPLICIT_COMPANY_ID, role: "member", joinedAt: new Date(T0).toISOString(), joinedVia: "legacy" });
      broker.deps.companies = companyMembershipFromDynamo(broker.db, "SignIn");
    }
    responses.push(await broker.read("/v1/dev/access", { method: "POST", headers: { authorization: name === "access-id" ? `Basic ${Buffer.from(`${client.clientId}:${secret}`).toString("base64")}` : `Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(broker.claims)).toString("base64url")}.c2ln` }, body: JSON.stringify(name === "access-id" ? { developerId: PERSON } : {}) }));
    expect(broker.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toHaveLength(enabled ? 1 : 0);
    return { responses, items: canonical([...broker.db.items.values()].filter((row) => row.entityType !== "COMPANY_MEMBERSHIP").sort((a, b) => `${String(a.pk)}/${String(a.sk)}`.localeCompare(`${String(b.pk)}/${String(b.sk)}`))) };
  } else if (name === "browser") {
    const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=/review/11111111-1111-4111-8111-111111111111"));
    responses.push(start);
    expect(start.statusCode).toBe(200);
    const link = /href="([^"]*method=slack)"/.exec(start.body)![1]!.replaceAll("&amp;", "&");
    const selected = await h.http(httpEvent("GET", link));
    const event = httpEvent("GET", h.slack.approve(selected.headers.location!, "U0SHARED"));
    responses.push(await h.http({ ...event, headers: { cookie: start.cookies![0]!.split(";")[0]! } }));
  } else {
    const registered = name === "registered-client" || name === "removed-client";
    if (registered) await h.deps.store.putClient(client);
    if (name === "removed-client") {
      await h.deps.store.removeClient(client.clientId);
      responses.push(await h.http(httpEvent("GET", authorizeQuery({ client_id: client.clientId }))));
    } else {
      if (name === "revoked-developer") {
        await h.signIn("slack", "U0SHARED");
        const developer = h.db.find((item) => item.entityType === "DEVELOPER")[0]!;
        h.db.set({ ...developer, revoked: true });
      }
      const back = await h.signIn(name === "oidc-admin" || registered ? "oidc" : "slack", name === "oidc-admin" || registered ? "person" : "U0SHARED", {
        ...(name === "wrong-team" ? { teamId: "T0OTHER" } : {}), ...(registered ? { query: { client_id: client.clientId, scope: "projects:members" } } : {}),
      });
      responses.push(back.toString());
      if (back.searchParams.has("code") && name !== "revoked-developer") {
        const exchanged = await form(h, "/v1/auth/token", { grant_type: "authorization_code", client_id: registered ? client.clientId : "agentx-cli", code: code(back), code_verifier: VERIFIER, redirect_uri: CLI_REDIRECT });
        expect(exchanged.statusCode).toBe(200); responses.push(exchanged);
        if (registered) {
          const refreshed = await form(h, "/v1/auth/token", { grant_type: "refresh_token", client_id: client.clientId, refresh_token: (JSON.parse(exchanged.body) as { refresh_token: string }).refresh_token });
          expect(refreshed.statusCode).toBe(200); responses.push(refreshed);
          responses.push(await form(h, "/v1/auth/revoke", { client_id: client.clientId, token: (JSON.parse(refreshed.body) as { refresh_token: string }).refresh_token }));
        }
      }
    }
  }
  expect(h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toHaveLength(legacy ? 1 : 0);
  return { responses, items: rows(h, enabled) };
}

// Export only normalized captures: both comparisons and ad-hoc recorders pass
// through this boundary before serialization, so raw credentials cannot be saved.
export async function capture(name: typeof GOLDEN_NAMES[number], enabled = false): Promise<unknown> {
  return normalizeGolden(await captureRaw(name, enabled));
}

it.each(GOLDEN_NAMES)("unchanged sign-in bytes and rows: %s", async (name) => {
  for (const enabled of [false, true]) {
    const actual = JSON.stringify(await capture(name, enabled));
    expect(actual, `company mode ${enabled}`).toBe(readFileSync(`tests/fixtures/signin-company-goldens/${name}.json`, "utf8").trimEnd());
  }
});


// The recorder and comparison use this same boundary.
export function normalizeGolden(value: unknown): unknown {
  const unsupported = () => new Error("unsupported golden capture");
  // One budget for the whole local capture, including strings nested inside JSON.
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw unsupported();
  } catch { throw unsupported(); }
  let visited = 0;
  const account = (depth: number) => {
    if (++visited > 20_000 || depth > 32) throw unsupported();
  };
  const jsonBudget = (input: unknown, depth: number): void => {
    account(depth);
    if (input !== null && typeof input === "object") for (const item of Object.values(input)) jsonBudget(item, depth + 1);
  };
  const references = new Map<string, number>();
  const jwts: Array<{ token: string; header: string; payload: string }> = [];
  const jwtReferences = new Map<string, string>();
  // firstSignInMark (#668, ID-STEPUP-FOLLOWUPS (a)): a random per-sign-in UUID, masked like sid and jti so both company modes compare to one golden.
  const secretField = /^(?:access[_-]?token|refresh[_-]?token|session[_-]?(?:token|id)|id[_-]?token|token|nonce|sid|jti|secret(?:Hash)?|client[_-]?secret|tokenHash|api[_-]?key|private[_-]?key|key|accessKeyId|secretAccessKey|password|firstSignInMark)$/i;
  const keyShape = new RegExp(`\\b(?:${["sk", "proj"].join("-")}-|${["gh", "p"].join("")}_|${["xox", "b"].join("")}-)[A-Za-z0-9_-]+`, "g");
  const token = (raw: string, kind = "token"): string => {
    if (raw === "") return raw; // Clearing a cookie is observable, too.
    if (!references.has(raw)) {
      if (references.size >= 512) throw unsupported();
      references.set(raw, references.size + 1);
    }
    const shape = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw) ? "uuid" : /^[a-f0-9]+$/i.test(raw) ? "hex" : /^[A-Za-z0-9_-]+$/.test(raw) ? "base64url" : "opaque";
    return `<${kind}:len=${raw.length}:shape=${shape}:ref=${references.get(raw)!}>`;
  };
  const jsonText = (text: string, depth: number): string => {
    try { jsonBudget(JSON.parse(text) as unknown, depth); } catch { throw unsupported(); }
    let field = "";
    // Replace only JSON string lexemes: whitespace, key spelling, number spelling
    // and order outside a secret string remain byte-for-byte as received.
    return text.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (lexeme: string, colon: string | undefined) => {
      if (colon !== undefined) { field = JSON.parse(lexeme.slice(0, -colon.length)) as string; return lexeme; }
      const raw = JSON.parse(lexeme) as string;
      const normalized = visit(raw, field, depth + 1);
      field = "";
      return normalized === raw ? lexeme : JSON.stringify(normalized);
    });
  };
  const jwt = (raw: string, required: boolean, depth: number): string => {
    const previous = jwtReferences.get(raw);
    if (previous !== undefined) return previous;
    const segments = raw.split(".");
    let header: string;
    let payload: string;
    try {
      if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw unsupported();
      [header, payload] = segments.slice(0, 2).map((part) => {
        const decoded = Buffer.from(part, "base64url");
        if (decoded.toString("base64url") !== part) throw unsupported();
        const text = decoded.toString("utf8");
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw unsupported();
        return text;
      }) as [string, string];
    } catch {
      if (required || raw.startsWith("eyJ")) throw unsupported();
      return raw; // Ordinary dotted URLs/names are public bytes.
    }
    const normalized = token(raw, "jwt:header.payload.signature");
    jwtReferences.set(raw, normalized);
    // Reserve the slot before normalizing claims so nested secrets keep stable refs.
    const entry = { token: `${normalized}:segments=${segments.map((part) => part.length).join(",")}`, header: "", payload: "" };
    jwts.push(entry);
    entry.header = jsonText(header, depth + 1);
    entry.payload = jsonText(payload, depth + 1);
    return normalized;
  };
  const visit = (input: unknown, field = "", depth = 0): unknown => {
    account(depth);
    if (Array.isArray(input)) return input.map((item) => visit(item, field, depth + 1));
    if (input !== null && typeof input === "object") {
      // fromEntries defines own properties, including __proto__, without assignment.
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item, key === "id" && (input as { entityType?: unknown }).entityType === "AUTH_REQUEST" ? "nonce" : key, depth + 1)]));
    }
    if (typeof input !== "string") {
      if (typeof input === "number" && !Number.isFinite(input)) throw unsupported();
      return input;
    }
    if (/^\s*[{[]/.test(input)) return jsonText(input, depth + 1);
    if (secretField.test(field) || (field === "code" && !AgentXErrorCodeSchema.safeParse(input).success)) {
      return input.split(".").length === 3 ? jwt(input, true, depth + 1) : token(input);
    }
    if (/^(?:CODE|REFRESH|SESSION|AUTHREQ)#/.test(input)) {
      const split = input.indexOf("#") + 1;
      return input.slice(0, split) + token(input.slice(split), /^(?:CODE|REFRESH)#/.test(input) ? "hash" : "token");
    }
    const secret = (raw: string) => raw.split(".").length === 3 ? jwt(raw, true, depth + 1) : token(raw);
    if (/^(?:state|clientState)$/i.test(field) && /^[A-Za-z0-9_-]{32,}$/.test(input)) return token(input);
    const text = /^(?:cookies|set-cookie)$/i.test(field)
      ? input.replace(/((?:^|;\s*)[^=;]*(?:session|pkce|token)[^=;]*=)([^;]*)/gi, (_all, prefix: string, raw: string) => prefix + secret(raw))
      : input;
    return text
      .replace(/([?&](?:code|access_token|refresh_token|session_token|nonce|state)=)([^&#]*)/gi, (_all, prefix: string, raw: string) => {
        let decoded: string;
        try { decoded = decodeURIComponent(raw); } catch { throw unsupported(); }
        return prefix + (/state=$/i.test(prefix) && !/^[A-Za-z0-9_-]{32,}$/.test(decoded) ? raw : secret(decoded));
      })
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g, (raw) => jwt(raw, false, depth + 1))
      .replace(/((?:Bearer|Basic) )([A-Za-z0-9_+/=-]+)/g, (_all, prefix: string, raw: string) => prefix + token(raw))
      .replace(keyShape, (raw) => token(raw, "key"));
  };
  return { value: visit(value), jwts };
}

const fakeOpaque = (byte = 17) => Buffer.alloc(36, byte).toString("base64url");
const fakeJwt = (claims: Record<string, unknown> = {}, signature = 9) => [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "golden", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "https://issuer.example.test", aud: ["web"], scope: "projects:members", iat: 100, exp: 400, ...claims })).toString("base64url"),
  Buffer.alloc(32, signature).toString("base64url"),
].join(".");

it("normalizes secret material everywhere while keeping string types and wire formatting", () => {
  const token = fakeOpaque();
  const jwt = fakeJwt({ sid: token });
  const input = { body: ` { "access_token" : ${JSON.stringify(jwt)}, "refresh_token":${JSON.stringify(token)}, "expires_in":300 }\n`,
    callback: `https://app.example.test/?code=${token}&keep=%2f#fragment`,
    cookies: [`session=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`],
    sessionId: token, code: token, apiKey: token, secretHash: token, nested: [jwt], untouched: 7 };
  const serialized = JSON.stringify(normalizeGolden(input));
  expect(serialized.includes(token)).toBe(false);
  expect(serialized.includes(jwt)).toBe(false);
  expect(serialized.includes("<token:")).toBe(true);
  expect(serialized.includes("<jwt:")).toBe(true);
  const normalized = normalizeGolden(input) as { value: typeof input };
  expect(typeof normalized.value.body).toBe("string");
  expect(normalized.value.body.startsWith(' { "access_token" : ')).toBe(true);
  expect(normalized.value.body.endsWith('"expires_in":300 }\n')).toBe(true);
  expect(normalized.value.callback.endsWith("&keep=%2f#fragment")).toBe(true);
  expect(normalized.value.cookies[0]!.endsWith("; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300")).toBe(true);
  expect(normalized.value.untouched).toBe(7);
});

it("compares JWT claim names, values, headers, expiry and token relationships", () => {
  const baseline = { access_token: fakeJwt({ sid: fakeOpaque() }), sessionId: fakeOpaque() };
  expect(normalizeGolden(baseline)).toEqual(normalizeGolden({ ...baseline, access_token: fakeJwt({ sid: fakeOpaque() }, 10) }));
  for (const claims of [{ aud: ["other"] }, { iss: "https://other.example.test" }, { scope: "full" }, { exp: 401 }, { extra: true }]) {
    expect(normalizeGolden(baseline)).not.toEqual(normalizeGolden({ ...baseline, access_token: fakeJwt({ sid: fakeOpaque(), ...claims }) }));
  }
  expect(normalizeGolden(baseline)).not.toEqual(normalizeGolden({ ...baseline, sessionId: fakeOpaque(18) }));
  const shortSignature = fakeJwt().split("."); shortSignature[2] = Buffer.alloc(16, 9).toString("base64url");
  expect(normalizeGolden({ access_token: fakeJwt() })).not.toEqual(normalizeGolden({ access_token: shortSignature.join(".") }));
  const changedHeader = [Buffer.from(JSON.stringify({ alg: "HS256", kid: "golden", typ: "JWT" })).toString("base64url"), ...fakeJwt().split(".").slice(1)].join(".");
  expect(normalizeGolden({ access_token: fakeJwt() })).not.toEqual(normalizeGolden({ access_token: changedHeader }));
});

it("preserves every non-secret byte, including public hashes, JSON formatting and cookie attributes", () => {
  const input = { body: ' { "scope":"full", "expires_in":300 } \n', code: "CONFIG_INVALID", developerId: "d".repeat(64), codeChallenge: fakeOpaque(), cookies: ["session=; Secure; HttpOnly"] };
  expect(normalizeGolden(input)).toEqual({ value: input, jwts: [] });
  for (const changed of [{ ...input, body: input.body.replace("300", "301") }, { ...input, body: input.body.trim() }, { ...input, cookies: ["session=; Secure"] }]) {
    expect(normalizeGolden(input)).not.toEqual(normalizeGolden(changed));
  }
});

it("refuses malformed JWT/JSON without echoing input and bounds the entire capture", () => {
  const canary = fakeOpaque();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const header = Buffer.from("{}").toString("base64url");
  const noncanonical = header.slice(0, -1) + alphabet[alphabet.indexOf(header.at(-1)!) + 1]!;
  const badHeader = [noncanonical, ...fakeJwt().split(".").slice(1)].join(".");
  for (const input of [{ access_token: badHeader }, { access_token: ["bad", canary, "sig"].join(".") }, { body: `{ "access_token": "${canary}"` }, "x".repeat(1_048_577)]) {
    expect(() => normalizeGolden(input)).toThrow("unsupported golden capture");
  }
});


it("normalizes opaque credentials in encoded queries, cookies, headers, keys and storage references", () => {
  const raw = fakeOpaque();
  const key = ["sk", "proj", raw].join("-");
  const session = ["00000000", "0000", "4000", "8000", "1".repeat(12)].join("-");
  const normalized = JSON.stringify(normalizeGolden({
    callback: `https://app.example.test/?access_token=${encodeURIComponent(fakeJwt())}&state=cli-state&keep=%2f`,
    headers: { authorization: `Bearer ${raw}`, other: `Basic ${Buffer.from(raw).toString("base64")}`, "set-cookie": `session=${session}; Secure; HttpOnly` },
    cookies: [`session=${fakeJwt()}; Secure`], message: `key ${key} end`,
    items: [{ pk: `SESSION#${session}`, sessionId: session }, { pk: `REFRESH#${raw}`, tokenHash: raw }, { entityType: "AUTH_REQUEST", id: raw, nonce: raw, pk: `AUTHREQ#${raw}`, clientState: raw }],
  }));
  for (const material of [raw, key, session, fakeJwt()]) expect(normalized.includes(material)).toBe(false);
  expect(normalized.includes("state=cli-state&keep=%2f")).toBe(true);
  expect(normalized.includes("header.payload.signature")).toBe(true);
  expect(normalized.includes("; Secure; HttpOnly")).toBe(true);
  expect(normalized.includes("key <key:")).toBe(true);
});

it("handles the full byte budget promptly and refuses aggregate item, token and depth overflow", () => {
  // A scaling check, not a wall-clock bound: the cost of the full-budget string must stay linear (8 x 131,071 = 1,048,568 bytes, the budget's own size).
  expectLinearScaling((n) => { const part = "x".repeat(n); return () => normalizeGolden(part); }, { n: 131_071, label: "normalizeGolden on a string at the byte budget" });
  const text = "x".repeat(1_048_574);
  expect(normalizeGolden(text)).toEqual({ value: text, jwts: [] });
  let deep: unknown = "leaf";
  for (let n = 0; n < 34; n++) deep = [deep];
  for (const value of [Array.from({ length: 20_001 }, () => 0), JSON.stringify(Array.from({ length: 20_001 }, () => 0)), JSON.stringify(deep), Array.from({ length: 513 }, (_, n) => ({ token: `runtime-${n}` })), deep, { value: Infinity }]) {
    expect(() => normalizeGolden(value)).toThrow("unsupported golden capture");
  }
  const object = JSON.parse('{"__proto__":{"safe":true},"key":"runtime"}') as Record<string, unknown>;
  expect(JSON.stringify(normalizeGolden({ sessionId: ["00000000", "0000", "4000", "8000", "1".repeat(12)].join("-") }))).toContain("shape=uuid");
  const result = normalizeGolden(object) as { value: Record<string, unknown> };
  expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
});


it("normalizes captures before callers can compare or record them", async () => {
  const captured = await capture("slack") as { value: unknown; jwts: unknown[] };
  expect(Object.hasOwn(captured, "value")).toBe(true);
  expect(captured.jwts).toHaveLength(1);
  expect(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(JSON.stringify(captured))).toBe(false);
});

it("normalizes opaque codes even when their spelling resembles an error label", () => {
  const code = ["RUNTIME", fakeOpaque()].join("_");
  expect(JSON.stringify(normalizeGolden({ code })).includes(code)).toBe(false);
});
