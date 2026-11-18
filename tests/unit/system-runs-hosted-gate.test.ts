// L4-P1/L4-P2 (owner DEC 254zzl, 254zzt): an ABSENT systemRuns gate on a task flow means ON (the laptop's rule), so a hosted runtime must ALWAYS carry one, default off, or every hosted company would get Rovara's
// automatic re-checks. The gate is EFFECTIVE: the operator's ceiling AND the company's stored consent. The broker root builds a runtime per company inside a fixture too big for a unit test, and so does the dispatcher,
// so this holds the function they call and, on the SOURCE'S SYNTAX TREE, that each calls it as a direct statement of the builder every runtime goes through (not inside an `if`, a loop, a callback or a try).
import * as fsModule from "node:fs";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { hostedSystemRunsFor } from "../../packages/broker/src/aws/core-engine-root.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
type Gate = { enabled(): boolean | Promise<boolean> };
const consent = async (store: MemoryDocumentStore, company: OrgId, enabled = true): Promise<void> => { await store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled, changedAt: "2026-11-17T00:00:00.000Z" } }); };

describe("the hosted SystemRuns gate is always supplied", () => {
  it("sets a gate on the flow's deps for every flag value, default off", async () => {
    for (const raw of [undefined, "", "off", "typo", "drain", `on:${B}`, "on", `on:${A}`]) {
      const deps: { systemRuns?: Gate; store: MemoryDocumentStore } = { store: new MemoryDocumentStore() };
      const gate = hostedSystemRunsFor(deps, A, parseCoreSwitch(raw).value);
      expect(deps.systemRuns, String(raw)).toBe(gate);
      expect(typeof deps.systemRuns?.enabled).toBe("function");
      // No consent row yet: off for every flag value.
      expect(await deps.systemRuns!.enabled(), String(raw)).toBe(false);
    }
  });

  // MUTANT: the AND becomes an OR (or drops one lock): one of the three "off" cells below turns on.
  it("is on only where the flag covers the company AND the company consented (all four combinations, then two companies)", async () => {
    for (const [flag, given, want] of [["off", false, false], ["off", true, false], [`on:${A}`, false, false], [`on:${A}`, true, true], ["on", true, true], ["on", false, false]] as const) {
      const deps: { systemRuns?: Gate; store: MemoryDocumentStore } = { store: new MemoryDocumentStore() };
      if (given) await consent(deps.store, A);
      hostedSystemRunsFor(deps, A, parseCoreSwitch(flag).value);
      expect(await deps.systemRuns!.enabled(), `${flag} consent=${String(given)}`).toBe(want);
    }
    // Two companies in one store: A's consent opens nothing for B, and the flag naming only B opens nothing for A.
    const store = new MemoryDocumentStore();
    await consent(store, A);
    const a: { systemRuns?: Gate; store: MemoryDocumentStore } = { store };
    const b: { systemRuns?: Gate; store: MemoryDocumentStore } = { store };
    hostedSystemRunsFor(a, A, parseCoreSwitch("on").value);
    hostedSystemRunsFor(b, B, parseCoreSwitch("on").value);
    expect(await a.systemRuns!.enabled()).toBe(true);
    expect(await b.systemRuns!.enabled()).toBe(false);
    const onlyB: { systemRuns?: Gate; store: MemoryDocumentStore } = { store };
    hostedSystemRunsFor(onlyB, A, parseCoreSwitch(`on:${B}`).value);
    expect(await onlyB.systemRuns!.enabled()).toBe(false);
  });

  it("is read on every use: withdrawing the consent stops the very next question, and a store that cannot be read is off", async () => {
    const deps: { systemRuns?: Gate; store: MemoryDocumentStore } = { store: new MemoryDocumentStore() };
    await consent(deps.store, A);
    hostedSystemRunsFor(deps, A, parseCoreSwitch("on").value);
    expect(await deps.systemRuns!.enabled()).toBe(true);
    await consent(deps.store, A, false);
    expect(await deps.systemRuns!.enabled()).toBe(false);
    await consent(deps.store, A, true);
    expect(await deps.systemRuns!.enabled()).toBe(true);
    const broken = { systemRuns: undefined as Gate | undefined, store: { get: async () => { throw new Error("down"); } } };
    hostedSystemRunsFor(broken, A, parseCoreSwitch("on").value);
    expect(await broken.systemRuns!.enabled()).toBe(false);
    // A row that is another company's, or not exactly `enabled: true`, is no consent.
    const odd = new MemoryDocumentStore();
    await odd.put({ item: { ...systemRunsConsentKey(A), entityType: "SYSTEM_RUNS_CONSENT", orgId: B, enabled: true } });
    const wrong: { systemRuns?: Gate; store: MemoryDocumentStore } = { store: odd };
    hostedSystemRunsFor(wrong, A, parseCoreSwitch("on").value);
    expect(await wrong.systemRuns!.enabled()).toBe(false);
    await odd.put({ item: { ...systemRunsConsentKey(A), entityType: "SYSTEM_RUNS_CONSENT", orgId: A, enabled: "true" } });
    expect(await wrong.systemRuns!.enabled()).toBe(false);
  });
});

/**
 * The statement `hostedSystemRunsFor(<deps>, companyId, ...)` must be a DIRECT statement of the arrow function that is the value of the named property (`services` on the broker, `depsFor` on the dispatcher): its
 * parent chain is ExpressionStatement -> the arrow's own body Block. Wrapping it in an `if`, a loop, a try, a nested callback or a conditional expression moves it out and fails this.
 */
function directCallsIn(file: string, property: string): { calls: number; direct: number } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let calls = 0;
  let direct = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "hostedSystemRunsFor") {
      calls += 1;
      const statement = node.parent;
      const block = statement.parent;
      if (ts.isExpressionStatement(statement) && ts.isBlock(block)) {
        const fn = block.parent;
        const owner = fn.parent;
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body === block && ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name) && owner.name.text === property) direct += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, direct };
}

describe("the root and the dispatcher each call it, directly, for every company's runtime", () => {
  // MUTANT: the call removed, wrapped in an unrelated `if`, moved into a callback, or replaced by a plain assignment.
  it("the broker root: one call, a direct statement of the `services` builder every hosted runtime goes through", () => {
    const file = "packages/broker/src/aws/core-engine-root.ts";
    expect(directCallsIn(file, "services")).toEqual({ calls: 1, direct: 1 });
    expect(readFileSync(file, "utf8")).not.toMatch(/\.systemRuns\s*=/u);
  });

  // MUTANT (review L5): the root's task-access gate falls back to the ceiling alone.
  it("the broker root's task-access gate reads BOTH locks (the effective gate), never the ceiling alone", () => {
    const root = readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    expect(root).toMatch(/systemRunsOn: \(\) => effectiveSystemRunsGateOf\(systemRunsFlag\.value, companyId, registry\.require\("storage"\)\)\.enabled\(\)/u);
    expect(root).not.toMatch(/systemRunsGateOf\(/u);
  });

  it("the dispatcher: one call, a direct statement of `depsFor`, which every dispatched step's deps come from", () => {
    const file = "packages/broker/src/aws/worker-machines/dispatcher-core.ts";
    expect(directCallsIn(file, "depsFor")).toEqual({ calls: 1, direct: 1 });
    expect(readFileSync(file, "utf8")).not.toMatch(/\.systemRuns\s*=/u);
  });

  it("the checker itself notices a wrapped call (so the two guards above can fail)", () => {
    const dir = process.env["TMPDIR"] ?? "/tmp";
    const file = `${dir}/rovara-gate-guard-${process.pid}.ts`;
    const write = (body: string): string => { fsModule.writeFileSync(file, `const o = { services: (flow) => {\n${body}\n} };\n`); return file; };
    try {
      expect(directCallsIn(write("hostedSystemRunsFor(flow.deps, id, f);"), "services")).toEqual({ calls: 1, direct: 1 });
      expect(directCallsIn(write("if (x) { hostedSystemRunsFor(flow.deps, id, f); }"), "services")).toEqual({ calls: 1, direct: 0 });
      expect(directCallsIn(write("x && hostedSystemRunsFor(flow.deps, id, f);"), "services")).toEqual({ calls: 1, direct: 0 });
      expect(directCallsIn(write("[1].forEach(() => { hostedSystemRunsFor(flow.deps, id, f); });"), "services")).toEqual({ calls: 1, direct: 0 });
      expect(directCallsIn(write("try { hostedSystemRunsFor(flow.deps, id, f); } catch {}"), "services")).toEqual({ calls: 1, direct: 0 });
      expect(directCallsIn(write("flow.deps.systemRuns = g;"), "services")).toEqual({ calls: 0, direct: 0 });
    } finally {
      fsModule.rmSync(file, { force: true });
    }
  });
});
