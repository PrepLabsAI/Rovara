// The connection store on the document store port: what a record holds and does not hold, how a secret is kept apart, what a change writes together, and the rules a save refuses.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type AuditEvent, type AuditSink, type OrgId } from "@rovara-code/contracts";
import { OrgConnectionStore, readConnectionSecret, readConnectionToken, type ConnectionChecks } from "../../packages/core/src/connections/store.js";
import { orgCredentialRegistry } from "../../packages/core/src/connections/registry.js";
import { orgConnectorSecretName } from "../../packages/core/src/connections/org-secrets.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "local";
const OWNER = "a".repeat(64);
const LINEAR = "con_aaaaaaaaaaaaaaaaaaaa";
const SENTRY = "con_bbbbbbbbbbbbbbbbbbbb";
const KEY = ["lin", "api", "NOTAREALKEY0123456789"].join("_");

function world(over: { checks?: ConnectionChecks; audit?: AuditSink; fetch?: typeof fetch } = {}) {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const events: AuditEvent[] = [];
  const audit: AuditSink = over.audit ?? { stage: (event) => { events.push(event); return []; }, record: async (event) => { events.push(event); } };
  const deps = { store: db, env: ENV, secrets, now: () => Date.parse("2026-11-10T10:00:00Z") };
  const store = new OrgConnectionStore({ ...deps, audit, checkEndpoint: async () => undefined, ...(over.checks === undefined ? {} : { checks: over.checks }), ...(over.fetch === undefined ? {} : { fetch: over.fetch }) });
  return { db, secrets, deps, store, events };
}
const linear = (over: Record<string, unknown> = {}) => ({ connectionId: LINEAR, type: "linear", label: "Tracker", access: "read", ...over });

describe("saving a connection", () => {
  it("keeps the record free of the key, writes the key under a name derived from the company and the id, and records one audit event without it", async () => {
    const w = world();
    const saved = await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER });
    expect(saved).toMatchObject({ connectionId: LINEAR, hasSecret: true, createdBy: OWNER });
    // The record keeps its revision and the version of its secret, and a view shows neither.
    expect(saved).not.toHaveProperty("revision");
    expect(saved).not.toHaveProperty("secretVersion");
    const raw = await w.db.get({ pk: `ORG#${ORG}#CONNECTION#${LINEAR}`, sk: "META" });
    expect(raw).toMatchObject({ revision: 1 });
    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(raw).toHaveProperty("secretVersion");
    expect(w.secrets.names()).toEqual([orgConnectorSecretName(ENV, ORG, LINEAR)]);
    expect(await readConnectionToken(w.deps, ORG, { connectionId: LINEAR, type: "linear", secretVersion: String(raw!["secretVersion"] as string) })).toBe(KEY);
    expect(w.events.map((event) => [event.action, event.subject])).toEqual([["connection.saved", { type: "connection", id: LINEAR }]]);
    expect(JSON.stringify(w.events)).not.toContain(KEY);
    // The directory lists it, so a listing reads one partition and then the records.
    expect((await w.store.list(ORG)).map((record) => record.connectionId)).toEqual([LINEAR]);
    expect(await w.store.list(OTHER)).toEqual([]);
  });

  it("reads the version its own save wrote: a later save that was refused cannot change what a record uses", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER });
    const version = ((await w.db.get({ pk: `ORG#${ORG}#CONNECTION#${LINEAR}`, sk: "META" }))!["secretVersion"] as string);
    // A secret written by a save that never committed (a lost race) is a newer version nothing refers to.
    await w.secrets.put(ORG, orgConnectorSecretName(ENV, ORG, LINEAR), JSON.stringify({ apiKey: "lin_api_somebodyelses" }));
    expect((await readConnectionSecret(w.deps, ORG, { connectionId: LINEAR, type: "linear", secretVersion: version }))).toEqual({ apiKey: KEY });
  });

  it("refuses a company's id for another company's secret, and an id that is not a connection id", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER });
    expect(await w.store.get(OTHER, LINEAR)).toBeUndefined();
    await expect(w.secrets.read(OTHER, orgConnectorSecretName(ENV, ORG, LINEAR))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.store.put({ orgId: "not-an-org", connection: linear(), by: OWNER })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await w.store.get(ORG, "../../etc")).toBeUndefined();
  });

  it("refuses a field the kind does not take without repeating it, a write-capable monitoring connection, and a secret of the wrong shape", async () => {
    const w = world();
    await expect(w.store.put({ orgId: ORG, connection: { ...linear(), apiKeyInBody: KEY }, by: OWNER })).rejects.toSatisfy((error: Error) => error.message.includes("has a field this kind of connection does not take") && !error.message.includes(KEY));
    await expect(w.store.put({ orgId: ORG, connection: { connectionId: SENTRY, type: "sentry", label: "S", access: "read_write", region: "us", orgSlug: "acme" }, by: OWNER })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("read-only") as string });
    await expect(w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY, extra: "x" }, by: OWNER })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.store.put({ orgId: ORG, connection: { connectionId: SENTRY, type: "cloudwatch", label: "C", access: "read", roleArn: "arn:aws:iam::123456789012:role/rovara", regions: ["us-east-1"] }, secret: { token: "x" }, by: OWNER })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("takes no secret") as string });
    expect(w.secrets.calls).toEqual([]);
    expect(await w.store.list(ORG)).toEqual([]);
  });

  it("will not send a saved secret to a different host: moving the site needs the new secret with it, and a type cannot change", async () => {
    const w = world();
    const jira = (siteUrl: string) => ({ connectionId: LINEAR, type: "jira", label: "J", access: "read", siteUrl });
    await w.store.put({ orgId: ORG, connection: jira("https://one.atlassian.net"), secret: { email: "me@example.com", apiToken: KEY }, by: OWNER });
    await expect(w.store.put({ orgId: ORG, connection: jira("https://two.atlassian.net"), by: OWNER })).rejects.toMatchObject({ message: expect.stringContaining("different host") as string });
    await w.store.put({ orgId: ORG, connection: jira("https://two.atlassian.net"), secret: { email: "me@example.com", apiToken: KEY }, by: OWNER });
    expect(await w.db.get({ pk: `ORG#${ORG}#CONNECTION#${LINEAR}`, sk: "META" })).toMatchObject({ revision: 2, siteUrl: "https://two.atlassian.net" });
    await expect(w.store.put({ orgId: ORG, connection: linear(), by: OWNER })).rejects.toMatchObject({ message: expect.stringContaining("type cannot change") as string });
  });

  it("makes a save repeatable by its request id, and refuses the same id for another change", async () => {
    const w = world();
    const request = { orgId: ORG, developerId: OWNER, requestId: "11111111-1111-4111-8111-111111111111", fingerprint: "f1" };
    await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER, requestId: request.requestId, request });
    // The mark was written with the change: the same id for a different body is refused, and nothing it asked is written.
    await expect(w.store.put({ orgId: ORG, connection: linear({ label: "Other" }), secret: { apiKey: KEY }, by: OWNER, requestId: request.requestId, request: { ...request, fingerprint: "f2" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a save made from a record that moved since it was read", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER });
    await expect(w.store.put({ orgId: ORG, connection: linear({ label: "Late" }), by: OWNER, expectRevision: 0 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await w.store.put({ orgId: ORG, connection: linear({ label: "Fresh" }), by: OWNER, expectRevision: 1 })).label).toBe("Fresh");
  });

  it("is not told a lie by a failed audit: no event is staged for a refused save", async () => {
    const w = world();
    await expect(w.store.put({ orgId: ORG, connection: { ...linear(), access: "admin" }, by: OWNER })).rejects.toBeDefined();
    expect(w.events).toEqual([]);
  });
});

describe("removing a connection", () => {
  it("removes the record, its directory entry and its key together, and audits it once", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: linear(), secret: { apiKey: KEY }, by: OWNER });
    await w.store.remove({ orgId: ORG, connectionId: LINEAR, by: OWNER });
    expect(await w.store.get(ORG, LINEAR)).toBeUndefined();
    expect((await w.db.query({ pk: `ORG#${ORG}#CONNECTIONS` })).items).toEqual([]);
    expect(w.secrets.names()).toEqual([]);
    expect(w.events.map((event) => event.action)).toEqual(["connection.saved", "connection.removed"]);
    await expect(w.store.remove({ orgId: ORG, connectionId: LINEAR, by: OWNER })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("says who removed it: nothing is recorded without an actor", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: linear(), by: OWNER });
    await expect(w.store.remove({ orgId: ORG, connectionId: LINEAR, by: "" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("checking a connection", () => {
  it("records what the vendor said and the account it belongs to, without the account in any view, and keeps a secret out of a message", async () => {
    const w = world({ checks: { sentry: async () => ({ ok: false, message: `token ${KEY} was refused`, actorId: "acct-1" }) } });
    await w.store.put({ orgId: ORG, connection: { connectionId: SENTRY, type: "sentry", label: "S", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: KEY }, by: OWNER });
    const result = await w.store.check(ORG, SENTRY);
    expect(result).toEqual({ ok: false, message: "token [redacted] was refused" });
    expect((await w.store.get(ORG, SENTRY))!.lastCheck).toMatchObject({ ok: false });
    expect(JSON.stringify(await w.store.get(ORG, SENTRY))).not.toContain("acct-1");
  });

  it("says a check is not available for a kind with no adapter, and that a connection with no saved key has none to check", async () => {
    const w = world({ checks: {} });
    await w.store.put({ orgId: ORG, connection: { connectionId: SENTRY, type: "sentry", label: "S", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: KEY }, by: OWNER });
    expect((await w.store.check(ORG, SENTRY)).message).toContain("not available");
    await w.store.put({ orgId: ORG, connection: linear(), by: OWNER });
    expect(await w.store.check(ORG, LINEAR)).toEqual({ ok: false, message: "no secret has been saved for this connection yet" });
  });
});

describe("the credential registry of a company", () => {
  it("serves a connection with a saved key, pins its token to the vendor's host, and refuses a write on a read-only connection", async () => {
    const w = world();
    await w.store.put({ orgId: ORG, connection: { connectionId: SENTRY, type: "sentry", label: "S", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: KEY }, by: OWNER });
    const registry = orgCredentialRegistry(w.deps, ORG);
    expect(await registry.has(SENTRY)).toBe(true);
    expect(await registry.registration(SENTRY)).toMatchObject({ ref: SENTRY, type: "static-secret", host: "us.sentry.io" });
    await expect(registry.provider(SENTRY).issue({}, "write", { kind: "member", id: "x" } as never)).rejects.toThrow(/read-only/);
    expect(await orgCredentialRegistry(w.deps, OTHER.toString()).has(SENTRY)).toBe(false);
  });
});
