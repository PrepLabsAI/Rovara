// L4-E12 (E2, DEC 254zzz55 N6): the free dry run's dependency list on the broker's side. It arrives through the setup run's EXISTING callback (`eval_dry_run`), is kept once per company and project (the newest run's), is read only at
// the caller's own company's key, and is shown through the TH1 words. Two-company cases, a fixed-words refusal, and the laptop and hosted wiring.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVAL_TEST_SERVICES_OFF_WORDS, EvalDependencyListSchema, evalBlockedReachClause, evalDependencyListToBlockedReach, evalDependencyListWords, type EvalDependencyList,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { EVAL_DEPENDENCY_LIST_ENTITY, evalDependencyListKey, evalReachesView, readEvalDependencyList } from "../../packages/broker/src/core/setup-agent/eval-dependency-list.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { workspaceKey, } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { hostedWorkersRunTestServices } from "../../packages/broker/src/aws/hosted-test-services.js";
import { testServicesEnabled } from "../../packages/broker/src/core/test-env/test-services-switch.js";
import { renderSetupPage } from "../../packages/broker/src/core/local-pages/setup-page.js";
import type { SetupPageView } from "../../packages/broker/src/core/local-pages/views.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const project = "demo";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");

/** The brief's case: a database, an outside host and a missing variable. */
const LIST: EvalDependencyList = {
  version: 1, modelCalls: 0, ended: "failed",
  databases: [{ port: 5432, engine: "postgres" }], hosts: [{ name: "api.vendor.example.test", port: 443 }], envVars: ["STRIPE_API_KEY"],
};

async function world(companyId: string, store = new MemoryDocumentStore()) {
  const workspaceId = randomUUID(); const taskId = randomUUID();
  await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId, purpose: "setup_agent" } });
  await store.put({ item: { ...setupAgentKey(companyId, project), entityType: "SETUP_AGENT", taskId } });
  const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId };
  const logs: Array<{ event: string; reason?: string }> = [];
  const callback = (body: unknown, op: object = operation, as = companyId) => handleSetupAgentCallback({ store, companyId: as, now: () => NOW, log: (e) => logs.push(e) }, op as never, body);
  return { store, taskId, workspaceId, operation, logs, callback };
}

describe("the contract: the list and its words", () => {
  it("is strict and bounded: no extra member, a model call claimed, a port out of range, a host that is an address or a path, a variable in lower case (mutant: the schema)", () => {
    expect(EvalDependencyListSchema.safeParse(LIST).success).toBe(true);
    for (const bad of [
      { ...LIST, modelCalls: 1 }, { ...LIST, extra: true }, { ...LIST, version: 2 }, { ...LIST, databases: [{ port: 70_000, engine: "postgres" }] }, { ...LIST, databases: [{ port: 5432, engine: "oracle" }] },
      { ...LIST, hosts: [{ name: "10.0.0.5" }] }, { ...LIST, hosts: [{ name: "https://a.example.test/x" }] }, { ...LIST, hosts: [{ name: "a".repeat(60) + ".test" }] }, { ...LIST, envVars: ["lower_case"] }, { ...LIST, envVars: ["A B"] },
      { ...LIST, hosts: Array.from({ length: 17 }, (_, i) => ({ name: `h${String(i)}.example.test` })) }, { ...LIST, envVars: Array.from({ length: 17 }, (_, i) => `VAR_${String(i)}`) }, { ...LIST, ended: "crashed" }, { ...LIST, stoppedEarly: "exited" },
    ]) expect(EvalDependencyListSchema.safeParse(bad).success).toBe(false);
  });

  it("says it in the TH1 words: the same clause a failed eval gets, then what it needs", () => {
    const words = evalDependencyListWords(LIST)!;
    expect(words).toBe("A free dry run of your eval on main found it reaches a database (port 5432) and an outside service (api.vendor.example.test) and needs the variable STRIPE_API_KEY.");
    // the TH1 clause itself is inside it
    const blocked = evalDependencyListToBlockedReach(LIST)!;
    expect(blocked).toEqual({ items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.vendor.example.test" }] });
    expect(evalBlockedReachClause(blocked)).toContain("a database (port 5432) and an outside service (api.vendor.example.test)");
  });

  it("says nothing for an empty list, except that a run which stopped early may be incomplete; says test services are off when they are; a list with more than 3 items says 'among others'", () => {
    const empty: EvalDependencyList = { version: 1, modelCalls: 0, ended: "finished", databases: [], hosts: [], envVars: [] };
    expect(evalDependencyListWords(empty)).toBeUndefined();
    expect(evalDependencyListToBlockedReach(empty)).toBeUndefined();
    expect(evalDependencyListWords({ ...empty, stoppedEarly: "missing_package", ended: "failed" })).toMatch(/found nothing it reaches\. The dry run stopped early .*may be incomplete\./u);
    expect(evalDependencyListWords({ ...LIST, servicesOff: true })).toContain(EVAL_TEST_SERVICES_OFF_WORDS);
    const only = evalDependencyListWords({ ...empty, envVars: ["DATABASE_URL"] });
    expect(only).toBe("A free dry run of your eval on main found it needs the variable DATABASE_URL.");
    const many = evalDependencyListToBlockedReach({ ...LIST, hosts: ["a", "b", "c"].map((name) => ({ name: `${name}.example.test` })) })!;
    expect(many.items).toHaveLength(3);
    expect(many.more).toBe(true);
    expect(evalDependencyListWords({ ...LIST, hosts: ["a", "b", "c"].map((name) => ({ name: `${name}.example.test` })) })).toContain("among others");
  });

  it("never echoes anything but the fixed shapes: a malformed list gives no words", () => {
    expect(evalDependencyListWords({ ...LIST, hosts: [{ name: "x y" }] })).toBeUndefined();
    expect(evalDependencyListToBlockedReach({ ...LIST, modelCalls: 3 } as never)).toBeUndefined();
  });
});

describe("the list through the setup run's existing callback", () => {
  it("keeps the list under the run's company and project, and the newest run's list replaces the older one", async () => {
    const w = await world(A);
    expect(await w.callback({ kind: "eval_dry_run", list: LIST })).toEqual({ recorded: true });
    expect(await readEvalDependencyList({ store: w.store, companyId: A }, project)).toEqual({ taskId: w.taskId, list: LIST });
    const row = (await w.store.get(evalDependencyListKey(A, project)))!;
    expect(row).toMatchObject({ entityType: EVAL_DEPENDENCY_LIST_ENTITY, company: A, project, taskId: w.taskId });
    expect(w.logs).toContainEqual({ event: "eval_dry_run_recorded" });
    const newer: EvalDependencyList = { ...LIST, databases: [], hosts: [], envVars: ["OTHER_VAR"] };
    await w.callback({ kind: "eval_dry_run", list: newer });
    expect((await readEvalDependencyList({ store: w.store, companyId: A }, project))!.list).toEqual(newer);
  });

  it("refuses an unreadable list and a list that claims a model call, with fixed words (no input echoed) and writes nothing (mutant: the schema check)", async () => {
    const w = await world(A);
    for (const bad of [{ canary: "secret-canary" }, { ...LIST, modelCalls: 1 }, { ...LIST, hosts: [{ name: "secret-canary.example.test", port: 99_999 }] }, "text", null]) {
      const error = await w.callback({ kind: "eval_dry_run", list: bad }).catch((e: unknown) => e) as Error;
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message).not.toContain("secret-canary");
    }
    expect(await w.store.get(evalDependencyListKey(A, project))).toBeUndefined();
    expect(w.logs.filter((entry) => entry.event === "eval_dry_run_refused").length).toBe(5);
  });

  it("is limited to a running setup run: not a non-setup run, not a run that ended, not another company's install (mutants: the run checks)", async () => {
    const w = await world(A);
    for (const operation of [{ ...w.operation, workflowMode: "IMPLEMENT" }, { ...w.operation, status: "SUCCEEDED" }, { ...w.operation, kind: "other" }]) {
      await expect(w.callback({ kind: "eval_dry_run", list: LIST }, operation)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
    await w.store.put({ item: { ...(await w.store.get(taskKey(w.taskId)))!, closedAt: "2026-11-18T09:00:00Z" } });
    await expect(w.callback({ kind: "eval_dry_run", list: LIST })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await w.store.get(evalDependencyListKey(A, project))).toBeUndefined();
    const other = await world(B);
    await expect(other.callback({ kind: "eval_dry_run", list: LIST }, other.operation, A)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("the body is exactly {kind, list}: an extra member is refused", async () => {
    const w = await world(A);
    await expect(w.callback({ kind: "eval_dry_run", list: LIST, company: B })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a worker can name no company, project or task: the row is the callback's own", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_dry_run", list: LIST });
    expect(await w.store.get(evalDependencyListKey(B, project))).toBeUndefined();
    expect(await readEvalDependencyList({ store: w.store, companyId: B }, project)).toBeUndefined();
  });
});

describe("two companies: the list never crosses", () => {
  it("company B reads nothing of company A's list, in the same store, with the same project name", async () => {
    const a = await world(A);
    const b = await world(B, a.store);
    await a.callback({ kind: "eval_dry_run", list: LIST });
    expect(await readEvalDependencyList({ store: a.store, companyId: B }, project)).toBeUndefined();
    expect(await evalReachesView({ store: a.store, companyId: B }, project, { servicesOff: true })).toBeUndefined();
    // B's own list is its own
    const other: EvalDependencyList = { ...LIST, databases: [{ port: 3306, engine: "mysql" }], hosts: [], envVars: [] };
    await b.callback({ kind: "eval_dry_run", list: other });
    expect((await readEvalDependencyList({ store: a.store, companyId: B }, project))!.list).toEqual(other);
    expect((await readEvalDependencyList({ store: a.store, companyId: A }, project))!.list).toEqual(LIST);
  });

  it("a row copied into the other company's partition, a relabelled row, a changed project and a row whose list is no longer the contract's shape all read as absent (mutants: the company and project checks)", async () => {
    const a = await world(A);
    await a.callback({ kind: "eval_dry_run", list: LIST });
    const row = (await a.store.get(evalDependencyListKey(A, project)))!;
    const { pk, sk, ...value } = row; void pk; void sk;
    // A's row copied under B's key still says it is A's
    await a.store.put({ item: { ...evalDependencyListKey(B, project), ...value } });
    expect(await readEvalDependencyList({ store: a.store, companyId: B }, project)).toBeUndefined();
    // relabelled to B but for another project
    await a.store.put({ item: { ...evalDependencyListKey(B, project), ...value, company: B, project: "other" } });
    expect(await readEvalDependencyList({ store: a.store, companyId: B }, project)).toBeUndefined();
    // a list that is no longer the contract's shape (a model call claimed after the fact)
    await a.store.put({ item: { ...evalDependencyListKey(A, project), ...value, list: { ...LIST, modelCalls: 2 } as never } });
    expect(await readEvalDependencyList({ store: a.store, companyId: A }, project)).toBeUndefined();
    // an unknown member in the row
    await a.store.put({ item: { ...evalDependencyListKey(A, project), ...value, extra: 1 } });
    expect(await readEvalDependencyList({ store: a.store, companyId: A }, project)).toBeUndefined();
  });

  it("a store that fails to read gives nothing, never a throw", async () => {
    const broken = { get: async () => { throw new Error("down"); } } as never;
    expect(await readEvalDependencyList({ store: broken, companyId: A }, project)).toBeUndefined();
  });
});

describe("what a page shows: the TH1 words, and 'test services are off' read from the install NOW", () => {
  it("shows the words and the TH1 items; adds the off reason only while the install's test services are off, whatever the run saw (mutant: take the run's own flag)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_dry_run", list: { ...LIST, servicesOff: true } });
    const on = (await evalReachesView({ store: w.store, companyId: A }, project, { servicesOff: false }))!;
    expect(on.words).toBe(evalDependencyListWords(LIST));
    expect(on.words).not.toContain("Test services");
    expect(on.blocked).toEqual({ items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.vendor.example.test" }] });
    expect(on.servicesOff).toBeUndefined();
    const off = (await evalReachesView({ store: w.store, companyId: A }, project, { servicesOff: true }))!;
    expect(off.words).toContain(EVAL_TEST_SERVICES_OFF_WORDS);
    expect(off.servicesOff).toBe(true);
    // the run saw them on, the install has them off now
    const w2 = await world(B);
    await w2.callback({ kind: "eval_dry_run", list: LIST });
    expect((await evalReachesView({ store: w2.store, companyId: B }, project, { servicesOff: true }))!.words).toContain(EVAL_TEST_SERVICES_OFF_WORDS);
  });

  it("the hosted card carries `reaches`, only this company's, and the off words follow the host's switch", async () => {
    const w = await world(A);
    const b = await world(B, w.store);
    await w.callback({ kind: "eval_dry_run", list: LIST });
    const principal = { companyId: A, personId: "p", provider: "test", displayName: "p", roles: [] };
    const card = await readEvalCard({ store: w.store, companyId: A, testServicesOff: () => true }, project, principal);
    expect(card.reaches?.words).toContain("a database (port 5432)");
    expect(card.reaches?.words).toContain(EVAL_TEST_SERVICES_OFF_WORDS);
    const on = await readEvalCard({ store: w.store, companyId: A, testServicesOff: () => false }, project, principal);
    expect(on.reaches?.words).not.toContain("Test services");
    // no switch given: read as on
    expect((await readEvalCard({ store: w.store, companyId: A }, project, principal)).reaches?.words).not.toContain("Test services");
    // a switch that throws reads as on, never fails the card
    expect((await readEvalCard({ store: w.store, companyId: A, testServicesOff: () => { throw new Error("x"); } }, project, principal)).reaches).toBeDefined();
    // B's card has none
    expect((await readEvalCard({ store: b.store, companyId: B, testServicesOff: () => true }, project, { ...principal, companyId: B })).reaches).toBeUndefined();
    // a project that has no dry run has none
    expect((await readEvalCard({ store: w.store, companyId: A }, "other-project", principal)).reaches).toBeUndefined();
  });
});

describe("laptop and hosted wiring", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("hosted: test services count as off unless the operator set TestServiceImages=mirrored and the switch is on (the same rule that starts them on the workers)", () => {
    const off = (env: Record<string, string>) => !hostedWorkersRunTestServices(env);
    expect(off({})).toBe(true);
    expect(off({ ROVARA_TEST_SERVICES_HOSTED_IMAGES: "none" })).toBe(true);
    expect(off({ ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored" })).toBe(false);
    expect(off({ ROVARA_TEST_SERVICES_HOSTED_IMAGES: "mirrored", ROVARA_TEST_SERVICES: "0" })).toBe(true);
    expect(off({ ROVARA_TEST_SERVICES_HOSTED_IMAGES: "Mirrored" })).toBe(true);
  });

  it("hosted: the deployed root hands the card that very rule, and the route passes it on (source pins: a root that forgot it would say nothing)", () => {
    expect(read("packages/broker/src/aws/core-engine-root.ts")).toMatch(/testServicesOff: \(\) => !hostedWorkersRunTestServices\(env\),/u);
    expect(read("packages/broker/src/core-host/setup-run-routes.ts")).toMatch(/healthRuns: input\.wiring\.eval\.healthRuns, testServicesOff: input\.wiring\.eval\.testServicesOff, now: input\.now/u);
  });

  it("laptop: the setup page's view reads the list with the install's own switch (testServicesEnabled), and the page shows the words in the eval panel, escaped", () => {
    expect(read("packages/broker/src/local/app/setup-agent.ts")).toMatch(/evalReachesView\(\{ store, companyId \}, project, \{ servicesOff: !testServicesEnabled\(process\.env\) \}\)/u);
    expect(testServicesEnabled({})).toBe(true);
    expect(testServicesEnabled({ ROVARA_TEST_SERVICES: "0" })).toBe(false);
    expect(testServicesEnabled({ ROVARA_TEST_SERVICES_UNAVAILABLE: "images" })).toBe(false);
    const view = { project: "demo", revision: 1, status: "ready", limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, items: [], verified: true, journal: [], hostAsks: [], check: { status: "ready" }, approvedHosts: [],
      evalDiscovery: { state: "waiting", taskId: "t", reportDigest: "d".repeat(64), suites: [{ selection: "evals/demo", files: ["a.txt"], questions: 1, categories: "1 ordinary", command: "[]", commandCwd: ".", report: "r.json", model: "m", judge: "j", caps: "c" }] },
      evalReaches: { words: "A free dry run of your eval on main found it reaches <b>x</b>." } } as unknown as SetupPageView;
    const html = renderSetupPage({ base: "/local", nonce: "n", sessionId: "s", formToken: () => "t" }, view);
    expect(html).toContain("A free dry run of your eval on main found it reaches &lt;b&gt;x&lt;/b&gt;.");
    expect(html).not.toContain("<b>x</b>");
    expect(renderSetupPage({ base: "/local", nonce: "n", sessionId: "s", formToken: () => "t" }, { ...view, evalReaches: undefined } as unknown as SetupPageView)).not.toContain("free dry run");
  });
});
