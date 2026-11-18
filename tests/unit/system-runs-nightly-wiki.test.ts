// L4-SR1: the NIGHTLY WIKI REFRESH runs by itself under the upkeep cap, behind the two locks (the operator's ceiling AND the company's consent) and the project's own upkeep switch.
// Rules under test, each with its own failing case (the mutants are listed in the PR body with the test that kills each):
//   - off when the ceiling is off, off when the consent is off, off when the project's switch is off (each, and nothing is asked of the gateway or held);
//   - NO ENFORCED CAP = NO START: the gateway's cap read must say "enforced" for this company, project and month; an absent reader, a throw, a stale month, another project, `enforced: false`, an extra field and garbage all start nothing;
//   - the install's own per-run stop (the Admission) is needed as well as the gateway's cap;
//   - a cap with no room ($0 or used up) is a pause: the admins are told ONCE per (company, project, month, reason) and nothing is started;
//   - spend is booked from the install's own cost ledger of the run's task (the gateway's `x-rovara-cost-usd` is the answers route's, never the agent route's): a cost that is not KNOWN is never 0;
//   - the monthly figure on GET /upkeep: managers only, from the company's own rows, the cap only from the gateway;
//   - two companies on one store never see each other's rows, reads or notices.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, UPKEEP_CAP_AUDIENCE, WIKI_BUILD_FEATURE, PREPARE_PINS_FEATURE, WORKER_INVOCATION_FEATURES, change, projectMetaKey, queryAll, upkeepHourOf, upkeepMonthOf, type Admission, type OrgId, type ProjectDefinition, type WikiPageWrite } from "@agentx/contracts";
import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedAutomationStop, createHostedWikiRefresh, hostedUnattendedTasks } from "../../packages/broker/src/core-host/wiki-refresh.js";
import { createHostedSystemRuns, effectiveSystemRunsGateOf } from "../../packages/broker/src/core-host/system-runs.js";
import { UPKEEP_CAP_BODY_MAX_BYTES, UPKEEP_CAP_READ_FAILED, upkeepCapHttpReader, upkeepCapReaderFromEnvironment } from "../../packages/broker/src/core-host/upkeep-cap-http.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { PENDING_PK } from "../../packages/broker/src/core/notify/index.js";
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { knownTaskCostMicros, readSystemRunSpend, recordSystemRunSpend, systemRunSpendKey, systemRunSpendPartition } from "../../packages/broker/src/core/system-runs/spend.js";
import { readUpkeepCap } from "../../packages/broker/src/core/upkeep/cap.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { upkeepNightKey } from "../../packages/broker/src/core/upkeep/keys.js";
import { setUpkeepEnabled, upkeepView, type UpkeepSettingsDeps } from "../../packages/broker/src/core/upkeep/settings.js";
import { upkeepPauseHooks } from "../../packages/broker/src/core/upkeep/wiring.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { readWikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createHarness, definition } from "../support/task-flow-harness.js";
import { API_SHA } from "../support/wiki-build-fixtures.js";
import { capAnswer, capReader, type CapKind } from "../support/upkeep-cap-fixtures.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const PERSON = "ab".repeat(32);
const ADMIN = "d1".repeat(32);
const URL_ = "https://examplehost.test/acme/app";
const DAY = "2026-11-18";
const at = (day: string, hour: number, minute = 30): number => Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);

/** A project name whose night hour (for this company) is the first of the window, found by search so no test depends on a hash value. */
const projectAtSeven = (org: string): string => { for (let i = 0; i < 5_000; i += 1) if (upkeepHourOf(org, `proj${String(i)}`) === 7) return `proj${String(i)}`; throw new Error("no project"); };

const claim = { claimId: "c0001", text: "A claim", citations: [{ repo: "demo", path: "src/index.ts", commit: API_SHA, line: 1, quote: "export {}" }], source: "found" as const, checkedAt: "2026-11-01T00:00:00.000Z" };
const pageOf = (pageId: string): WikiPageWrite => ({
  pageId, kind: pageId === "overview" ? "overview" : "repo", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo: "demo", commit: API_SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }], claims: [claim], buildId: "build-0001",
});

interface Options { cap?: CapKind; consent?: boolean; flag?: string; enforces?: boolean; upkeep?: boolean; company?: OrgId; wiki?: boolean; withCapReader?: boolean }

async function build(options: Options = {}) {
  const company = options.company ?? A;
  const h = createHarness({ companyId: company, audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES, WIKI_BUILD_FEATURE, PREPARE_PINS_FEATURE] } });
  const name = projectAtSeven(company);
  const project: ProjectDefinition = { ...definition, name, repositories: [{ ...definition.repositories[0]!, name: "demo", url: URL_, host: { kind: "fake" } }] };
  await h.registerProject(project);
  await h.store.put({ item: { ...projectMetaKey(company, name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: { "package.json": "{}", "src/index.ts": "export {}" } });
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", new FakeCodeHost(model));
  h.deps.codeHosts = registry;
  h.deps.modelAccess = { route: vi.fn(async () => undefined) };
  const wiki = createWikiStore({ store: h.store, companyId: company, now: () => h.clock.now });
  if (options.wiki !== false) {
    for (const id of ["overview", "repo-demo"]) await wiki.writePage(name, pageOf(id));
    await wiki.addFlag(name, { pageId: "repo-demo", by: { kind: "person", personId: "p1" } });
  }
  if (options.upkeep !== false) await setUpkeepEnabled({ store: h.store, companyId: company, now: () => h.clock.now, standing: async () => ({ access: "manage" }) }, { personId: PERSON, project: name, requestId: crypto.randomUUID(), on: true, fromPage: true });
  if (options.consent !== false) await h.store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: "2026-11-17T00:00:00.000Z" } });
  h.clock.now = at(DAY, 8, 10);
  const flag = parseCoreSwitch(options.flag ?? "on").value;
  const gate = effectiveSystemRunsGateOf(flag, company, h.store);
  h.deps.access = hostedTaskAccess({ companyId: company, storage: async () => h.store, systemRunsOn: () => gate.enabled(), membershipOf: async () => undefined, projectGrant: async () => false });
  const admitted: string[] = [];
  const settled: Array<{ id: string; cost?: unknown }> = [];
  const admission: Admission = {
    enforcesCost: options.enforces !== false,
    admit: async (request) => { admitted.push(request.idempotencyKey); return { allowed: true, reservationId: `hold:${request.idempotencyKey}` }; },
    stage: async () => ({ decision: { allowed: true }, items: [] }), settle: async (id, result) => { settled.push({ id, ...(result?.cost === undefined ? {} : { cost: result.cost }) }); }, release: async () => undefined,
  };
  const cap = options.withCapReader === false ? undefined : capReader(options.cap ?? "enforced", () => h.clock.now, company);
  const hooks = upkeepPauseHooks({ store: h.store, companyId: company, now: () => h.clock.now, recipients: async () => [ADMIN] });
  const refresh = createHostedWikiRefresh({ flow: h.deps, companyId: company, now: () => h.clock.now, gate, admission, modelAccessConfigured: true, map: { standing: async () => ({ access: "none" }), hostFor: () => new FakeCodeHost(model) }, cap });
  const runs = createHostedSystemRuns({ flow: h.flow, companyId: company, flag, now: () => h.clock.now, enforcesDollars: admission.enforcesCost === true, refresh, paused: (input) => hooks.paused(input), cap });
  const nightRows = async () => queryAll(h.store, { pk: `ORG#${company}#UPKEEP#${name}`, sk: { op: "beginsWith", prefix: "NIGHT#" } });
  const notices = async () => (await h.store.query({ pk: PENDING_PK })).items.filter((row) => row["orgId"] === company);
  const pointer = () => readWikiBuildPointer(h.store, company, name);
  return { h, name, company, runs, admitted, settled, admission, cap, hooks, nightRows, notices, pointer, wiki, gate };
}
type World = Awaited<ReturnType<typeof build>>;
const pass = (w: World) => w.runs!.service.pass({ budgetMs: 10_000 });
const noAi = async (w: World): Promise<void> => {
  expect(w.admitted).toEqual([]);
  expect(await w.pointer()).toBeUndefined();
};

describe("the nightly wiki refresh runs by itself once, behind both locks, the project's switch and an enforced cap", () => {
  it("with everything on: the pass reads the gateway's cap for THIS project, holds once, and starts the refresh as the project's system owner", async () => {
    const w = await build();
    expect(await pass(w)).toMatchObject({ due: 1, started: 1 });
    expect(w.cap!.calls.length).toBeGreaterThan(0);
    expect(new Set(w.cap!.calls)).toEqual(new Set([w.name]));
    expect(w.admitted.filter((key) => key.startsWith("automation.run#"))).toHaveLength(1);
    const pointer = (await w.pointer())!;
    expect(pointer).toMatchObject({ unattended: true, buildKind: "refresh" });
    expect((await w.nightRows()).map((row) => row["outcome"])).toEqual(["ran"]);
  });

  // MUTANT: the night's refresh does not read the flag (the ceiling) / reads the consent alone / skips the project's switch.
  it.each([
    ["the ceiling is off", { flag: "off" }],
    ["the ceiling covers only another company", { flag: `on:${B}` }],
    ["the company has not consented", { consent: false }],
    ["the project's upkeep switch is off", { upkeep: false }],
  ] as Array<[string, Options]>)("%s: nothing is asked of the gateway, held or started", async (_why, options) => {
    const w = await build(options);
    const report = w.runs === undefined ? { started: 0 } : await pass(w);
    expect(report.started).toBe(0);
    await noAi(w);
    expect(w.cap?.calls ?? []).toEqual([]);
    expect(await w.nightRows()).toEqual([]);
  });

  it("the locks are read again inside the refresh itself (a consent withdrawn between the pass and the start stops the AI step)", async () => {
    const w = await build();
    await w.h.store.put({ item: { ...(await w.h.store.get(systemRunsConsentKey(w.company)))!, enabled: false } });
    expect(await w.runs!.service.pass({ budgetMs: 10_000 })).toMatchObject({ started: 0, skipped: "system_runs_off" });
    await noAi(w);
  });
});

describe("no enforced cap = no start", () => {
  // MUTANT the cap gate: the refresh treats anything but a throw as enforced, or does not read the gateway at all.
  it.each(["none", "throws", "stale", "other_project", "other_company", "not_enforced", "garbage", "extra_field"] as CapKind[])("a cap signal of kind %s starts no AI: nothing held, nothing recorded, the night says no_cost_cap", async (kind) => {
    const w = await build({ cap: kind });
    await pass(w);
    await noAi(w);
    expect((await w.nightRows()).map((row) => row["outcome"])).toEqual(["no_cost_cap"]);
    expect(await w.notices()).toEqual([]);
  });

  it("no reader at all (an install with no gateway, no signer) never reaches the refresh: no_cost_cap before Admission is asked", async () => {
    const w = await build({ withCapReader: false });
    await pass(w);
    await noAi(w);
    expect((await w.nightRows()).map((row) => row["outcome"])).toEqual(["no_cost_cap"]);
  });

  // MUTANT: the install's own per-run stop is dropped because the gateway's cap is enforced.
  it("the gateway's cap alone is not enough: an Admission that does not enforce a cost limit also starts nothing", async () => {
    const w = await build({ enforces: false });
    await pass(w);
    await noAi(w);
  });

  it("the refresh itself refuses without the signal, even when called straight (the night is not the only door)", async () => {
    for (const kind of ["none", "throws", "stale", "not_enforced", "no_budget", "used_up"] as CapKind[]) {
      const w = await build({ cap: kind });
      expect(await createHostedWikiRefresh({ flow: w.h.deps, companyId: w.company, now: () => w.h.clock.now, gate: w.gate, admission: w.admission, modelAccessConfigured: true, map: { standing: async () => ({ access: "none" }), hostFor: () => undefined as never }, cap: w.cap })(w.name, DAY, { includeUnwritten: true }), kind).toEqual({ outcome: "no_cost_cap" });
      await noAi(w);
    }
  });

  it("the signal is read again every night: an old answer is never kept, in either direction", async () => {
    const w = await build({ cap: "throws" });
    await pass(w);
    await noAi(w);
    // The gateway answers the next night: the refresh (never run at these commits yet) goes ahead.
    w.cap!.kind = "enforced";
    w.h.clock.now = at("2026-11-19", 8, 10);
    await pass(w);
    expect(w.admitted.filter((key) => key.startsWith("automation.run#"))).toHaveLength(1);
    expect(await w.pointer()).toBeDefined();
  });
});

describe("a cap with no room is a pause: told once, nothing started", () => {
  // MUTANT notice dedupe: a second night's pause writes a second notice (or the marker ignores the reason or the month).
  it.each([["no_budget", "no_budget"], ["used_up", "monthly_limit"]] as Array<[CapKind, string]>)("a %s cap writes ONE admins' notice for the month however many nights see it, records the reason, and starts nothing", async (kind, reason) => {
    const w = await build({ cap: kind });
    await pass(w);
    await noAi(w);
    expect(await w.notices()).toHaveLength(1);
    expect((await w.notices())[0]).toMatchObject({ kind: "upkeep_paused", developerId: ADMIN });
    expect((await w.nightRows()).map((row) => ({ outcome: row["outcome"], reason: row["pauseReason"] }))).toEqual([{ outcome: "paused", reason }]);
    w.h.clock.now = at("2026-11-19", 8, 10);
    await pass(w);
    expect(await w.notices()).toHaveLength(1);
    // A new month is a new notice.
    w.h.clock.now = at("2026-12-02", 8, 10);
    await pass(w);
    expect(await w.notices()).toHaveLength(2);
    await noAi(w);
  });

  it("the gateway's own 422 on a started run stops it (`upkeep_paused`), writes the same one notice, and records the reason on the night's row", async () => {
    const w = await build();
    await pass(w);
    const pointer = (await w.pointer())!;
    // The gateway refuses the run's next call (422 upkeep_paused, header monthly_limit): the page loop reports it, and the pause hook is what the broker calls.
    await w.hooks.onRunPaused({ orgId: w.company, project: w.name }, "monthly_limit");
    await w.hooks.onRunPaused({ orgId: w.company, project: w.name }, "monthly_limit");
    expect(await w.notices()).toHaveLength(1);
    const rows = await w.nightRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "paused", pauseReason: "monthly_limit" });
    expect(pointer.taskId).toBeDefined();
  });

  it("a late pause only rewrites a night that RAN: another night's outcome is never turned into a pause", async () => {
    const w = await build();
    await pass(w);
    const key = (await queryAll(w.h.store, { pk: `ORG#${w.company}#UPKEEP#${w.name}`, sk: { op: "beginsWith", prefix: "NIGHT#" } }))[0]!;
    await w.h.store.put({ item: { ...key, outcome: "nothing_changed" } });
    await w.hooks.onRunPaused({ orgId: w.company, project: w.name }, "monthly_limit");
    expect((await w.nightRows())[0]).toMatchObject({ outcome: "nothing_changed" });
    expect((await w.nightRows())[0]).not.toHaveProperty("pauseReason");
    // The notice is still the one voice.
    expect(await w.notices()).toHaveLength(1);
  });

  // MUTANT: the root builds the night or the refresh without the gateway's cap reader.
  it("the hosted root hands the cap reader to the night, the refresh and the setup page's cap (source guard)", async () => {
    const root = (await import("node:fs")).readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    expect(root.match(/cap: upkeepCapFor\(companyId\)/gu)).toHaveLength(2);
    expect(root).toContain("readUpkeepCap(upkeepCapFor(company), project, now().getTime(), company)");
  });

  it("the pause hook of one company never writes for another's project (notice, row)", async () => {
    const store = new MemoryDocumentStore();
    const hooksA = upkeepPauseHooks({ store, companyId: A, now: () => at(DAY, 8), recipients: async () => [ADMIN] });
    await hooksA.onRunPaused({ orgId: B, project: "beacon" }, "monthly_limit");
    await hooksA.paused({ orgId: B, project: "beacon", reason: "no_budget" });
    expect((await store.query({ pk: PENDING_PK })).items).toEqual([]);
    expect(await queryAll(store, { pk: `ORG#${B}#UPKEEP#beacon` })).toEqual([]);
  });
});

describe("the cap signal (core/upkeep/cap.ts)", () => {
  const NOW = at(DAY, 8);
  const reader = (answer: unknown) => ({ read: async () => answer });
  it("is enforced only for exactly the contract, this project and this month", async () => {
    expect(await readUpkeepCap(reader(capAnswer("beacon", NOW)), "beacon", NOW, A)).toMatchObject({ state: "enforced", limitUsd: 25, spentUsd: 1, month: upkeepMonthOf(NOW) });
    for (const bad of [capAnswer("other", NOW), capAnswer("beacon", NOW - 40 * 86_400_000), capAnswer("beacon", NOW, { enforced: false }), capAnswer("beacon", NOW, { enforced: "true" }), capAnswer("beacon", NOW, { version: 2 }), capAnswer("beacon", NOW, { limitMicros: -1 }),
      capAnswer("beacon", NOW, { limitMicros: 1.5 }), capAnswer("beacon", NOW, { spentMicros: "1" }), capAnswer("beacon", NOW, { extra: 1 }), capAnswer("beacon", NOW, {}, B), capAnswer("beacon", NOW, { company: undefined }), undefined, null, "enforced", 7, []]) {
      expect(await readUpkeepCap(reader(bad), "beacon", NOW, A), JSON.stringify(bad)).toEqual({ state: "unknown" });
    }
    expect(await readUpkeepCap(undefined, "beacon", NOW, A)).toEqual({ state: "unknown" });
    expect(await readUpkeepCap({ read: async () => { throw new Error("down"); } }, "beacon", NOW, A)).toEqual({ state: "unknown" });
  });
  it("says why there is no room: $0 is no_budget, used up (or over) is monthly_limit, anything left is no pause", async () => {
    expect(await readUpkeepCap(reader(capAnswer("beacon", NOW, { limitMicros: 0, spentMicros: 0 })), "beacon", NOW, A)).toMatchObject({ pause: "no_budget" });
    expect(await readUpkeepCap(reader(capAnswer("beacon", NOW, { limitMicros: 5_000_000, spentMicros: 5_000_000 })), "beacon", NOW, A)).toMatchObject({ pause: "monthly_limit" });
    expect(await readUpkeepCap(reader(capAnswer("beacon", NOW, { limitMicros: 5_000_000, spentMicros: 5_000_001 })), "beacon", NOW, A)).toMatchObject({ pause: "monthly_limit" });
    expect(await readUpkeepCap(reader(capAnswer("beacon", NOW, { limitMicros: 5_000_000, spentMicros: 4_999_999 })), "beacon", NOW, A)).not.toHaveProperty("pause");
  });
});

describe("the gateway's cap read over HTTP (upkeep-cap-http.ts)", () => {
  const signer = { publicJwk: async () => ({ kty: "RSA", alg: "RS256", use: "sig", kid: "A".repeat(16), rovara_purpose: "task", n: "x", e: "AQAB" }), sign: async () => Buffer.from("sig") } as never;
  const base = { gatewayUrl: "https://gateway.example.test", issuer: "https://code.example.test/v1/auth", signer, companyId: A, now: () => at(DAY, 8) };
  const body = (over: Record<string, unknown> = {}) => JSON.stringify(capAnswer("beacon", at(DAY, 8), over));
  const ok = (text: string, init: ResponseInit = { status: 200 }) => new Response(text, init);

  it("asks the company's own path with a service token of the cap's audience, and takes exactly the contract", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reader = upkeepCapHttpReader({ ...base, fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok(body()); }) as never });
    expect(await reader.read("beacon")).toMatchObject({ project: "beacon", enforced: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://gateway.example.test/v1/service/companies/${A}/upkeep/beacon`);
    expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    const token = String((calls[0]!.init.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ aud: UPKEEP_CAP_AUDIENCE, cid: A, iss: base.issuer });
  });

  it("anything but a 200 with exactly the contract is a failed read in fixed words, never an echo", async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["404", () => ok("secret detail", { status: 404 })], ["404 with a valid body", () => ok(body(), { status: 404 })], ["202 with a valid body", () => ok(body(), { status: 202 })], ["too big but valid json", () => ok(`${body()}${" ".repeat(UPKEEP_CAP_BODY_MAX_BYTES)}`)], ["500", () => ok("secret detail", { status: 500 })], ["not json", () => ok("secret detail")], ["extra field", () => ok(body({ more: 1 }))],
      ["enforced false", () => ok(body({ enforced: false }))], ["too big", () => ok("x".repeat(UPKEEP_CAP_BODY_MAX_BYTES + 1))], ["redirect", () => { throw new TypeError("redirect secret"); }],
    ];
    for (const [name, make] of cases) {
      const reader = upkeepCapHttpReader({ ...base, fetch: (async () => make()) });
      const error = await reader.read("beacon").catch((caught: unknown) => caught as Error);
      expect(error, name).toBeInstanceOf(Error);
      expect((error as Error).message, name).toBe(UPKEEP_CAP_READ_FAILED);
    }
  });

  it("never signs or sends for a name that is not a project, or for a company that is not a company id; a slow gateway is given up on", async () => {
    const fetchSpy = vi.fn(async () => ok(body()));
    const reader = upkeepCapHttpReader({ ...base, fetch: fetchSpy });
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(200)]) await expect(reader.read(bad)).rejects.toThrow(UPKEEP_CAP_READ_FAILED);
    await expect(upkeepCapHttpReader({ ...base, companyId: "not-a-company", fetch: fetchSpy }).read("beacon")).rejects.toThrow(UPKEEP_CAP_READ_FAILED);
    expect(fetchSpy).not.toHaveBeenCalled();
    const slow = upkeepCapHttpReader({ ...base, timeoutMs: 20, fetch: (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); })) as never });
    await expect(slow.read("beacon")).rejects.toThrow(UPKEEP_CAP_READ_FAILED);
  });

  it("a deployment reader exists only where the gateway's origin is configured and a signer can be had; two companies get two readers that name only their own company", async () => {
    const env = { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test" } as NodeJS.ProcessEnv;
    const tokens = () => ({ signer, issuer: "https://code.example.test/v1/auth" });
    expect(upkeepCapReaderFromEnvironment({}, tokens, A)).toBeUndefined();
    expect(upkeepCapReaderFromEnvironment({ ROVARA_CORE_MODEL_GATEWAY_URL: "http://insecure.example.test" }, tokens, A)).toBeUndefined();
    expect(upkeepCapReaderFromEnvironment(env, undefined, A)).toBeUndefined();
    const urls: string[] = [];
    const fetchSpy = (async (url: string) => { urls.push(url); return ok(body()); }) as never;
    await upkeepCapReaderFromEnvironment(env, tokens, A, fetchSpy)!.read("beacon");
    await upkeepCapReaderFromEnvironment(env, tokens, B, fetchSpy)!.read("beacon");
    expect(urls).toEqual([`https://gateway.example.test/v1/service/companies/${A}/upkeep/beacon`, `https://gateway.example.test/v1/service/companies/${B}/upkeep/beacon`]);
    // A signer that is not there at read time is a failed read, not a crash and not a guess.
    await expect(upkeepCapReaderFromEnvironment(env, () => undefined, A)!.read("beacon")).rejects.toThrow(UPKEEP_CAP_READ_FAILED);
  });
});

describe("spend: booked from the install's own cost ledger of the run's task, never 0 for unknown", () => {
  const putTotal = (w: World, taskId: string, over: Record<string, unknown> = {}) => w.h.store.put({ item: { pk: costPartition(w.company, taskId), sk: "TOTAL", currency: "USD", micros: 1_250_000, entries: 3, unpricedEntries: 0, ...over } });
  async function finished(w: World) {
    await pass(w);
    const pointer = (await w.pointer())!;
    await w.h.store.update({ key: taskKey(pointer.taskId), ops: [change.set("closedAt", "2026-11-18T09:00:00.000Z")] });
    return pointer.taskId;
  }
  const stop = (w: World) => createHostedAutomationStop({ flow: w.h.deps, companyId: w.company, admission: w.admission, now: () => w.h.clock.now });
  const month = upkeepMonthOf(at(DAY, 8));

  it("a known cost is settled with the hold AND written as one spend row for the project, kind wiki_refresh; the hold is settled once", async () => {
    const w = await build();
    const taskId = await finished(w);
    await putTotal(w, taskId);
    expect(await stop(w).pass({ budgetMs: 1_000 })).toMatchObject({ settled: 1, open: 0 });
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]!.cost).toEqual({ micros: 1_250_000, currency: "USD" });
    const rows = await queryAll(w.h.store, { pk: systemRunSpendPartition(w.company, month) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "SYSTEM_RUN_SPEND", orgId: w.company, project: w.name, kind: "wiki_refresh", month, taskId, costMicros: 1_250_000 });
    expect(await readSystemRunSpend({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now }, { project: w.name })).toEqual({ month, spentUsd: 1.25, runs: 1, unknownRuns: 0 });
    // A second sweep finds nothing open and writes nothing more.
    expect(await stop(w).pass({ budgetMs: 1_000 })).toMatchObject({ settled: 0 });
    expect(await queryAll(w.h.store, { pk: systemRunSpendPartition(w.company, month) })).toHaveLength(1);
  });

  // MUTANT spend source: unknown is booked as 0 (no TOTAL, an unpriced call, another currency, nothing recorded), or a number other than the ledger's is used.
  it.each([
    ["no total row", undefined],
    ["a call without a price", { unpricedEntries: 1 }],
    ["another currency", { currency: "EUR" }],
    ["nothing recorded", { entries: 0, micros: 0 }],
    ["a total that is not a number", { micros: "1250000" }],
    ["a negative total", { micros: -5 }],
  ] as Array<[string, Record<string, unknown> | undefined]>)("%s: the run is UNKNOWN (no figure on the row, the hold kept whole, counted in unknownRuns), never 0", async (_why, over) => {
    const w = await build();
    const taskId = await finished(w);
    if (over !== undefined) await putTotal(w, taskId, over);
    await stop(w).pass({ budgetMs: 1_000 });
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]).not.toHaveProperty("cost");
    const rows = await queryAll(w.h.store, { pk: systemRunSpendPartition(w.company, month) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("costMicros");
    expect(await readSystemRunSpend({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now }, { project: w.name })).toEqual({ month, spentUsd: 0, runs: 1, unknownRuns: 1 });
  });

  it("a real zero (one priced entry that cost nothing) is known and is 0; the header of the answers route is not a source", async () => {
    const w = await build();
    const taskId = await finished(w);
    await putTotal(w, taskId, { micros: 0, entries: 1 });
    await stop(w).pass({ budgetMs: 1_000 });
    expect(await readSystemRunSpend({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now }, { project: w.name })).toEqual({ month, spentUsd: 0, runs: 1, unknownRuns: 0 });
    expect(await hostedUnattendedTasks(w.h.deps).costUsd!(taskId)).toBe(0);
    // Nothing in the nightly spend path names the answers route's header.
    const source = (await import("node:fs")).readFileSync("packages/broker/src/core/system-runs/spend.ts", "utf8").replace(/^\/\/.*$/gmu, "");
    expect(source).not.toContain("x-rovara-cost-usd");
  });

  // MUTANT: the spend row is written after the settle, or not repeat-safe, or a failure to write is swallowed.
  it("a spend row that cannot be written leaves the run open and the hold untouched; the next sweep writes it once and settles once", async () => {
    const w = await build();
    const taskId = await finished(w);
    await putTotal(w, taskId);
    const store = w.h.store;
    const realPut = store.put.bind(store);
    let failing = true;
    store.put = (async (request: Parameters<typeof store.put>[0]) => {
      if (failing && request.item["entityType"] === "SYSTEM_RUN_SPEND") throw new Error("store down");
      return realPut(request);
    });
    expect(await stop(w).pass({ budgetMs: 1_000 })).toMatchObject({ settled: 0, open: 0 });
    expect(w.settled).toEqual([]);
    expect(await queryAll(store, { pk: systemRunSpendPartition(w.company, month) })).toEqual([]);
    failing = false;
    expect(await stop(w).pass({ budgetMs: 1_000 })).toMatchObject({ settled: 1 });
    expect(w.settled).toHaveLength(1);
    expect(await queryAll(store, { pk: systemRunSpendPartition(w.company, month) })).toHaveLength(1);
  });

  it("only a nightly run writes a spend row (another origin's run is settled and no row appears)", async () => {
    const w = await build();
    await w.h.store.put({ item: { pk: `ORG#${w.company}#UNATTENDED_RUN_OPEN`, sk: "req-chain", entityType: "UNATTENDED_RUN", requestId: "req-chain", taskId: "task-chain", project: w.name, origin: "chain", startedAt: "2026-11-18T08:00:00.000Z", maxMinutes: 30, reservationId: "hold-chain" } });
    await w.h.store.update({ key: taskKey("task-chain"), ops: [change.set("closedAt", "x")] }).catch(() => undefined);
    await stop(w).pass({ budgetMs: 1_000 });
    expect(await queryAll(w.h.store, { pk: systemRunSpendPartition(w.company, month) })).toEqual([]);
  });

  it("two companies: a company's month holds only its own rows, and a row filed under it that names another company or project is not counted", async () => {
    const store = new MemoryDocumentStore();
    const deps = (company: OrgId) => ({ store, companyId: company, now: () => at(DAY, 8) });
    await recordSystemRunSpend(deps(A), { project: "beacon", kind: "wiki_refresh", requestId: "r1", taskId: "t1", startedAt: "2026-11-18T08:00:00.000Z", end: "succeeded", costMicros: 2_000_000 });
    await recordSystemRunSpend(deps(B), { project: "beacon", kind: "wiki_refresh", requestId: "r1", taskId: "t1", startedAt: "2026-11-18T08:00:00.000Z", end: "succeeded", costMicros: 7_000_000 });
    await recordSystemRunSpend(deps(A), { project: "other", kind: "wiki_refresh", requestId: "r2", taskId: "t2", startedAt: "2026-11-18T08:00:00.000Z", end: "succeeded", costMicros: 3_000_000 });
    expect(await readSystemRunSpend(deps(A), { project: "beacon" })).toEqual({ month, spentUsd: 2, runs: 1, unknownRuns: 0 });
    expect(await readSystemRunSpend(deps(B), { project: "beacon" })).toEqual({ month, spentUsd: 7, runs: 1, unknownRuns: 0 });
    expect(systemRunSpendPartition(A, month)).not.toBe(systemRunSpendPartition(B, month));
    // A forged row in A's partition that names B, or another project, or an invented kind, or another month: not counted.
    const key = systemRunSpendKey(A, month, "beacon", "forged");
    for (const [i, over] of [{ orgId: B }, { project: "other" }, { kind: "coding_task" }, { month: "2026-10" }].entries()) {
      await store.put({ item: { pk: key.pk, sk: `${key.sk}${String(i)}`, entityType: "SYSTEM_RUN_SPEND", orgId: A, project: "beacon", kind: "wiki_refresh", month, costMicros: 99_000_000, ...over } });
    }
    expect(await readSystemRunSpend(deps(A), { project: "beacon" })).toEqual({ month, spentUsd: 2, runs: 1, unknownRuns: 0 });
    // Another month is another figure.
    expect((await readSystemRunSpend(deps(A), { project: "beacon", month: "2026-10" })).spentUsd).toBe(0);
  });

  it("the ledger reader is the task's own total in this company (another company's task id reads nothing)", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: costPartition(B, "t9"), sk: "TOTAL", currency: "USD", micros: 5_000_000, entries: 1, unpricedEntries: 0 } });
    expect(await knownTaskCostMicros(store, A, "t9")).toBeUndefined();
    expect(await knownTaskCostMicros(store, B, "t9")).toBe(5_000_000);
    expect(await knownTaskCostMicros({ get: async () => { throw new Error("down"); } }, B, "t9")).toBeUndefined();
  });
});

describe("GET /upkeep: the monthly figure", () => {
  const NOW = at(DAY, 8);
  async function view(over: { access?: "manage" | "view"; companyAdmin?: boolean; available?: boolean; cap?: () => Promise<number | null>; company?: OrgId; seed?: boolean } = {}) {
    const company = over.company ?? A;
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: "2026-11-17T00:00:00.000Z" } });
    if (over.seed !== false) {
      await recordSystemRunSpend({ store, companyId: company, now: () => NOW }, { project: "beacon", kind: "wiki_refresh", requestId: "r1", taskId: "t1", startedAt: "2026-11-18T08:00:00.000Z", end: "succeeded", costMicros: 4_500_000 });
      await recordSystemRunSpend({ store, companyId: company, now: () => NOW }, { project: "beacon", kind: "wiki_refresh", requestId: "r2", taskId: "t2", startedAt: "2026-11-18T08:00:00.000Z", end: "succeeded", costMicros: undefined });
    }
    const calls = { cap: 0 };
    const deps: UpkeepSettingsDeps = {
      store, companyId: company, now: () => NOW, standing: async () => ({ access: over.access ?? "manage", ...(over.companyAdmin === true ? { companyAdmin: true } : {}) }),
      available: () => over.available !== false, cap: async () => { calls.cap += 1; return over.cap === undefined ? 25 : over.cap(); },
      spend: (project) => readSystemRunSpend({ store, companyId: company, now: () => NOW }, { project }),
    };
    return { view: await upkeepView(deps, PERSON, "beacon"), calls };
  }

  it("a manager reads this month's spend (a floor with the unknown runs counted) and the cap from the gateway", async () => {
    const { view: v } = await view({ companyAdmin: true });
    expect(v.spend).toEqual({ month: upkeepMonthOf(NOW), spentUsd: 4.5, runs: 2, unknownRuns: 1 });
    expect(v.cap).toEqual({ monthlyUsd: 25, canRaise: true });
  });

  // MUTANT: a reader sees the spend or the cap, or the gateway is asked for a reader's page view.
  it("a reader gets no spend and no cap, and the gateway is not asked for them", async () => {
    const { view: v, calls } = await view({ access: "view" });
    expect(v).not.toHaveProperty("spend");
    expect(v.cap).toEqual({ monthlyUsd: null, canRaise: false });
    expect(calls.cap).toBe(0);
  });

  it("where nightly upkeep is not available there is no spend, no cap, and no gateway read", async () => {
    const { view: v, calls } = await view({ available: false });
    expect(v).not.toHaveProperty("spend");
    expect(v.cap.monthlyUsd).toBeNull();
    expect(calls.cap).toBe(0);
  });

  it("a gateway that cannot be read leaves the cap null (never a guess); a month with no runs says so with a real zero", async () => {
    const { view: v } = await view({ cap: async () => { throw new Error("down"); }, seed: false });
    expect(v.cap.monthlyUsd).toBeNull();
    expect(v.spend).toEqual({ month: upkeepMonthOf(NOW), spentUsd: 0, runs: 0, unknownRuns: 0 });
  });

  it("two companies: each sees only its own spend", async () => {
    const a = await view({ company: A });
    const b = await view({ company: B, seed: false });
    expect(a.view.spend?.runs).toBe(2);
    expect(b.view.spend?.runs).toBe(0);
  });
});

describe("the night's own rows stay inside the company", () => {
  it("two companies on separate stores each start their own refresh with their own cap read", async () => {
    const a = await build({ company: A });
    const b = await build({ company: B });
    await pass(a);
    await pass(b);
    expect(new Set(a.cap!.calls)).toEqual(new Set([a.name]));
    expect(new Set(b.cap!.calls)).toEqual(new Set([b.name]));
    expect((await a.nightRows()).map((row) => row["orgId"])).toEqual([A]);
    expect((await b.nightRows()).map((row) => row["orgId"])).toEqual([B]);
    expect(upkeepNightKey({ orgId: A, project: a.name }, DAY).pk).not.toBe(upkeepNightKey({ orgId: B, project: a.name }, DAY).pk);
  });
});
