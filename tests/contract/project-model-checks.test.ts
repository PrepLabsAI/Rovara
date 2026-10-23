import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRefSchema, ProjectDefinitionSchema, ProjectModelOptionsSchema, type ProjectDefinition } from "@agentx/contracts";
import type { ModelCheckResult } from "../../packages/model-runtime/src/model-check.js";
import { registerRevision } from "../../packages/cli/src/setup/project-add.js";
import { checkProjectModels, projectModelChecks, PROJECT_MODEL_CHECK_MAX_PAIRS, type ProjectModelChecker } from "../../packages/cli/src/setup/project-model-check.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { doctorContext, doctorServices } from "../support/doctor-fakes.js";
import { passingChecks } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane } from "../support/setup-fakes.js";

// M1.4 Task 4.10D, test 40 (MODEL1): a project's default and approved models are checked before first use, the result is stored with the pair as a class and nothing else, doctor lists every
// pair, and `@agentx use` warns for a pair whose last check failed.

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f" };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
const NOW = "2026-10-23T12:00:00.000Z";
const SECRET_TEXT = "Bearer sk-ant-must-never-be-stored";
let configDir: string;
beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "agentx-model-checks-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

const DEFAULT = { provider: "anthropic", modelId: "claude-sonnet-4-6", label: "Sonnet" };
const OPUS = { provider: "anthropic", modelId: "claude-opus-5", label: "Opus" };
const FAST = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Fast" };

const definition = (models: unknown = { default: DEFAULT, approved: [DEFAULT, OPUS, FAST] }): ProjectDefinition => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
  ...(models === null ? {} : { models }),
});

type FailureClass = Extract<ModelCheckResult, { ok: false }>["class"];
const failed = (cls: FailureClass, signal: string | null = null, quota?: { scope: "geographic" | "global"; code: string | null; tokensPerMinute: number | null }): ModelCheckResult =>
  ({ ok: false, class: cls, signal, error: new Error(SECRET_TEXT), ...(quota === undefined ? {} : { quota }) });
/** A checker that answers from a table by `provider/modelId`, and records the order of its calls and how many ran at once. */
function checker(answers: Record<string, ModelCheckResult>) {
  const calls: string[] = [];
  let running = 0;
  let overlap = 0;
  const check: ProjectModelChecker = async (pair) => {
    const key = `${pair.provider}/${pair.modelId}`;
    calls.push(key);
    running += 1;
    overlap = Math.max(overlap, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return answers[key] ?? { ok: true };
  };
  return { check, calls, overlap: () => overlap };
}

function services(check: ProjectModelChecker | undefined) {
  const plane = fakeControlPlane();
  return { plane, services: { fetch: plane.fetch, configDir, stackOutputs: async (name: string) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined), ...(check === undefined ? {} : { modelCheck: check, now: () => Date.parse(NOW) }) } };
}

describe("project models are checked when a revision is registered", () => {
  it("refuses a registration whose default model's key is rejected, with the key sentence, and registers and writes nothing", async () => {
    const run = checker({ "anthropic/claude-sonnet-4-6": failed("key-rejected") });
    const context = services(run.check);
    const error = await registerRevision({ env: "staging", session, definition: definition(), services: context.services }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("Anthropic refused the key for claude-sonnet-4-6; check the key, and that it may use this model.");
    expect(error?.message).toContain("payments was not registered");
    expect(context.plane.registered).toEqual([]);
    await expect(readFile(join(configDir, "payments.yaml"), "utf8")).rejects.toThrow();
    // The default is checked first, and a refused default stops the rest.
    expect(run.calls).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("registers an approved pair that fails with a warning, and stores the class (never the provider's text) with the pair", async () => {
    const run = checker({ "anthropic/claude-opus-5": failed("model-not-found", "not_found_error") });
    const context = services(run.check);
    const registered = await registerRevision({ env: "staging", session, definition: definition(), services: context.services });
    expect(run.calls).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-5", "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
    expect(run.overlap()).toBe(1);
    expect(registered.warnings).toContain("The approved model Opus (anthropic/claude-opus-5) failed its check, and is registered anyway: Anthropic does not have claude-opus-5 for this account; check the model id, or choose another model.");
    const sent = (context.plane.registered[0] as { definition: ProjectDefinition }).definition;
    expect(sent.models?.approved.map((model) => [model.modelId, model.lastCheck])).toEqual([
      ["claude-sonnet-4-6", { status: "ok", checkedAt: NOW }],
      ["claude-opus-5", { status: "failed", class: "model-not-found", checkedAt: NOW }],
      ["us.anthropic.claude-haiku-4-5-20251001-v1:0", { status: "ok", checkedAt: NOW }],
    ]);
    expect(sent.models?.default.lastCheck).toEqual({ status: "ok", checkedAt: NOW });
    const file = await readFile(registered.file, "utf8");
    expect(file).toContain("model-not-found");
    for (const text of [file, JSON.stringify(context.plane.registered), registered.warnings.join("\n")]) expect(text).not.toContain("sk-ant");
  });

  it("checks at most sixteen pairs, each once, bounded at thirty seconds, and a check that never answers is an outage, not a hang", async () => {
    expect(PROJECT_MODEL_CHECK_MAX_PAIRS).toBe(16);
    const approved = Array.from({ length: 16 }, (_, index) => ({ provider: "amazon-bedrock", modelId: `us.model-${index}`, label: `M${index}` }));
    const many = checker({});
    const result = await checkProjectModels({ definition: definition({ default: approved[3], approved }), check: many.check, now: () => Date.parse(NOW) });
    expect(many.calls).toHaveLength(16);
    expect(new Set(many.calls).size).toBe(16);
    expect(many.calls[0]).toBe("amazon-bedrock/us.model-3");
    expect(result.warnings).toEqual([]);

    vi.useFakeTimers();
    try {
      const hang: ProjectModelChecker = () => new Promise(() => undefined);
      const pending = checkProjectModels({ definition: definition({ default: DEFAULT, approved: [DEFAULT, OPUS] }), check: async (pair) => (pair.modelId === "claude-opus-5" ? hang(pair) : { ok: true }), now: () => Date.parse(NOW) });
      await vi.advanceTimersByTimeAsync(30_000);
      const timed = await pending;
      expect(timed.definition.models?.approved.find((model) => model.modelId === "claude-opus-5")?.lastCheck).toEqual({ status: "unchecked", class: "provider-outage", checkedAt: NOW });
    } finally { vi.useRealTimers(); }
  });

  it("changes nothing for a project with no models or no checker, and an old project file's models (no lastCheck) still parse", async () => {
    const run = checker({});
    const bare = services(run.check);
    const noModels = definition(null);
    const registered = await registerRevision({ env: "staging", session, definition: noModels, services: bare.services });
    expect(run.calls).toEqual([]);
    expect((bare.plane.registered[0] as { definition: ProjectDefinition }).definition).toEqual(noModels);
    expect(registered.warnings).toEqual([]);
    const unchecked = services(undefined);
    await registerRevision({ env: "staging", session, definition: definition(), services: unchecked.services });
    expect((unchecked.plane.registered[0] as { definition: ProjectDefinition }).definition.models?.default.lastCheck).toBeUndefined();
    expect(ModelRefSchema.parse({ provider: "anthropic", modelId: "claude-sonnet-4-6" })).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "unchecked", class: "provider-outage", checkedAt: NOW } }).lastCheck?.status).toBe("unchecked");
    expect(ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "failed", class: "model-not-found", checkedAt: NOW, acceptedReason: "the model arrives next week" } }).lastCheck?.acceptedReason).toBe("the model arrives next week");
    expect(() => ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "ok", checkedAt: NOW, acceptedReason: "x" } })).toThrow();
    expect(() => ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "failed", checkedAt: NOW } })).toThrow();
    expect(() => ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "ok", class: "unknown", checkedAt: NOW } })).toThrow();
    expect(() => ModelRefSchema.parse({ ...DEFAULT, lastCheck: { status: "failed", class: "unknown", checkedAt: NOW, message: "x" } })).toThrow();
  });

  it("leaves a model whose provider this agentx cannot check as it was, not as passed", async () => {
    const run = checker({});
    const other = { provider: "some-gateway", modelId: "alpha", label: "Alpha" };
    const result = await checkProjectModels({ definition: definition({ default: DEFAULT, approved: [DEFAULT, other] }), check: run.check, now: () => Date.parse(NOW) });
    expect(run.calls).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(result.definition.models?.approved[1]?.lastCheck).toBeUndefined();
  });
});

// Ruling DY (review I-3): a registration is refused only for a failure about the model; anything that can be the caller's own access, a throttle or an outage is a warning, recorded as unchecked.
describe("what refuses a registration, and what only warns (Ruling DY)", () => {
  const quota = (tokensPerMinute: number | null) => ({ scope: "geographic" as const, code: "L-QUOTA", tokensPerMinute });
  const refused: Array<[string, string, ModelCheckResult]> = [
    ["model-not-found", "anthropic", failed("model-not-found", "not_found_error")],
    ["not-in-catalog", "anthropic", failed("not-in-catalog", "not-in-catalog")],
    ["key-rejected on a keyed provider", "anthropic", failed("key-rejected")],
    ["a Bedrock quota known to be 0", "amazon-bedrock", failed("limit-or-rate-limited", "ThrottlingException", quota(0))],
  ];
  const warned: Array<[string, string, ModelCheckResult]> = [
    ["key-rejected on Amazon Bedrock (the caller's own access may be denied)", "amazon-bedrock", failed("key-rejected", "AccessDeniedException")],
    ["a Bedrock throttle with a quota above 0", "amazon-bedrock", failed("limit-or-rate-limited", "ThrottlingException", quota(5_000_000))],
    ["a Bedrock throttle whose quota could not be read", "amazon-bedrock", failed("limit-or-rate-limited", "ThrottlingException", quota(null))],
    ["a keyed provider's rate limit", "openai", failed("limit-or-rate-limited")],
    ["an outage", "anthropic", failed("provider-outage")],
    ["unreachable", "anthropic", failed("unreachable", "ENOTFOUND")],
    ["unknown", "anthropic", failed("unknown")],
    ["a key secret the caller cannot read", "anthropic", failed("secret-unreadable", "secret-unreadable")],
    ["a refused request", "anthropic", failed("request-rejected")],
  ];
  const withDefault = (provider: string) => definition({ default: { ...DEFAULT, provider, modelId: provider === "amazon-bedrock" ? "us.anthropic.claude-sonnet-4-6" : "claude-sonnet-4-6" }, approved: [{ ...DEFAULT, provider, modelId: provider === "amazon-bedrock" ? "us.anthropic.claude-sonnet-4-6" : "claude-sonnet-4-6" }] });
  const only = (result: ModelCheckResult) => ({ check: async () => result });

  it.each(refused)("refuses the default model's registration on %s, naming the override", async (_label, provider, result) => {
    const error = await checkProjectModels({ definition: withDefault(provider), check: only(result).check, now: () => Date.parse(NOW) }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("was not registered");
    expect(error?.message).toContain('--accept-unchecked-model "<reason>"');
  });

  it.each(refused)("registers a refused default anyway on %s when the administrator accepts it with a reason, and records the reason beside the class", async (_label, provider, result) => {
    const accepted = await checkProjectModels({ definition: withDefault(provider), check: only(result).check, now: () => Date.parse(NOW), acceptUnchecked: { reason: "the model arrives with the next quota change" } });
    const record = accepted.definition.models?.default.lastCheck;
    expect(record).toMatchObject({ status: "failed", acceptedReason: "the model arrives with the next quota change" });
    expect(record?.class).toBe((result as { class: string }).class);
    expect(accepted.warnings.join("\n")).toContain("the model arrives with the next quota change");
  });

  it.each(warned)("registers the default model on %s with a warning, and records it as unchecked", async (_label, provider, result) => {
    const outcome = await checkProjectModels({ definition: withDefault(provider), check: only(result).check, now: () => Date.parse(NOW) });
    expect(outcome.definition.models?.default.lastCheck).toEqual({ status: "unchecked", class: (result as { class: string }).class, checkedAt: NOW });
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("could not be checked");
    expect(outcome.warnings[0]).toContain("its first use checks it again");
    expect(outcome.warnings.join(" ")).not.toContain("sk-ant");
  });

  it("stores an approved pair's unchecked state the same way, and only a model-specific failure as failed", async () => {
    const run = checker({ "anthropic/claude-opus-5": failed("provider-outage"), "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0": failed("model-not-found") });
    const outcome = await checkProjectModels({ definition: definition(), check: run.check, now: () => Date.parse(NOW) });
    expect(outcome.definition.models?.approved.map((model) => model.lastCheck?.status)).toEqual(["ok", "unchecked", "failed"]);
  });

  it("registerRevision passes the administrator's acceptance on, and the registered definition carries the reason", async () => {
    const run = checker({ "anthropic/claude-sonnet-4-6": failed("model-not-found") });
    const context = services(run.check);
    await expect(registerRevision({ env: "staging", session, definition: definition(), services: context.services })).rejects.toThrow("was not registered");
    const registered = await registerRevision({ env: "staging", session, definition: definition(), services: { ...context.services, acceptUncheckedModel: "pilot account" } });
    expect(registered.warnings.join("\n")).toContain("pilot account");
    expect((context.plane.registered[0] as { definition: ProjectDefinition }).definition.models?.default.lastCheck).toMatchObject({ status: "failed", class: "model-not-found", acceptedReason: "pilot account" });
  });

  it("drops a stored check from a pair this run did not check (a fixed or changed model must not keep an old verdict)", async () => {
    const stale = { status: "failed" as const, class: "model-not-found" as const, checkedAt: "2026-01-01T00:00:00.000Z" };
    const other = { provider: "some-gateway", modelId: "alpha", label: "Alpha", lastCheck: stale };
    const input = definition({ default: DEFAULT, approved: [{ ...DEFAULT, lastCheck: stale }, other] });
    const checked = await checkProjectModels({ definition: input, check: checker({}).check, now: () => Date.parse(NOW) });
    expect(checked.definition.models?.approved.map((model) => model.lastCheck?.status)).toEqual(["ok", undefined]);
    const unchecked = await checkProjectModels({ definition: input, check: undefined });
    expect(JSON.stringify(unchecked.definition)).not.toContain("lastCheck");
  });
});

describe("doctor lists every approved pair of every registered project", () => {
  it("checks each distinct pair once, and names the project and the model", async () => {
    const stored = definition();
    await writeProjectFile(configDir, stored, { env: "staging", binding: { launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: 20, volumeType: "gp3" } as never });
    const calls: string[] = [];
    const checks = passingChecks({
      converse: async (modelId) => { calls.push(`bedrock/${modelId}`); },
      directProvider: async (provider, modelId) => {
        calls.push(`${provider}/${modelId}`);
        if (modelId === "claude-opus-5") throw Object.assign(new Error(SECRET_TEXT), { name: "ProviderCheckHttpError", status: 404 });
      },
    });
    const found = await projectModelChecks(doctorContext({ services: doctorServices({ checks, configDir }) }));
    expect(found.map((entry) => [entry.name, entry.status])).toEqual([
      ["payments: Sonnet", "ok"], ["payments: Opus", "warn"], ["payments: Fast", "ok"],
    ]);
    expect(found[1]!.detail).toBe("Anthropic does not have claude-opus-5 for this account; check the model id, or choose another model.");
    expect(JSON.stringify(found)).not.toContain("sk-ant");
    expect(calls.filter((call) => call === "anthropic/claude-opus-5")).toHaveLength(1);
  });

  it("fails a default model that does not answer, and says nothing for a project with no models", async () => {
    await writeProjectFile(configDir, definition(), { env: "staging", binding: { launchTemplateId: "lt-0123456789abcdef0", subnets: [], volumeSizeGib: 20, volumeType: "gp3" } as never });
    const denied = passingChecks({ directProvider: async () => { throw Object.assign(new Error("refused"), { status: 401 }); } });
    const found = await projectModelChecks(doctorContext({ services: doctorServices({ checks: denied, configDir }) }));
    expect(found.find((entry) => entry.name === "payments: Sonnet")).toMatchObject({ status: "fail", detail: "Anthropic refused the key for claude-sonnet-4-6; check the key, and that it may use this model." });
    await rm(join(configDir, "payments.yaml"));
    await writeProjectFile(configDir, definition(null), { env: "staging", binding: { launchTemplateId: "lt-0123456789abcdef0", subnets: [], volumeSizeGib: 20, volumeType: "gp3" } as never });
    expect(await projectModelChecks(doctorContext({ services: doctorServices({ configDir }) }))).toEqual([]);
  });
});

describe("@agentx use warns for a pair whose last check failed", () => {
  const options = (lastCheck?: unknown) => ProjectModelOptionsSchema.parse({
    projectName: "payments",
    approved: [{ provider: "anthropic", modelId: "claude-sonnet-4-6", label: "Sonnet" }, { provider: "anthropic", modelId: "claude-opus-5", label: "Opus", ...(lastCheck === undefined ? {} : { lastCheck }) }],
    current: { provider: "anthropic", modelId: "claude-sonnet-4-6", label: "Sonnet" }, source: "default",
  });
  const message = (text: string) => ({ version: 1 as const, eventId: "EvMODEL0002", thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, userId: "U0123456789", text, receivedAt: NOW });
  async function use(lastCheck?: unknown) {
    const posts: string[] = [];
    const selected = options(lastCheck);
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: vi.fn(), startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
        listProjectModels: async () => selected,
        selectProjectModel: vi.fn(async () => ({ ...selected, current: selected.approved[1]!, source: "selection" as const })),
      }),
      threads: { load: vi.fn(), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
      runTurn: vi.fn(), post: async (_thread, text) => { posts.push(text); },
    };
    await processSlackRequest(message("<@UAGENTX> use opus"), dependencies, { finalAttempt: false });
    return posts;
  }

  it("switches, and adds the class sentence when the stored check failed", async () => {
    const [post] = await use({ status: "failed", class: "model-not-found", checkedAt: NOW });
    expect(post).toContain("now uses Opus");
    expect(post).toContain("The last check of this model failed: Anthropic does not have claude-opus-5 for this account; check the model id, or choose another model. Its next turn may fail; ask a project admin to run agentx doctor.");
  });

  it("says nothing extra when the check passed or never ran", async () => {
    for (const lastCheck of [undefined, { status: "ok", checkedAt: NOW }]) expect((await use(lastCheck))[0]).not.toContain("last check");
  });
});
