// L4-HW3c: on the hosted broker's real core root, the company's approved rules (kept by Cloud, read by the model gateway) reach the standing block a starting task pins, for that company only.
// The root, registry, standing-instructions seam and adapter are real; only the world (storage, code host) and the gateway's HTTP answer (a stubbed fetch) are fakes.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYBOOK_FILE_PATH, TASK_KEY_PURPOSE, projectRevisionKey, orgProjectCatalogKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { buildStandingInstructions } from "../../packages/broker/src/core/instructions/standing-block.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
// The gateway settings also make the model-keys point (the fake world has its own); only that module is left out here.
vi.mock("../../packages/broker/src/core-host/gateway-model-access.js", async (original) => ({ ...await original<object>(), gatewayModelKeysModules: () => [] }));
const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const GATEWAY = "https://gateway.staging.example";
const ISSUER = "https://api.staging.example/v1/auth";
const secret = Buffer.alloc(32, 7);
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
const signer: TokenSigner = {
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
};
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const GATEWAY_ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5" };
const cidOf = (init: RequestInit | undefined): string => JSON.parse(Buffer.from(String((init?.headers as Record<string, string>)["authorization"]).split(".")[1]!, "base64url").toString()).cid as string;

/** Cloud's answers by company: A has two approved rules, B one, C none. The gateway answers for the token's company only. */
const stored: Record<string, { version: string; rules: { text: string; priority: "required" | "preferred" }[] }> = {
  [A]: { version: "5", rules: [{ text: "A-REQUIRED: never commit secrets.", priority: "required" }, { text: "A-PREFERRED: small pull requests.", priority: "preferred" }] },
  [B]: { version: "9", rules: [{ text: "ONLY-B-RULE", priority: "required" }] },
};
const calls: { company: string; url: string }[] = [];
function stubGateway(behaviour: (company: string) => Response = (company) => new Response(JSON.stringify({ company, ...(stored[company] ?? { version: "0", rules: [] }) }), { status: 200 })) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const company = cidOf(init);
    calls.push({ company, url: String(url) });
    return behaviour(company);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

async function setup(env: Record<string, string> = GATEWAY_ENV) {
  const world = createFakeWorld();
  adapters.modules = [...world.modules];
  world.host.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: HOSTED-RULE" });
  for (const company of [A, B]) {
    await world.store.put({ item: { ...projectRevisionKey(company, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(company, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...env },
    documentClient: { send: async () => ({}) }, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    taskTokens: () => ({ signer: taskKeySigner(signer), issuer: ISSUER }),
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
  });
  return { world, root };
}
const pinFor = async (root: Awaited<ReturnType<typeof setup>>["root"], company: OrgId) => {
  const seam = (await root.app.runtimeFor(company)).flow.deps.standingInstructions!;
  return await seam.pinContent!("payments", await seam.pin("payments"));
};

describe("the hosted broker's core root registers company-instructions from the gateway (L4-HW3c)", () => {
  it("the company's approved rules reach its pinned standing block, Required before Preferred, the file's How we work after them", async () => {
    stubGateway();
    const { root } = await setup();
    const pin = await pinFor(root, A);
    expect(pin?.company).toEqual(stored[A]);
    const block = buildStandingInstructions({ company: pin?.company, howWeWork: [], checking: false });
    expect(block?.text).toContain("A-REQUIRED: never commit secrets.");
    expect(block?.text).toContain("A-PREFERRED: small pull requests.");
    expect(block!.text.indexOf("A-REQUIRED")).toBeLessThan(block!.text.indexOf("A-PREFERRED"));
    expect(pin?.playbook?.file.rules).toBe("HOSTED-RULE");
    expect(calls).toEqual([{ company: A, url: `${GATEWAY}/v1/service/company-instructions` }]);
  });

  it("another company's rules never reach it: each company's pin asks the gateway as itself and holds only its own", async () => {
    stubGateway();
    const { root } = await setup();
    const pinA = await pinFor(root, A);
    const pinB = await pinFor(root, B);
    expect(calls.map((c) => c.company)).toEqual([A, B]);
    expect(JSON.stringify(pinA)).not.toContain("ONLY-B-RULE");
    expect(JSON.stringify(pinB)).toContain("ONLY-B-RULE");
    expect(JSON.stringify(pinB)).not.toContain("A-REQUIRED");
    expect(pinB?.company?.version).toBe("9");
  });

  it("a company with no rules is unchanged: no company part, the file still pinned", async () => {
    stubGateway(() => new Response(JSON.stringify({ company: A, version: "0", rules: [] }), { status: 200 }));
    const { root } = await setup();
    const pin = await pinFor(root, A);
    expect(pin?.company).toBeUndefined();
    expect(pin?.playbook?.file.rules).toBe("HOSTED-RULE");
  });

  it("a gateway that cannot answer (503, its 404, a wrong company, a fault) stops the task start in the core's words; nothing starts without the company's rules", async () => {
    for (const behaviour of [() => new Response("", { status: 503 }), () => new Response("", { status: 404 }), () => new Response(JSON.stringify({ company: B, version: "9", rules: stored[B]!.rules }), { status: 200 }), () => { throw new Error("connect ECONNREFUSED"); }]) {
      stubGateway(behaviour);
      const { root } = await setup();
      await expect(pinFor(root, A)).rejects.toThrow(/The company rules could not be read, so this step did not start/u);
    }
  });

  it("rules over the limits stop the start with the budget sentence, as on a laptop", async () => {
    stubGateway((company) => new Response(JSON.stringify({ company, version: "1", rules: [{ text: "x".repeat(601), priority: "required" }] }), { status: 200 }));
    const { root } = await setup();
    await expect(pinFor(root, A)).rejects.toThrow(/Company rules exceed the size budget/u);
  });

  it("an install with no gateway configured registers nothing and asks nothing: tasks pin the file only, as before", async () => {
    stubGateway();
    const { root } = await setup({});
    const pin = await pinFor(root, A);
    expect(pin?.company).toBeUndefined();
    expect(pin?.playbook?.file.rules).toBe("HOSTED-RULE");
    expect(calls).toEqual([]);
  });
});
