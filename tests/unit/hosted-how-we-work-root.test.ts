// L4-HW3: the hosted broker's core root gives every company's runtime the standing-instructions seam that copies the project's How we work and the company's rules onto a starting task.
// The root, registry and runtime are real; only the deployment adapters are the fake world's, plus a `company-instructions` point the way a deployment's module would register one.
import { describe, expect, it, vi } from "vitest";
import { PLAYBOOK_FILE_PATH, projectRevisionKey, orgProjectCatalogKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };

async function setup(options: { points?: boolean } = {}) {
  const world = createFakeWorld();
  const asked: string[] = [];
  const rules = { current: async (company: string) => { asked.push(company); return company === A ? { version: "7", rules: [{ text: `Rules of ${company}`, priority: "required" as const }] } : { version: "8", rules: [{ text: "ONLY-B-RULE", priority: "required" as const }] }; } };
  adapters.modules = [...world.modules];
  world.host.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: HOSTED-RULE" });
  for (const company of [A, B]) {
    await world.store.put({ item: { ...projectRevisionKey(company, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(company, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const root = createBrokerCoreRoot({
    env: {},
    documentClient: { send: async () => ({}) }, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    ...(options.points === false ? {} : { extraModules: () => [coreAdapter({ point: "company-instructions", name: "fake", owner: "test", create: () => rules })] }),
  });
  return { world, root, asked };
}

describe("the hosted broker's core root (L4-HW3)", () => {
  it("gives each company's runtime a standing-instructions seam that copies the file from THAT company's code host and the company's rules, asking for that company only", async () => {
    const { root, asked } = await setup();
    const a = (await root.app.runtimeFor(A)).flow.deps.standingInstructions!;
    expect(typeof a.pinContent).toBe("function");
    const commit = await a.pin("payments");
    expect(commit).toMatch(/^[a-f0-9]{40,}$/u);
    const pinA = await a.pinContent!("payments", commit);
    expect(pinA?.playbook).toMatchObject({ commit, file: { rules: "HOSTED-RULE" } });
    expect(pinA?.company).toEqual({ version: "7", rules: [{ text: `Rules of ${A}`, priority: "required" }] });
    expect(asked).toEqual([A]);
    const b = (await root.app.runtimeFor(B)).flow.deps.standingInstructions!;
    const pinB = await b.pinContent!("payments", await b.pin("payments"));
    expect(asked).toEqual([A, B]);
    expect(JSON.stringify(pinB)).toContain("ONLY-B-RULE");
    expect(JSON.stringify(pinB)).not.toContain(`Rules of ${A}`);
    expect(JSON.stringify(pinA)).not.toContain("ONLY-B-RULE");
  });
});
