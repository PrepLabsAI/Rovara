// Core switch-on blocker (2026-11-17): the core engine's model gateway and agent model are stack parameters of the named control plane (CoreModelGatewayHost, CoreAgentModel),
// packed for the broker and the dispatcher (which read ROVARA_CORE_MODEL_GATEWAY_URL = https://<host> and ROVARA_CORE_AGENT_MODEL), set with `agentx config set
// coreEngine.modelGatewayUrl` / `coreEngine.agentModel`, and kept across upgrades. Before this they could only be set by a template overlay, which every `agentx upgrade` dropped,
// so the core then refused work. The synthesized templates are checked in core-engine-infrastructure.test.ts ("the model gateway settings").
import { describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTING_VALUE, CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PATTERN, CORE_ANSWERS_MODEL_VARIABLE, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_PATTERN, CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_OFFERED_MODELS_ADMIN_PATH, isCoreAgentModelId } from "@agentx/contracts";
import { hydrateBrokerEnvironment, hydrateBrokerSettings } from "../../packages/broker/src/aws/broker-environment.js";
import { gatewayModelKeysModules, readGatewayModelAccess } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { runConfigGet, runConfigList, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { deployEnvironment } from "../../packages/cli/src/deploy/deploy-environment.js";
import { allStackOutputs, fakeRelease, memoryInitSecrets, sampleAnswers, scriptedDeployer, HOLDER } from "../support/init-fakes.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { updateStackParameters } from "../../packages/cli/src/deploy/parameter-update.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { ADMIN_SESSION, fakeChangeRecorder, seeded, services as configServices, stacks as configStacks } from "../support/config-services.js";
import { GATEWAY_CONVERSE_MODELS, GATEWAY_OFFERED_MODELS, offeredAnswer } from "../support/offered-models-fake.js";

const ENV = "staging";
const HOST = "gateway.staging.example.dev";
const GATEWAY = `https://${HOST}`;
const MODEL = "claude-sonnet-4-6";
const URL_KEY = "coreEngine.modelGatewayUrl";
const MODEL_KEY = "coreEngine.agentModel";
// DEC 254zzz224: config activation requires an installed price-serving broker and
// a gateway that can enforce signed ceilings. Keep these fixtures local so tests
// of older installs elsewhere still exercise the missing-capability refusal.
const stacks: typeof configStacks = (parameters) => {
  const source = configStacks(parameters);
  return { describe: async (name) => {
    const stack = await source.describe(name);
    return stack === undefined ? undefined : { ...stack, outputs: { ...stack.outputs, ModelRunPriceVersion: "1" } };
  } };
};
const services: typeof configServices = (overrides) => {
  const configured = configServices(overrides);
  const transport = configured.fetch!;
  configured.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === GATEWAY && url.pathname === "/healthz") {
      expect(init?.redirect).toBe("error");
      return Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } });
    }
    return transport(input, init);
  };
  return configured;
};
const URL_ALLOWED = `${URL_KEY} must be empty (none) or the model gateway's https origin, such as https://gateway.example.com, with no user name, password, path, query or fragment and a host of at most ${CORE_MODEL_GATEWAY_HOST_MAX_LENGTH} characters; nothing changed`;
const MODEL_ALLOWED = `${MODEL_KEY} must be empty (none), an Anthropic model id this Rovara knows, such as claude-sonnet-4-6 (not a Bedrock us.anthropic. id), or the exact id of a model the model gateway offers, such as zai.glm-5 (lowercase letters, digits and . _ : - or an exact vendor/model ID, at most ${CORE_AGENT_MODEL_MAX_LENGTH} characters); nothing changed`;
/** DEC 254g: the strongest GLM model the gateway offers. */
const GLM = "zai.glm-5";
/** Well-formed ids no list in Code names: the gateway, not Code, decides whether it offers them. */
const WELL_FORMED = ["zai.glm-9", "us.zai.glm-5", "global.zai.glm-5.3", "deepseek.v3.2", "zai.glm-5:0", "zai.glm-5.", "qwen.qwen3-coder-480b-a35b-v1:1", "a", `a${"b".repeat(63)}`, "openai/gpt-5-mini", `a${"b".repeat(62)}/c${"d".repeat(62)}`];
/** Malformed ids: refused by the stack pattern itself (no URL, path, credentials, packing separator, space, quote, newline or upper case, and not too long). */
const MALFORMED = ["https://evil.example/zai.glm-5", "zai/glm-5/other", "zai glm-5", "zai,glm-5", "zai=glm-5", "zai.glm-5,am=x", "u:p@zai.glm-5", "zai.glm-5 ", " zai.glm-5", "ZAI.GLM-5", "zai.glm-5\n", "zai.glm-5\nam=x",
  "zai\"glm", "zai'glm", "zai;glm", "zai$(id)", "zai`id`", ".zai.glm-5", "-zai", "_zai", ":zai", `a${"b".repeat(CORE_AGENT_MODEL_MAX_LENGTH)}`, "arn:aws:bedrock:us-west-2:123456789012:inference-profile/x"];

describe("the broker reads the packed settings back", () => {
  it("has the packed codes: gw (a host, read as its https origin) and am", () => {
    expect(BROKER_SETTINGS.coreModelGateway).toEqual({ code: "gw", variable: CORE_MODEL_GATEWAY_URL_VARIABLE, httpsOrigin: true });
    expect(BROKER_SETTINGS.coreAgentModel).toEqual({ code: "am", variable: CORE_AGENT_MODEL_VARIABLE });
  });

  const named = (settings: string) => ({ AGENTX_SETTINGS: settings, AGENTX_NAMES: "", AGENTX_ENV: ENV, AGENTX_ACCOUNT_ID: "123456789012", AWS_REGION: "us-west-2" }) as Record<string, string | undefined>;

  it("leaves empty settings empty (the defaults), which the core reads as not configured: the switch stays refused by name", () => {
    const env = named("am=,gw=");
    hydrateBrokerSettings(env);
    expect(env[CORE_MODEL_GATEWAY_URL_VARIABLE]).toBe("");
    expect(env[CORE_AGENT_MODEL_VARIABLE]).toBe("");
    expect(readGatewayModelAccess(env)).toBeUndefined();
    // No model-keys adapter: the registry then refuses the core switch by name (gateway-model-access.ts).
    expect(gatewayModelKeysModules(env)).toEqual([]);
  });

  it("refuses one without the other in fixed words, never echoing the value", () => {
    for (const settings of [`am=,gw=${HOST}`, `am=${MODEL},gw=`]) {
      const env = named(settings);
      hydrateBrokerSettings(env);
      const read = readGatewayModelAccess(env);
      expect(read, settings).toHaveProperty("problem");
      expect(JSON.stringify(read)).not.toContain(HOST);
    }
  });

});

describe("the stack parameters' own patterns", () => {
  const host = new RegExp(CORE_MODEL_GATEWAY_HOST_PATTERN, "u");
  const model = new RegExp(CORE_AGENT_MODEL_PATTERN, "u");

  it.each(["", HOST, "gw.example.com:8443", `${"a".repeat(27)}.gateway-region-4.example.com`])("the host pattern admits %j", (value) => {
    expect(host.test(value)).toBe(true);
  });
  it.each([
    GATEWAY, "http://gateway.example.dev", "user:pass@gateway.example.dev", "user@gateway.example.dev", "gateway.example.dev/", "gateway.example.dev/v1",
    "gateway.example.dev?x=1", "gateway.example.dev#a", "Gateway.example.dev", "localhost", " gateway.example.dev", "gw.example.dev,x=y", "gw.example.dev=", "gw.example.dev:0443", "gw.example.dev:0",
  ])("the host pattern refuses %j", (value) => {
    expect(host.test(value)).toBe(false);
  });
  it.each(["", MODEL, "claude-opus-4-5-20251101", "claude-haiku-4-5"])("the model pattern admits %j", (value) => {
    expect(model.test(value)).toBe(true);
  });
  // The stack pattern is only the well-formed check; Claude's own rule (an engine name, never a Bedrock us.anthropic. id) is isCoreAgentModelId's, in the CLI and the broker (below).
  it.each(["Claude-sonnet-4-6", "claude-sonnet 4", "claude-a,b", `claude-${"a".repeat(64)}`])("the model pattern refuses %j", (value) => {
    expect(model.test(value)).toBe(false);
  });
  it("admits any well-formed id (DEC 254g): no list in Code, the gateway decides what it offers", () => {
    for (const value of [...WELL_FORMED, ...GATEWAY_OFFERED_MODELS]) {
      expect(model.test(value), value).toBe(true);
      expect(value.length, value).toBeLessThanOrEqual(CORE_AGENT_MODEL_MAX_LENGTH);
    }
  });
  it.each(MALFORMED)("the model pattern refuses the malformed id %j", (value) => {
    expect(model.test(value)).toBe(false);
  });
  it("admits only what the broker's packed settings can hold (no separator can pass)", () => {
    for (const value of [...WELL_FORMED, ...GATEWAY_OFFERED_MODELS]) expect(BROKER_SETTING_VALUE.test(value), value).toBe(true);
  });
});

describe("a well-formed core agent model id (DEC 254g)", () => {
  it("is any id the pattern admits, including every model the gateway offers", () => {
    for (const value of [...WELL_FORMED, ...GATEWAY_OFFERED_MODELS]) expect(isCoreAgentModelId(value), value).toBe(true);
  });
  it("is never empty, malformed, or a Claude or Anthropic name other than a Claude engine name", () => {
    for (const value of ["", ...MALFORMED, "us.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6-v1:0", "global.anthropic.claude-opus-4-5", "claude-", "claude-sonnet 4", `claude-${"a".repeat(33)}`, "myclaude-x"]) {
      expect(isCoreAgentModelId(value), value).toBe(false);
    }
    expect(isCoreAgentModelId(MODEL)).toBe(true);
  });
  it("keeps no pinned list of the gateway's models", async () => {
    const contracts = await import("@agentx/contracts") as Record<string, unknown>;
    expect(contracts).not.toHaveProperty("CORE_GATEWAY_CONVERSE_AGENT_MODELS");
    expect(contracts).not.toHaveProperty("isGatewayConverseAgentModel");
  });
});

describe("the config keys", () => {

  it.each([""])("reads %j as empty (the gateway not configured)", (value) => {
    expect(configKey(URL_KEY).parse(value)).toBe("");
    expect(configKey(MODEL_KEY).parse(value)).toBe("");
  });

  it.each([ "https://gateway.example.dev/v1/messages", "gateway.example.dev",
    "https://localhost",
  ])("refuses the URL %j before any deploy, without echoing it", (value) => {
    let message = "";
    try { configKey(URL_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(URL_ALLOWED);
    expect(message).not.toContain("secret-password");
  });

  it.each(["claude-made-up-9", "us.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6-v1:0", "Claude-Sonnet-4-6", "claude sonnet", `claude-${"a".repeat(80)}`, ...MALFORMED.filter((value) => value.trim() === value)])("refuses the model %j", (value) => {
    expect(() => configKey(MODEL_KEY).parse(value)).toThrow(MODEL_ALLOWED);
  });

});

describe("agentx config set", () => {
  const controlPlane = (parameters: Record<string, string>) => stacks({ "agentx-staging-control-plane": { CoreModelGatewayHost: "", CoreAgentModel: "", ...parameters } });
  const changed = (cloudFormation: ReturnType<typeof fakeCloudFormation>) => {
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>>; UsePreviousTemplate?: boolean };
    return { create, values: create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined) };
  };

  it("refuses setting a nonempty agent model until the gateway is configured (DEC 254zzz224)", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: "", CoreAgentModel: "" } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) });
    await expect(runConfigSet(run, ENV, { key: MODEL_KEY, value: MODEL, yes: true }))
      .rejects.toThrow("configure the model gateway before activating the engine");
    expect(cloudFormation.calls).toEqual([]);
  });

  it("clears with none, and says the other one is still set", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }) });
    expect((await runConfigSet(run, ENV, { key: URL_KEY, value: "none", yes: true })).changed).toBe(true);
    expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreModelGatewayHost", ParameterValue: "" }]);
    expect(run.lines).toContain(`Note: ${MODEL_KEY} is still set; with ${URL_KEY} empty the core engine refuses work. To turn the gateway off fully, also run agentx --env staging config set ${MODEL_KEY} none`);
  });

  describe("a model other than Claude is checked against the gateway's LIVE offered models before any deploy (DEC 254g)", () => {
    /** The broker's admin read of the gateway's offered models (`answer`), beside the change recorder; `asked` holds each read's URL and headers. */
    const withGateway = (answer: () => Response | Promise<Response>) => {
      const recorder = fakeChangeRecorder();
      const asked: Array<{ url: string; authorization: string | null; method: string | undefined }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === CORE_OFFERED_MODELS_ADMIN_PATH) {
          asked.push({ url: url.toString(), authorization: new Headers(init?.headers).get("authorization"), method: init?.method });
          return await answer();
        }
        return await recorder(input, init);
      }) as typeof fetch;
      return { fetch: fetchImpl, asked, records: recorder.records };
    };
    // As the broker's admin read answers it: the contract, plus the broker's own requestId.
    const offering = (names: readonly string[]) => () => Response.json({ ...offeredAnswer(names), requestId: "00000000-0000-4000-8000-000000000001" });
    const run = async (value: string, gateway: ReturnType<typeof withGateway>, overrides: Record<string, unknown> = {}) => {
      const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
      const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }), fetch: gateway.fetch, ...overrides });
      return { cloudFormation, configured, result: runConfigSet(configured, ENV, { key: MODEL_KEY, value, yes: true }) };
    };

    it("refuses an id the gateway does not offer, naming a few it does, before any AWS call or change record", async () => {
      const gateway = withGateway(offering(GATEWAY_OFFERED_MODELS));
      const { cloudFormation, result } = await run("zai.glm-9", gateway);
      await expect(result).rejects.toThrow(`${MODEL_KEY} was not changed: the model gateway does not offer zai.glm-9 to this company; it offers ${GATEWAY_CONVERSE_MODELS.slice(0, 5).join(", ")}, and ${GATEWAY_OFFERED_MODELS.length - 5} more; nothing changed`);
      expect(gateway.asked).toHaveLength(1);
      expect(cloudFormation.calls).toEqual([]);
      expect(gateway.records).toEqual([]);
    });

    it("names as examples only ids this setting can hold", async () => {
      const gateway = withGateway(offering(["Acme.Upper-Case", `a${"b".repeat(80)}`, "zai.glm-4.7"]));
      const { result } = await run("zai.glm-5", gateway);
      await expect(result).rejects.toThrow("the model gateway does not offer zai.glm-5 to this company; it offers zai.glm-4.7; nothing changed");
      const none = await run("zai.glm-5", withGateway(offering(["Acme.Upper-Case"])));
      await expect(none.result).rejects.toThrow("it offers no model this setting can hold; nothing changed");
    });

    it.each([
      ["a server error", () => new Response("upstream secret-host.internal said no", { status: 503 })],
      ["not the contract", () => Response.json({ version: 1, models: [] })],
      ["too large", () => new Response(JSON.stringify(offeredAnswer([GLM])) + " ".repeat(70_000), { status: 200 })],
    ] as const)("fails closed when the gateway's answer is %s, in fixed words", async (_name, answer) => {
      const { cloudFormation, result } = await run(GLM, withGateway(answer));
      const error = await result.then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).toContain(`${MODEL_KEY} was not changed: the models the model gateway offers could not be read just now, so ${GLM} could not be checked; nothing changed, try again`);
      expect(error?.message).not.toContain("secret-host");
      expect(cloudFormation.calls).toEqual([]);
    });

    it("says the gateway must be set first when the broker has none (404)", async () => {
      const { cloudFormation, result } = await run(GLM, withGateway(() => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })));
      await expect(result).rejects.toThrow(`${MODEL_KEY} was not changed: the model gateway is not set up on staging yet, so ${GLM} cannot be checked; set coreEngine.modelGatewayUrl first`);
      expect(cloudFormation.calls).toEqual([]);
    });

    it("refuses without an admin sign-in, or when the sign-in is refused", async () => {
      const gateway = withGateway(offering(GATEWAY_OFFERED_MODELS));
      const signedOut = await run(GLM, gateway, { adminSession: async () => undefined });
      await expect(signedOut.result).rejects.toThrow(`run agentx --env staging login --admin, then try again; nothing changed`);
      expect(gateway.asked).toEqual([]);
      for (const status of [401, 403]) {
        const refused = await run(GLM, withGateway(() => new Response("", { status })));
        await expect(refused.result, String(status)).rejects.toThrow("would not show the models the model gateway offers to this computer's admin sign-in");
        expect(refused.cloudFormation.calls).toEqual([]);
      }
    });

    // P0-14: an install operator is usually in no company, so `--company` names whose offered models to check; the broker answers 400 for an unnamed or unknown company.
    it("with --company, asks the broker's admin read for that company, then changes only CoreAgentModel", async () => {
      const gateway = withGateway(offering(GATEWAY_OFFERED_MODELS));
      const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
      const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }), fetch: gateway.fetch });
      expect((await runConfigSet(configured, ENV, { key: MODEL_KEY, value: GLM, yes: true, company: "org_aaaaaaaaaaaaaaaaaaaa" })).changed).toBe(true);
      expect(gateway.asked).toEqual([{ url: `${ADMIN_SESSION.controlPlaneUrl}${CORE_OFFERED_MODELS_ADMIN_PATH}?companyId=org_aaaaaaaaaaaaaaaaaaaa`, authorization: `Bearer ${ADMIN_SESSION.accessToken}`, method: "GET" }]);
      expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreAgentModel", ParameterValue: GLM }]);
    });

    it("turns the broker's 400 into a clear way out (name the company, or a known one), never login --admin, before any AWS call", async () => {
      const refusal = () => Response.json({ error: { code: "CONFIG_INVALID" } }, { status: 400 });
      const unnamed = await run(GLM, withGateway(refusal));
      await expect(unnamed.result).rejects.toThrow(`${MODEL_KEY} was not changed: this computer's admin sign-in for staging is not a member of a company, so name the company whose offered models to check: agentx --env staging config set ${MODEL_KEY} ${GLM} --company <company id>; nothing changed`);
      expect(unnamed.cloudFormation.calls).toEqual([]);
      const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
      const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }), fetch: withGateway(refusal).fetch });
      await expect(runConfigSet(configured, ENV, { key: MODEL_KEY, value: GLM, yes: true, company: "org_bbbbbbbbbbbbbbbbbbbb" }))
        .rejects.toThrow(`${MODEL_KEY} was not changed: org_bbbbbbbbbbbbbbbbbbbb is not one of the companies on staging, so ${GLM} cannot be checked for it; give a company id from Code's company records; nothing changed`);
      expect(cloudFormation.calls).toEqual([]);
      // A control plane from before --company still refuses with 401: the refusal says it may need an upgrade, and only when --company was given.
      const older = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }), fetch: withGateway(() => new Response("", { status: 401 })).fetch });
      await expect(runConfigSet(older, ENV, { key: MODEL_KEY, value: GLM, yes: true, company: "org_bbbbbbbbbbbbbbbbbbbb" })).rejects.toThrow("may be from before --company; upgrade it");
      const plain = await run(GLM, withGateway(() => new Response("", { status: 401 })));
      const error = await plain.result.then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).not.toContain("before --company");
    });

    it("refuses a malformed --company, or --company on a key it means nothing for, before asking anything", async () => {
      const gateway = withGateway(() => { throw new Error("must not be asked"); });
      for (const [key, value, company, message] of [[MODEL_KEY, GLM, "org_../../x", "--company must be a company id"], [MODEL_KEY, GLM, "ORG_AAAAAAAAAAAAAAAAAAAA", "--company must be a company id"],
        [URL_KEY, GATEWAY, "org_aaaaaaaaaaaaaaaaaaaa", `--company is only for a key checked against the model gateway's offered models, not ${URL_KEY}`]] as const) {
        const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
        const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }), fetch: gateway.fetch });
        await expect(runConfigSet(configured, ENV, { key, value, yes: true, company }), company).rejects.toThrow(message);
        expect(cloudFormation.calls, company).toEqual([]);
      }
      expect(gateway.asked).toEqual([]);
    });

    it("keeps a Claude id on its catalog rule: readiness check only, no offered-model read", async () => {
      const gateway = withGateway(() => { throw new Error("must not be asked"); });
      const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: "" } });
      const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST }), fetch: gateway.fetch });
      expect((await runConfigSet(configured, ENV, { key: MODEL_KEY, value: "claude-haiku-4-5", yes: true })).changed).toBe(true);
      expect(gateway.asked).toEqual([]);
    });

  });

  it.each([
    [URL_KEY, GATEWAY, "CoreModelGatewayHost"],
    [MODEL_KEY, "claude-haiku-4-5", "CoreAgentModel"],
  ] as const)("enforces broker then signed gateway readiness before activating %s", async (key, value, parameter) => {
    for (const state of ["old-broker", "unsigned-gateway", "ready"] as const) {
      const parameters = { CoreModelGatewayHost: key === URL_KEY ? "" : HOST, CoreAgentModel: MODEL };
      const cloudFormation = fakeCloudFormation({ parameters });
      const recorder = fakeChangeRecorder();
      const health: string[] = [];
      const run = configServices({ store: await seeded(), cloudFormation,
        stacks: { describe: async () => ({ status: "UPDATE_COMPLETE", parameters, outputs: state === "old-broker" ? {} : { ModelRunPriceVersion: "1" } }) },
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.pathname !== "/healthz") return recorder(input, init);
          health.push(url.toString());
          return Response.json({ runPrice: { version: 1, snapshotVersion: 7, ...(state === "ready" ? { admissionVersion: 1 } : {}) } });
        },
      });
      const change = runConfigSet(run, ENV, { key, value, yes: true });
      if (state === "ready") {
        expect(await change).toEqual({ changed: true });
        expect(changed(cloudFormation).values).toEqual([{ ParameterKey: parameter, ParameterValue: parameter === "CoreModelGatewayHost" ? HOST : value }]);
      } else {
        await expect(change).rejects.toThrow(state === "old-broker" ? "price-serving broker" : "gateway must serve run prices");
        expect(cloudFormation.calls).toEqual([]);
        expect(recorder.records).toEqual([]);
      }
      expect(health).toEqual(state === "old-broker" ? [] : [`${GATEWAY}/healthz`]);
    }
  });

  it("says nothing changes when the stack already has the value, naming the origin", async () => {
    const cloudFormation = fakeCloudFormation();
    const run = services({ store: await seeded(), cloudFormation, stacks: configStacks({ "agentx-staging-control-plane": { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } }), fetch: async () => { throw new Error("a no-op must not fetch"); } });
    expect((await runConfigSet(run, ENV, { key: URL_KEY, value: GATEWAY, yes: true })).changed).toBe(false);
    expect(run.lines).toContain(`${URL_KEY} is already ${GATEWAY}; nothing to change`);
    expect(cloudFormation.calls).toEqual([]);
  });

  it("shows the origin the functions read, or empty when unset or the stack predates the parameter", async () => {
    const store = await seeded();
    expect((await runConfigGet(services({ store, stacks: controlPlane({ CoreModelGatewayHost: HOST }) }), ENV, URL_KEY)).value).toBe(GATEWAY);
    expect((await runConfigGet(services({ store, stacks: controlPlane({}) }), ENV, URL_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: stacks({ "agentx-staging-control-plane": {} }) }), ENV, MODEL_KEY)).value).toBe("");
    const rows = await runConfigList(services({ store, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }) }), ENV);
    expect(rows.find((row) => row.key === URL_KEY)?.value).toBe(GATEWAY);
    expect(rows.find((row) => row.key === MODEL_KEY)?.value).toBe(MODEL);
  });

  it("asks for an upgrade first when the stack has no such parameter", async () => {
    const cloudFormation = fakeCloudFormation();
    await expect(updateStackParameters({ cloudFormation, stackName: "agentx-staging-control-plane", roleArn: "arn:aws:iam::123456789012:role/x", changes: { CoreModelGatewayHost: HOST }, label: "config", confirm: async () => true, write: () => undefined }))
      .rejects.toThrow("stack agentx-staging-control-plane has no CoreModelGatewayHost parameter; it runs an older AgentX release, so upgrade it with agentx upgrade, then run this again");
  });
});

// L4-AM (DEC 254zzn(2)): the hosted answers model, `agentx config set coreEngine.answersModel`. Empty = the agent model answers (today's behaviour).
describe("coreEngine.answersModel (the hosted answers model)", () => {
  const ANSWERS_KEY = "coreEngine.answersModel";
  const ANSWERS_MODEL = "claude-haiku-5-5";
  const ANSWERS_ALLOWED = `${ANSWERS_KEY} must be empty (none: answers use the agent model) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: the answers run on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_ANSWERS_MODEL_MAX_LENGTH} characters)`;

  it.each([""])("reads %j as empty (the agent model answers)", (value) => {
    expect(configKey(ANSWERS_KEY).parse(value)).toBe("");
  });

  it("accepts an Anthropic model id the catalog knows, trimmed, and stores only what the stack parameter admits", () => {
    for (const value of [ANSWERS_MODEL, MODEL, "claude-sonnet-4-5-20250929"]) {
      const stored = configKey(ANSWERS_KEY).parse(` ${value} `);
      expect(stored).toBe(value);
      expect(new RegExp(CORE_ANSWERS_MODEL_PATTERN, "u").test(stored)).toBe(true);
    }
  });

  it.each([
    "claude-made-up-9",
  ])("refuses %j, without echoing it", (value) => {
    let message = "";
    try { configKey(ANSWERS_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(ANSWERS_ALLOWED);
    expect(message).not.toContain("evil.example");
  });

  it("is read by the broker (packed aa) and nothing else changes: the agent model and the gateway read back as before", () => {
    expect(BROKER_SETTINGS.coreAnswersModel).toEqual({ code: "aa", variable: CORE_ANSWERS_MODEL_VARIABLE });
    const env = { AGENTX_SETTINGS: `aa=${ANSWERS_MODEL},am=${MODEL},gw=${HOST}`, AGENTX_NAMES: "", AGENTX_ENV: ENV, AGENTX_ACCOUNT_ID: "123456789012", AWS_REGION: "us-west-2" } as Record<string, string | undefined>;
    hydrateBrokerEnvironment(env);
    expect(env[CORE_ANSWERS_MODEL_VARIABLE]).toBe(ANSWERS_MODEL);
    expect(readGatewayModelAccess(env)).toMatchObject({ gatewayUrl: GATEWAY, route: { alias: MODEL, catalog: MODEL } });
    const empty = { ...env, AGENTX_SETTINGS: `aa=,am=${MODEL},gw=${HOST}` } as Record<string, string | undefined>;
    delete empty[CORE_ANSWERS_MODEL_VARIABLE];
    hydrateBrokerEnvironment(empty);
    expect(empty[CORE_ANSWERS_MODEL_VARIABLE]).toBe("");
  });
});

// DEC 254zzz58/63: the hosted lessons learning model, `agentx config set coreEngine.learningModel`. Empty = claude-haiku-5-5 (a company may choose its own).
describe("coreEngine.learningModel (the hosted lessons learning model)", () => {
  const LEARNING_KEY = "coreEngine.learningModel";
  const LEARNING_MODEL = "claude-haiku-5-5";
  const LEARNING_ALLOWED = `${LEARNING_KEY} must be empty (none: Claude Haiku 5.5, claude-haiku-5-5) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: lessons learn on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_LEARNING_MODEL_MAX_LENGTH} characters)`;

  it.each([""])("reads %j as empty (the default, claude-haiku-5-5)", (value) => {
    expect(configKey(LEARNING_KEY).parse(value)).toBe("");
  });

  it("accepts an Anthropic model id the catalog knows, trimmed, and stores only what the stack parameter admits", () => {
    for (const value of [LEARNING_MODEL, MODEL, "claude-sonnet-4-5-20250929"]) {
      const stored = configKey(LEARNING_KEY).parse(` ${value} `);
      expect(stored).toBe(value);
      expect(new RegExp(CORE_LEARNING_MODEL_PATTERN, "u").test(stored)).toBe(true);
    }
  });

  it.each([
    "claude-made-up-9",
  ])("refuses %j, without echoing it", (value) => {
    let message = "";
    try { configKey(LEARNING_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(LEARNING_ALLOWED);
    expect(message).not.toContain("evil.example");
  });

});

// Retaining a configured value must not make an unrelated upgrade depend on readiness.
describe.each(["templates", "cdk"] as const)("%s upgrade readiness scope", (engine) => {
  const answers = { env: "staging", region: "us-east-1", account: "123456789012", models: sampleAnswers().models, identity: { mode: "cognito" } as const, github: { account: "acme", appId: "123", privateKeySecretArn: "test" } };
  const configured = { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL };
  const setup = async (state: "old-broker" | "unavailable-gateway") => {
    const store = await seeded();
    const { readEnvironmentSettings, writeEnvironmentSettings } = await import("../../packages/cli/src/environments/settings.js");
    const settings = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...settings, engine, stacks: { ...settings.stacks, access: "agentx-staging-access", identity: "agentx-staging-identity" } });
    const outputs = allStackOutputs();
    if (state === "old-broker") delete outputs["agentx-staging-control-plane"]!.ModelRunPriceVersion;
    const deployer = scriptedDeployer(outputs, Object.keys(outputs));
    const transport = vi.fn<typeof fetch>(async () => { throw new Error("private upstream detail"); });
    vi.stubGlobal("fetch", transport);
    const release = fakeRelease();
    release.template = () => JSON.stringify({ Parameters: { CoreModelGatewayHost: {}, CoreAgentModel: {} }, Outputs: { ModelRunPriceVersion: { Value: "1" } } });
    return { store, deployer, release, transport, secrets: memoryInitSecrets() };
  };

  it.each(["old-broker", "unavailable-gateway"] as const)("refuses unchanged configured settings with an %s", async (state) => {
    for (const parts of [["access", "control-plane", "runtime"], ["control-plane"], ["runtime"]] as const) {
      const h = await setup(state);
      const before = new Map(h.store.values);
      try {
        await expect(deployEnvironment({ ...h, mode: "upgrade", engine, holder: HOLDER, answers, parts: [...parts], deployedParameters: async () => configured }))
          .rejects.toThrow(parts.length === 1 && parts[0] === "runtime" && state === "old-broker" ? "price-serving broker" : "gateway must serve run prices");
        expect(h.deployer.requests).toEqual([]); expect(h.secrets.values.size).toBe(0); expect(h.store.values).toEqual(before);
      } finally { vi.unstubAllGlobals(); }
    }
  });
  it.each(["old-broker", "unavailable-gateway"] as const)("refuses an artifact lacking broker prices before gateway or writes (%s)", async (state) => {
    const h = await setup(state); h.release.template = () => JSON.stringify({ Parameters: { CoreModelGatewayHost: {}, CoreAgentModel: {} } });
    try {
      await expect(deployEnvironment({ ...h, mode: "upgrade", engine, holder: HOLDER, answers, parts: ["access", "control-plane", "runtime"], deployedParameters: async () => configured })).rejects.toThrow("release must contain a price-serving broker");
      expect(h.deployer.requests).toEqual([]); expect(h.secrets.values.size).toBe(0); expect(h.transport).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("rechecks the final gateway before deploying runtime", async () => {
    const h = await setup("unavailable-gateway");
    h.transport.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes("changed.example")) throw new Error("unavailable");
      return Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } });
    });
    let reads = 0;
    try {
      await expect(deployEnvironment({ ...h, mode: "upgrade", engine, holder: HOLDER, answers, parts: ["control-plane", "runtime"],
        deployedParameters: async (name) => name.endsWith("control-plane") ? (++reads <= 2 ? configured : { ...configured, CoreModelGatewayHost: "changed.example" }) : {},
      })).rejects.toThrow("gateway must serve run prices");
      expect(h.deployer.requests.map(({ part }) => part)).toEqual(["control-plane"]);
    } finally { vi.unstubAllGlobals(); }
  });
});
