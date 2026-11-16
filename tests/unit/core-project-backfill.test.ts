import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { listProjectMembers, projectMemberKey } from "../../packages/broker/src/aws/admin-actions.js";
import { backfillCorePage, checkCorePeople, planCoreProjectWrites } from "../../packages/broker/src/aws/core-project-backfill.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const personId = "a".repeat(64);
const at = "2026-11-15T12:00:00.000Z";
const definition = (revision = 1) => ({ name: "web", revision, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." });
const legacy = (revision = 1, companyId?: string) => ({ pk: "PROJECT#web", sk: `REV#${String(revision).padStart(12, "0")}`, entityType: "PROJECT", definition: definition(revision), registeredAt: at, ...(companyId === undefined ? {} : { companyId }) });
const input = { companyId: A, projectNames: ["web"], bindings: [], people: [], grants: [] };
function setup() {
  const db = new FakeDynamoDb();
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const deps = { tableName: "state", signInTableName: "signin", now: () => Date.parse(at), documentClient: { async send(command: unknown) { const c = command as { constructor: { name: string }; input: Record<string, unknown> }; commands.push({ name: c.constructor.name, input: c.input }); return db.send(command as never); } } };
  db.set(legacy());
  return { db, deps, commands };
}
it("maps an unowned legacy project only to explicit A, without inspecting same-named B", async () => {
  const { db, deps, commands } = setup();
  db.set({ ...legacy(), ...projectRevisionKey(B, "web", 1), companyId: B });
  const b = db.get(projectRevisionKey(B, "web", 1).pk, legacy().sk);
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ written: 1, failed: 0, more: false });
  expect(db.get(projectRevisionKey(A, "web", 1).pk, legacy().sk)?.definition).toEqual(definition());
  expect(db.get(projectRevisionKey(B, "web", 1).pk, legacy().sk)).toEqual(b);
  expect(JSON.stringify(commands)).not.toContain(`ORG#${B}`);
  expect(db.get("PROJECT#web", legacy().sk)).toEqual(legacy());
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ written: 0, skippedExisting: 1 });
});
it.each(["source", "revision", "catalog"])("refuses conflicting %s ownership/content without overwriting", async kind => {
  const { db, deps } = setup();
  if (kind === "source") db.set(legacy(1, B));
  if (kind === "revision") db.set({ ...legacy(), ...projectRevisionKey(A, "web", 1), companyId: B });
  if (kind === "catalog") db.set({ ...orgProjectCatalogKey(A, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1, companyId: B });
  const before = [...db.items];
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ skippedConflict: 1, written: 0 });
  expect([...db.items]).toEqual(before);
});
it("previews the full plan without writing projects, bindings, memberships or grants", async () => {
  const { db, deps, commands } = setup(); seedPerson(db);
  const before = [...db.items];
  const result = await backfillCorePage(deps, { ...operatorInput(), dryRun: true });
  expect(result).toMatchObject({ written: 4, failed: 0, more: false });
  expect([...db.items]).toEqual(before);
  expect(commands.every(c => c.name === "GetCommand" || c.name === "QueryCommand")).toBe(true);
});
it.each([{}, { ...input, companyId: B + "#bad" }, { ...input, projectNames: ["web", "web"] }, { ...input, companyId: undefined }, { ...input, grants: [{ personId, projectName: "web", role: "administrator" }] }, { ...input, dryRun: "false" }, { ...input, bindings: [{ installationId: 0, accountLogin: "example" }] }, { ...input, people: [{ personId, role: "invented" }] }, { ...input, people: [{ personId: "bad", role: "member" }] }])("refuses the entire invalid mapping before any I/O", async value => {
  const { deps, commands } = setup();
  expect(await backfillCorePage(deps, value)).toMatchObject({ refused: "invalid_input", written: 0 });
  expect(commands).toEqual([]);
});
it("bounds pages and binds an opaque validated continuation to the entire mapping", async () => {
  const { db, deps } = setup(); db.set(legacy(2));
  const first = await backfillCorePage(deps, { ...input, dryRun: false, limit: 1 });
  expect(first).toMatchObject({ scanned: 1, written: 1, more: true });
  expect(typeof first.continuation).toBe("string");
  expect(await backfillCorePage(deps, { ...input, dryRun: false, continuation: first.continuation })).toMatchObject({ written: 1, more: false });
  for (const continuation of ["bad", "x".repeat(4097), first.continuation]) {
    expect(await backfillCorePage(deps, { ...input, companyId: B, dryRun: false, continuation })).toMatchObject({ refused: "invalid_input" });
  }
});
it("resumes after failure before or after every I/O step with no loss or overwrite", async () => {
  const control = setup(); await backfillCorePage(control.deps, { ...input, dryRun: false });
  for (const after of [false, true]) for (let fail = 1; fail <= control.commands.length; fail++) {
    const { db, deps } = setup(); let step = 0;
    const client = deps.documentClient;
    const broken = { ...deps, documentClient: { async send(command: unknown) {
      const hit = ++step === fail;
      if (hit && !after) throw new Error("private-canary");
      const answer = await client.send(command);
      if (hit && after) throw new Error("private-canary");
      return answer;
    } } };
    const answer = await backfillCorePage(broken, { ...input, dryRun: false });
    expect(JSON.stringify(answer)).not.toContain("private-canary");
    await backfillCorePage(deps, { ...input, dryRun: false });
    expect(db.get(projectRevisionKey(A, "web", 1).pk, legacy().sk)?.definition).toEqual(definition());
    expect(db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")?.latestRevision).toBe(1);
    expect(db.get("PROJECT#web", legacy().sk)).toEqual(legacy());
  }
});
function seedPerson(db: FakeDynamoDb) { db.set({ pk: `DEVELOPER#${personId}`, sk: "META", entityType: "DEVELOPER", developerId: personId, provider: "oidc", issuer: "https://example.test", subject: "person", firstSignInAt: at, revoked: false }); }
function operatorInput() { return { ...input, bindings: [{ installationId: 42, accountLogin: "example" }], people: [{ personId, role: "member" }], grants: [{ personId, projectName: "web", role: "developer" }] }; }
it("reports people gaps read-only, then writes only explicit valid people and grants", async () => {
  const { db, deps } = setup(); seedPerson(db);
  const before = [...db.items];
  expect(await checkCorePeople(deps, operatorInput())).toMatchObject({ gaps: [{ person: 0, reason: "membership_missing" }, { grant: 0, reason: "grant_missing" }] });
  expect([...db.items]).toEqual(before);
  expect(await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).toMatchObject({ written: 4, failed: 0 });
  expect(await checkCorePeople(deps, operatorInput())).toMatchObject({ gaps: [] });
  expect(db.get(`COMPANY_MEMBER#${personId}`, "COMPANY")).toMatchObject({ companyId: A, role: "member" });
  expect(await listProjectMembers({ tableName: "state", documentClient: deps.documentClient } as never, "web")).toEqual([{ developerId: personId, role: "developer", grantedAt: at }]);
  expect(db.get(projectMemberKey("web", personId).pk, projectMemberKey("web", personId).sk)).toEqual({ ...projectMemberKey("web", personId), entityType: "PROJECT_MEMBER", role: "developer", grantedAt: at });
  expect(await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).toMatchObject({ written: 0, skippedExisting: 4 });
});
it("refuses a reverse member row with a different role without changing either row", async () => {
  const { db, deps } = setup(); seedPerson(db);
  db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", companyId: A, personId, role: "member", joinedAt: at });
  const key = projectMemberKey("web", personId);
  const foreignRole = { ...key, entityType: "PROJECT_MEMBER", role: "administrator", grantedAt: at };
  db.set(foreignRole);
  const before = db.get(key.pk, key.sk);
  expect(await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).toMatchObject({ skippedConflict: 1, written: 2 });
  expect(db.get(key.pk, key.sk)).toEqual(before);
  expect(db.get(`MEMBER#${personId}`, "PROJECT#web")).toBeUndefined();
});
it("never invents membership for an unknown/revoked person or overwrites foreign membership", async () => {
  for (const kind of ["unknown", "revoked", "foreign"]) {
    const { db, deps } = setup();
    if (kind !== "unknown") seedPerson(db);
    if (kind === "revoked") db.set({ ...db.get(`DEVELOPER#${personId}`, "META")!, revoked: true });
    if (kind === "foreign") db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", companyId: B, personId, role: "member", joinedAt: at });
    const before = db.get(`COMPANY_MEMBER#${personId}`, "COMPANY");
    const outcome = await backfillCorePage(deps, { ...operatorInput(), dryRun: false });
    expect(outcome.issues).toContainEqual({ phase: 2, index: 0, reason: "conflict" });
    expect(db.get(`COMPANY_MEMBER#${personId}`, "COMPANY")).toEqual(before);
    expect(db.get(`MEMBER#${personId}`, "PROJECT#web")).toBeUndefined();
  }
});
it("uses the existing binding writer and never steals an installation", async () => {
  const { db, deps } = setup();
  const foreign = { pk: "GITHUB_INSTALLATION#42", sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", installationId: 42, accountLogin: "example", companyId: B, boundAt: at, boundBy: "operator-lambda" };
  db.set(foreign);
  expect((await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).issues).toContainEqual({ phase: 1, index: 0, reason: "conflict" });
  expect(db.get(foreign.pk, foreign.sk)).toEqual(foreign);
});
it("forward planning skips unknown companies and copies known companies in the caller transaction", async () => {
  const { db, deps, commands } = setup();
  expect(await planCoreProjectWrites(deps, legacy())).toMatchObject({ status: "unknown_company", writes: [] });
  expect(commands).toEqual([]);
  for (const companyId of [A, B]) {
    const source = legacy(1, companyId);
    const plan = await planCoreProjectWrites(deps, source);
    expect(plan.status).toBe("ready");
    await db.send(new TransactWriteCommand({ TransactItems: plan.writes }));
    expect(db.get(projectRevisionKey(companyId, "web", 1).pk, source.sk)?.definition).toEqual(definition());
  }
});
it("refuses oversized input quickly and reports storage/time failures with fixed words", async () => {
  const { deps, commands } = setup();
  const started = performance.now();
  expect(await backfillCorePage(deps, { ...input, projectNames: Array.from({ length: 10_000 }, (_, i) => `p${i}`), dryRun: true })).toMatchObject({ refused: "invalid_input" });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(commands).toEqual([]);
  let time = 0;
  const timed = { ...deps, now: () => time, documentClient: { async send(command: unknown) { const response = await deps.documentClient.send(command); time += 5001; return response; } } };
  expect(await backfillCorePage(timed, { ...input, dryRun: false })).toMatchObject({ failed: 1, more: true });
});
it("refuses changed content at the own-company revision", async () => {
  const { db, deps } = setup();
  db.set({ ...legacy(), ...projectRevisionKey(A, "web", 1), definition: { ...definition(), orchestratorInstructions: "different" } });
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ skippedConflict: 1, written: 0 });
});
it("does not advance catalog until revision copy verifies and recovers a failed verification", async () => {
  const { db, deps } = setup();
  const key = projectRevisionKey(A, "web", 1);
  db.injectFault({ command: "TransactWriteCommand", error: { name: "Timeout", message: "private-canary" } });
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ failed: 1, more: true });
  expect(db.get(orgProjectCatalogKey(A, "web").pk, "PROJECT#web")).toBeUndefined();
  await backfillCorePage(deps, { ...input, dryRun: false });
  expect(db.get(key.pk, key.sk)?.definition).toEqual(definition());
});
it("conditional target writes reject a concurrent foreign revision and binding claim", async () => {
  const { db, deps } = setup();
  const plan = await planCoreProjectWrites(deps, legacy(1, A));
  const foreign = { ...legacy(1, B), ...projectRevisionKey(A, "web", 1) };
  db.set(foreign);
  await expect(db.send(new TransactWriteCommand({ TransactItems: plan.writes }))).rejects.toThrow();
  expect(db.get(foreign.pk, foreign.sk)).toEqual(foreign);
  const other = setup(); let raced = false;
  const original = other.deps.documentClient;
  other.deps.documentClient = { async send(command: unknown) {
    const c = command as { constructor: { name: string }; input: { TransactItems?: unknown } };
    if (!raced && c.constructor.name === "TransactWriteCommand" && JSON.stringify(c.input.TransactItems).includes("GITHUB_INSTALLATION#42")) {
      raced = true; other.db.set({ pk: "GITHUB_INSTALLATION#42", sk: "BINDING", companyId: B });
    }
    return original.send(command);
  } };
  expect(await backfillCorePage(other.deps, { ...operatorInput(), dryRun: false })).toMatchObject({ failed: 1 });
  expect(other.db.get("GITHUB_INSTALLATION#42", "BINDING")?.companyId).toBe(B);
});
it("a catalog at an earlier revision must have matching content before advancing", async () => {
  const { db, deps } = setup();
  db.set({ ...orgProjectCatalogKey(A, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  db.set({ ...legacy(), ...projectRevisionKey(A, "web", 1), definition: { ...definition(), orchestratorInstructions: "unrelated core project" } });
  await expect(planCoreProjectWrites(deps, legacy(2, A))).rejects.toThrow("core project conflict");
});
it("read-only people check reports foreign, revoked and malformed grant rows without writes", async () => {
  const { db, deps, commands } = setup(); seedPerson(db);
  db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", companyId: B, personId, role: "member", joinedAt: at, revokedAt: at });
  db.set({ pk: `MEMBER#${personId}`, sk: "PROJECT#web", entityType: "wrong", ownerKey: personId, projectName: "web", role: "developer" });
  expect(await checkCorePeople(deps, operatorInput())).toMatchObject({ gaps: [{ person: 0, reason: "membership_conflict" }, { grant: 0, reason: "grant_conflict" }] });
  expect(commands.every(c => c.name === "GetCommand")).toBe(true);
});
it("supports the maximum mapping over bounded pages and refuses malformed cursor fields", async () => {
  const { db, deps } = setup();
  const names = Array.from({ length: 100 }, (_, i) => `project-${i}`);
  for (const name of names) db.set({ ...legacy(), pk: `PROJECT#${name}`, definition: { ...definition(), name } });
  let continuation: string | undefined, scanned = 0;
  for (let page = 0; page < 4; page++) {
    const answer = await backfillCorePage(deps, { ...input, projectNames: names, dryRun: true, ...(continuation === undefined ? {} : { continuation }) });
    expect(answer).toMatchObject({ scanned: 25, written: 25, failed: 0, more: page < 3 });
    scanned += answer.scanned; continuation = answer.continuation;
  }
  expect(scanned).toBe(100);
  const first = await backfillCorePage(deps, { ...input, projectNames: names, dryRun: true, limit: 1 });
  const cursor = JSON.parse(Buffer.from(first.continuation!, "base64url").toString()) as Record<string, unknown>;
  for (const changes of [{ phase: 4 }, { index: 100 }, { after: "ORG#foreign" }, { version: 2 }, { extra: "private-canary" }]) {
    const answer = await backfillCorePage(deps, { ...input, projectNames: names, dryRun: true, continuation: Buffer.from(JSON.stringify({ ...cursor, ...changes })).toString("base64url") });
    expect(answer).toMatchObject({ refused: "invalid_input" });
    expect(JSON.stringify(answer)).not.toContain("private-canary");
  }
});
it("does not follow or grant absent people when only projects were supplied", async () => {
  const { db, deps, commands } = setup(); seedPerson(db);
  await backfillCorePage(deps, { ...input, dryRun: false });
  expect(db.get(`COMPANY_MEMBER#${personId}`, "COMPANY")).toBeUndefined();
  expect(JSON.stringify(commands)).not.toContain("DEVELOPER#");
});
it("bounds total returned bytes and items before any write", async () => {
  for (const response of [{ Items: [legacy()], padding: "x".repeat(2_000_001) }, { Items: Array.from({ length: 501 }, () => legacy()) }]) {
    const { deps } = setup(); let writes = 0;
    const limited = { ...deps, documentClient: { async send(command: unknown) { if ((command as { constructor: { name: string } }).constructor.name !== "QueryCommand") writes++; return response; } } };
    expect(await backfillCorePage(limited, { ...input, dryRun: false })).toMatchObject({ failed: 1, written: 0, more: true });
    expect(writes).toBe(0);
  }
});
it.each([{ companyId: "bad" }, { entityType: "OTHER" }, { definition: { name: "web" } }])("refuses malformed stored source with fixed reporting", async changes => {
  const { db, deps } = setup(); db.set({ ...legacy(), ...changes });
  const result = await backfillCorePage(deps, { ...input, dryRun: false });
  expect(result).toMatchObject({ skippedConflict: 1, written: 0 });
  expect(result.issues).toEqual([{ phase: 0, index: 0, reason: "conflict" }]);
});
it("preview detects an orphaned binding claim audit before promising a write", async () => {
  const { db, deps } = setup();
  db.set({ pk: "GITHUB_INSTALLATION#42", sk: "AUDIT#CLAIM", companyId: B });
  const result = await backfillCorePage(deps, { ...input, bindings: [{ installationId: 42, accountLogin: "example" }], dryRun: true });
  expect(result).toMatchObject({ written: 1, skippedConflict: 1 });
  expect(result.issues).toContainEqual({ phase: 1, index: 0, reason: "conflict" });
});
it("keeps existing catalog metadata when advancing a verified project", async () => {
  const { db, deps } = setup();
  await backfillCorePage(deps, { ...input, dryRun: false });
  const key = orgProjectCatalogKey(A, "web");
  db.set({ ...db.get(key.pk, key.sk)!, firstRegisteredAt: at });
  db.set(legacy(2));
  await backfillCorePage(deps, { ...input, dryRun: false });
  expect(db.get(key.pk, key.sk)).toMatchObject({ firstRegisteredAt: at, latestRevision: 2 });
});
it("does not restore a revoked same-company membership or invent a role change", async () => {
  for (const change of [{ revokedAt: at }, { role: "admin" }]) {
    const { db, deps } = setup(); seedPerson(db);
    const row = { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", companyId: A, personId, role: "member", joinedAt: at, ...change };
    db.set(row);
    const result = await backfillCorePage(deps, { ...operatorInput(), dryRun: false });
    expect(result.issues).toContainEqual({ phase: 2, index: 0, reason: "conflict" });
    expect(db.get(row.pk, row.sk)).toEqual(row);
    expect(db.get(`MEMBER#${personId}`, "PROJECT#web")).toBeUndefined();
  }
});
it("uses the sign-in table for existing people and memberships, State for grants", async () => {
  const state = new FakeDynamoDb(), signin = new FakeDynamoDb();
  seedPerson(signin); state.set(legacy());
  const deps = { tableName: "state", signInTableName: "signin", now: () => Date.parse(at), documentClient: { async send(command: unknown) {
    const c = command as { constructor: { name: string }; input: { TableName?: string; TransactItems?: Array<Record<string, { TableName?: string }>> } };
    if (c.constructor.name === "TransactWriteCommand") {
      // This test is read-only; fail before any write if the checker mutates.
      throw new Error("unexpected write");
    }
    return (c.input.TableName === "signin" ? signin : state).send(command as never);
  } } };
  signin.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", companyId: A, personId, role: "member", joinedAt: at });
  state.set({ pk: `MEMBER#${personId}`, sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: personId, projectName: "web", role: "developer" });
  expect(await checkCorePeople(deps, operatorInput())).toEqual({ gaps: [] });
});
it("refuses a malformed existing person before previewing membership", async () => {
  const { db, deps } = setup();
  db.set({ pk: `DEVELOPER#${personId}`, sk: "META", entityType: "DEVELOPER", provider: "oidc", revoked: false });
  const result = await backfillCorePage(deps, { ...input, people: [{ personId, role: "member" }], dryRun: true });
  expect(result).toMatchObject({ written: 1, skippedConflict: 1 });
});

it("defaults omitted dryRun to a write-free preview", async () => {
  const { db, deps } = setup(), before = [...db.items];
  expect(await backfillCorePage(deps, input)).toMatchObject({ written: 1 });
  expect([...db.items]).toEqual(before);
});
it("replays crashes before and after every operator-package step, including claims and access writes", async () => {
  const control = setup(); seedPerson(control.db);
  expect(await backfillCorePage(control.deps, { ...operatorInput(), dryRun: false })).toMatchObject({ written: 4 });
  for (const after of [false, true]) for (let fail = 1; fail <= control.commands.length; fail++) {
    const { db, deps } = setup(); seedPerson(db); let step = 0;
    const original = deps.documentClient;
    const broken = { ...deps, documentClient: { async send(command: unknown) {
      const hit = ++step === fail;
      if (hit && !after) throw new Error("private-canary");
      const result = await original.send(command);
      if (hit && after) throw new Error("private-canary");
      return result;
    } } };
    const failed = await backfillCorePage(broken, { ...operatorInput(), dryRun: false });
    expect(JSON.stringify(failed)).not.toContain("private-canary");
    expect(await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).toMatchObject({ failed: 0, skippedConflict: 0, more: false });
    expect(await backfillCorePage(deps, { ...operatorInput(), dryRun: false })).toMatchObject({ written: 0, skippedExisting: 4 });
    expect(await checkCorePeople(deps, operatorInput())).toEqual({ gaps: [] });
    expect(db.get("GITHUB_INSTALLATION#42", "BINDING")?.companyId).toBe(A);
    expect(db.get("GITHUB_INSTALLATION#42", "AUDIT#CLAIM")?.companyId).toBe(A);
    expect(db.get("PROJECT#web", legacy().sk)).toEqual(legacy());
  }
});
it("refuses preview continuations in apply mode and continuations from another table", async () => {
  const { db, deps } = setup(); db.set(legacy(2));
  const preview = await backfillCorePage(deps, { ...input, dryRun: true, limit: 1 });
  expect(await backfillCorePage(deps, { ...input, dryRun: false, continuation: preview.continuation })).toMatchObject({ refused: "invalid_input" });
  expect(await backfillCorePage({ ...deps, tableName: "different" }, { ...input, dryRun: true, continuation: preview.continuation })).toMatchObject({ refused: "invalid_input" });
});
it("accepts safe integer revisions supported by the existing key writer", async () => {
  const { db, deps } = setup(); db.set(legacy(Number.MAX_SAFE_INTEGER));
  const answer = await backfillCorePage(deps, { ...input, dryRun: false });
  expect(answer).toMatchObject({ written: 2, skippedConflict: 0, failed: 0 });
  const key = projectRevisionKey(A, "web", Number.MAX_SAFE_INTEGER);
  expect(db.get(key.pk, key.sk)?.definition).toMatchObject({ revision: Number.MAX_SAFE_INTEGER });
});
it("refuses inconsistent metadata already present on the own-company revision", async () => {
  const { db, deps } = setup();
  db.set({ ...legacy(), ...projectRevisionKey(A, "web", 1), registeredAt: "2026-11-14T12:00:00.000Z" });
  const before = [...db.items];
  expect(await backfillCorePage(deps, { ...input, dryRun: false })).toMatchObject({ skippedConflict: 1, written: 0 });
  expect([...db.items]).toEqual(before);
});
