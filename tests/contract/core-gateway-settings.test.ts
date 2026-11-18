// Core switch-on blocker (2026-11-17): the core engine's model gateway and agent model are stack parameters of the named control plane (CoreModelGatewayHost, CoreAgentModel),
// packed for the broker and the dispatcher (which read ROVARA_CORE_MODEL_GATEWAY_URL = https://<host> and ROVARA_CORE_AGENT_MODEL), set with `agentx config set
// coreEngine.modelGatewayUrl` / `coreEngine.agentModel`, and kept across upgrades. Before this they could only be set by a template overlay, which every `agentx upgrade` dropped,
// so the core then refused work. The synthesized templates are checked in core-engine-infrastructure.test.ts ("the model gateway settings").
import { describe, expect, it } from "vitest";
import {
  BROKER_SETTINGS, BROKER_SETTING_VALUE, CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PATTERN, CORE_ANSWERS_MODEL_VARIABLE, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_PATTERN, CORE_LEARNING_MODEL_VARIABLE, CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_VARIABLE, CORE_ENGINE_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_OFFERED_MODELS_ADMIN_PATH, isCoreAgentModelId,
} from "@agentx/contracts";
import { hydrateBrokerEnvironment, hydrateBrokerSettings } from "../../packages/broker/src/aws/broker-environment.js";
import { gatewayModelKeysModules, readGatewayModelAccess } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { runConfigGet, runConfigList, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { configKey, whereText } from "../../packages/cli/src/config/keys.js";
import { updateStackParameters } from "../../packages/cli/src/deploy/parameter-update.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { ADMIN_SESSION, fakeChangeRecorder, seeded, services, stacks } from "../support/config-services.js";
import { GATEWAY_CONVERSE_MODELS, GATEWAY_OFFERED_MODELS, offeredAnswer } from "../support/offered-models-fake.js";

const ENV = "staging";
const HOST = "gateway.staging.example.dev";
const GATEWAY = `https://${HOST}`;
const MODEL = "claude-sonnet-4-6";
const URL_KEY = "coreEngine.modelGatewayUrl";
const MODEL_KEY = "coreEngine.agentModel";
const URL_ALLOWED = `${URL_KEY} must be empty (none) or the model gateway's https origin, such as https://gateway.example.com, with no user name, password, path, query or fragment and a host of at most ${CORE_MODEL_GATEWAY_HOST_MAX_LENGTH} characters; nothing changed`;
const MODEL_ALLOWED = `${MODEL_KEY} must be empty (none), an Anthropic model id this Rovara knows, such as claude-sonnet-4-6 (not a Bedrock us.anthropic. id), or the exact id of a model the model gateway offers, such as zai.glm-5 (lowercase letters, digits and . _ : - only, at most ${CORE_AGENT_MODEL_MAX_LENGTH} characters); nothing changed`;
/** DEC 254g: the strongest GLM model the gateway offers. */
const GLM = "zai.glm-5";
/** Well-formed ids no list in Code names: the gateway, not Code, decides whether it offers them. */
const WELL_FORMED = ["zai.glm-9", "us.zai.glm-5", "global.zai.glm-5.3", "deepseek.v3.2", "zai.glm-5:0", "zai.glm-5.", "qwen.qwen3-coder-480b-a35b-v1:1", "a", `a${"b".repeat(CORE_AGENT_MODEL_MAX_LENGTH - 1)}`];
/** Malformed ids: refused by the stack pattern itself (no URL, path, credentials, packing separator, space, quote, newline or upper case, and not too long). */
const MALFORMED = ["https://evil.example/zai.glm-5", "zai/glm-5", "zai glm-5", "zai,glm-5", "zai=glm-5", "zai.glm-5,am=x", "u:p@zai.glm-5", "zai.glm-5 ", " zai.glm-5", "ZAI.GLM-5", "zai.glm-5\n", "zai.glm-5\nam=x",
  "zai\"glm", "zai'glm", "zai;glm", "zai$(id)", "zai`id`", ".zai.glm-5", "-zai", "_zai", ":zai", `a${"b".repeat(CORE_AGENT_MODEL_MAX_LENGTH)}`, "arn:aws:bedrock:us-west-2:123456789012:inference-profile/x"];

describe("the broker reads the packed settings back", () => {
  it("has the packed codes: gw (a host, read as its https origin) and am", () => {
    expect(BROKER_SETTINGS.coreModelGateway).toEqual({ code: "gw", variable: CORE_MODEL_GATEWAY_URL_VARIABLE, httpsOrigin: true });
    expect(BROKER_SETTINGS.coreAgentModel).toEqual({ code: "am", variable: CORE_AGENT_MODEL_VARIABLE });
    expect(BROKER_SETTINGS.coreEngine).toEqual({ code: "sw", variable: CORE_ENGINE_VARIABLE });
  });

  const named = (settings: string) => ({ AGENTX_SETTINGS: settings, AGENTX_NAMES: "", AGENTX_ENV: ENV, AGENTX_ACCOUNT_ID: "123456789012", AWS_REGION: "us-west-2" }) as Record<string, string | undefined>;

  it("gives the gateway's https origin, the agent model and the switch", () => {
    const env = named(`am=${MODEL},gw=${HOST},sw=on:org_aaaaaaaaaaaaaaaaaaaa`);
    hydrateBrokerEnvironment(env);
    expect(env[CORE_MODEL_GATEWAY_URL_VARIABLE]).toBe(GATEWAY);
    expect(env[CORE_AGENT_MODEL_VARIABLE]).toBe(MODEL);
    expect(env[CORE_ENGINE_VARIABLE]).toBe("on:org_aaaaaaaaaaaaaaaaaaaa");
    expect(env.CHANNEL_ADAPTER_SECRET_PREFIX).toBe("agentx/staging/");
    expect(readGatewayModelAccess(env)).toMatchObject({ gatewayUrl: GATEWAY, route: { catalog: MODEL, api: "anthropic-messages" } });
  });

  it("keeps a port", () => {
    const env = named(`am=${MODEL},gw=gw.example.com:8443`);
    hydrateBrokerSettings(env);
    expect(env[CORE_MODEL_GATEWAY_URL_VARIABLE]).toBe("https://gw.example.com:8443");
    expect(readGatewayModelAccess(env)).toMatchObject({ gatewayUrl: "https://gw.example.com:8443" });
  });

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

  it("never replaces a variable already set", () => {
    const env = { ...named(`gw=${HOST}`), [CORE_MODEL_GATEWAY_URL_VARIABLE]: "https://other.example.dev" };
    hydrateBrokerSettings(env);
    expect(env[CORE_MODEL_GATEWAY_URL_VARIABLE]).toBe("https://other.example.dev");
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
  it("map to the control plane's stack parameters, empty by default, kept across upgrades", () => {
    expect(configKey(URL_KEY)).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreModelGatewayHost" }, defaultValue: "" });
    expect(configKey(MODEL_KEY)).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreAgentModel" }, defaultValue: "" });
    expect(whereText(configKey(URL_KEY).target, ENV)).toBe("stack parameter CoreModelGatewayHost on agentx-staging-control-plane");
    expect(configKey(URL_KEY).model).toBeUndefined();
    expect(configKey(MODEL_KEY).model).toBeUndefined();
    expect(OPERATOR_PARAMETERS["control-plane"]).toEqual(expect.arrayContaining(["CoreModelGatewayHost", "CoreAgentModel"]));
  });

  it("accepts an https origin and stores its host", () => {
    const parse = (value: string): string => configKey(URL_KEY).parse(value);
    expect(parse(` ${GATEWAY} `)).toBe(HOST);
    expect(parse(`${GATEWAY}/`)).toBe(HOST);
    expect(parse("https://GW.Example.com:8443")).toBe("gw.example.com:8443");
    expect(parse(`https://${"a".repeat(27)}.gateway-region-4.example.com`)).toBe(`${"a".repeat(27)}.gateway-region-4.example.com`);
  });

  it.each(["", "none", " none "])("reads %j as empty (the gateway not configured)", (value) => {
    expect(configKey(URL_KEY).parse(value)).toBe("");
    expect(configKey(MODEL_KEY).parse(value)).toBe("");
  });

  it.each([
    "http://gateway.example.dev", "https://user:secret-password@gateway.example.dev", "https://token-secret-password@gateway.example.dev", "https://gateway.example.dev/v1/messages",
    "https://gateway.example.dev?key=secret-password", "https://gateway.example.dev#secret-password", "ftp://gateway.example.dev", "gateway.example.dev", "not a url",
    "https://localhost", "https://gateway_bad.example.dev", `https://${"a".repeat(50)}.example.dev`, "https://bücher.example",
  ])("refuses the URL %j before any deploy, without echoing it", (value) => {
    let message = "";
    try { configKey(URL_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(URL_ALLOWED);
    expect(message).not.toContain("secret-password");
  });

  it("accepts an Anthropic model id the catalog knows", () => {
    expect(configKey(MODEL_KEY).parse(` ${MODEL} `)).toBe(MODEL);
    expect(configKey(MODEL_KEY).parse("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("passes any well-formed id on to the live check (DEC 254g), trimmed", () => {
    expect(configKey(MODEL_KEY).parse(` ${GLM} `)).toBe(GLM);
    for (const value of [...WELL_FORMED, ...GATEWAY_CONVERSE_MODELS]) expect(configKey(MODEL_KEY).parse(value), value).toBe(value);
    expect(configKey(MODEL_KEY).gatewayOffered).toBe(true);
  });

  it.each(["claude-made-up-9", "us.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6-v1:0", "Claude-Sonnet-4-6", "claude sonnet", `claude-${"a".repeat(80)}`, ...MALFORMED.filter((value) => value.trim() === value)])("refuses the model %j", (value) => {
    expect(() => configKey(MODEL_KEY).parse(value)).toThrow(MODEL_ALLOWED);
  });

  it("stores only values the stack parameters admit", () => {
    expect(new RegExp(CORE_MODEL_GATEWAY_HOST_PATTERN, "u").test(configKey(URL_KEY).parse("https://GW.Example.com:8443"))).toBe(true);
    expect(new RegExp(CORE_AGENT_MODEL_PATTERN, "u").test(configKey(MODEL_KEY).parse("claude-sonnet-4-5-20250929"))).toBe(true);
    expect(new RegExp(CORE_AGENT_MODEL_PATTERN, "u").test(configKey(MODEL_KEY).parse(GLM))).toBe(true);
  });
});

describe("agentx config set", () => {
  const controlPlane = (parameters: Record<string, string>) => stacks({ "agentx-staging-control-plane": { CoreEngine: "off", CoreModelGatewayHost: "", CoreAgentModel: "", ...parameters } });
  const changed = (cloudFormation: ReturnType<typeof fakeCloudFormation>) => {
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>>; UsePreviousTemplate?: boolean };
    return { create, values: create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined) };
  };

  it("changes only CoreModelGatewayHost, with the previous template and every other parameter kept", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreEngine: "off", CoreModelGatewayHost: "", CoreAgentModel: MODEL } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreAgentModel: MODEL }) });
    expect((await runConfigSet(run, ENV, { key: URL_KEY, value: `${GATEWAY}/`, yes: true })).changed).toBe(true);
    expect(run.lines).toContain(`${URL_KEY}: CoreModelGatewayHost  -> ${HOST} on agentx-staging-control-plane`);
    const { create, values } = changed(cloudFormation);
    expect(create.UsePreviousTemplate).toBe(true);
    expect(values).toEqual([{ ParameterKey: "CoreModelGatewayHost", ParameterValue: HOST }]);
    expect(create.Parameters).toEqual(expect.arrayContaining([{ ParameterKey: "CoreAgentModel", UsePreviousValue: true }, { ParameterKey: "CoreEngine", UsePreviousValue: true }]));
    expect(run.lines.some((line) => line.startsWith("Note:"))).toBe(false);
  });

  it("sets the agent model, and says the gateway URL is still needed when it is empty", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: "", CoreAgentModel: "" } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) });
    expect((await runConfigSet(run, ENV, { key: MODEL_KEY, value: MODEL, yes: true })).changed).toBe(true);
    expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreAgentModel", ParameterValue: MODEL }]);
    expect(run.lines).toContain(`Note: ${URL_KEY} is not set yet; the core engine refuses work until both ${MODEL_KEY} and ${URL_KEY} are set. Next: agentx --env staging config set ${URL_KEY} <value>`);
  });

  it("clears with none, and says the other one is still set", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }) });
    expect((await runConfigSet(run, ENV, { key: URL_KEY, value: "none", yes: true })).changed).toBe(true);
    expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreModelGatewayHost", ParameterValue: "" }]);
    expect(run.lines).toContain(`Note: ${MODEL_KEY} is still set; with ${URL_KEY} empty the core engine refuses work. To turn the gateway off fully, also run agentx --env staging config set ${MODEL_KEY} none`);
  });

  it("refuses http, a URL with credentials, an unknown Claude model and a malformed id before any AWS call", async () => {
    for (const [key, value] of [[URL_KEY, "http://gateway.example.dev"], [URL_KEY, "https://u:p@gateway.example.dev"], [MODEL_KEY, "claude-made-up-9"], [MODEL_KEY, "us.anthropic.claude-sonnet-4-6"], [MODEL_KEY, "zai.glm-5,am=x"], [MODEL_KEY, "https://evil.example/x"]] as const) {
      const cloudFormation = fakeCloudFormation();
      await expect(runConfigSet(services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) }), ENV, { key, value, yes: true }), value).rejects.toThrow("nothing changed");
      expect(cloudFormation.calls, value).toEqual([]);
    }
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

    it("accepts a GLM id the gateway offers, asking the broker's admin read with the admin sign-in, then changes only CoreAgentModel", async () => {
      const gateway = withGateway(offering(GATEWAY_OFFERED_MODELS));
      const { cloudFormation, result } = await run(GLM, gateway);
      expect((await result).changed).toBe(true);
      expect(gateway.asked).toEqual([{ url: `${ADMIN_SESSION.controlPlaneUrl}${CORE_OFFERED_MODELS_ADMIN_PATH}`, authorization: `Bearer ${ADMIN_SESSION.accessToken}`, method: "GET" }]);
      expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreAgentModel", ParameterValue: GLM }]);
    });

    it("accepts any model the gateway offers, even one no list in Code names", async () => {
      const gateway = withGateway(offering(["claude-sonnet-5-5", "acme.brand-new-model-v9:0"]));
      const { cloudFormation, result } = await run("acme.brand-new-model-v9:0", gateway);
      expect((await result).changed).toBe(true);
      expect(changed(cloudFormation).values).toEqual([{ ParameterKey: "CoreAgentModel", ParameterValue: "acme.brand-new-model-v9:0" }]);
    });

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

    it("matches exactly: a near name (another profile, case, version) is not offered", async () => {
      for (const value of ["us.zai.glm-5", "zai.glm-5:0", "zai.glm-5."]) {
        const { cloudFormation, result } = await run(value, withGateway(offering([GLM])));
        await expect(result, value).rejects.toThrow(`the model gateway does not offer ${value} to this company; it offers ${GLM}; nothing changed`);
        expect(cloudFormation.calls, value).toEqual([]);
      }
    });

    it("refuses a malformed id by its pattern before asking the gateway", async () => {
      const gateway = withGateway(offering(GATEWAY_OFFERED_MODELS));
      for (const value of ["zai.glm-5,am=x", "https://evil.example/zai.glm-5", "zai glm-5"]) {
        const { cloudFormation, result } = await run(value, gateway);
        await expect(result, value).rejects.toThrow(MODEL_ALLOWED);
        expect(cloudFormation.calls, value).toEqual([]);
      }
      expect(gateway.asked).toEqual([]);
    });

    it.each([
      ["unreachable", () => { throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1:443 secret-host.internal"); }],
      ["a server error", () => new Response("upstream secret-host.internal said no", { status: 503 })],
      ["not the contract", () => Response.json({ version: 1, models: [] })],
      ["not JSON", () => new Response("<html>secret-host.internal</html>", { status: 200 })],
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

    it("keeps a Claude id on its catalog rule: no live read", async () => {
      const gateway = withGateway(() => { throw new Error("must not be asked"); });
      const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: "" } });
      const configured = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST }), fetch: gateway.fetch });
      expect((await runConfigSet(configured, ENV, { key: MODEL_KEY, value: "claude-haiku-4-5", yes: true })).changed).toBe(true);
      expect(gateway.asked).toEqual([]);
    });

    it("clearing the model (none) needs no live read", async () => {
      const gateway = withGateway(() => { throw new Error("must not be asked"); });
      const { result } = await run("none", gateway);
      expect((await result).changed).toBe(true);
      expect(gateway.asked).toEqual([]);
    });
  });

  it("says nothing changes when the stack already has the value, naming the origin", async () => {
    const cloudFormation = fakeCloudFormation();
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }) });
    expect((await runConfigSet(run, ENV, { key: URL_KEY, value: GATEWAY, yes: true })).changed).toBe(false);
    expect(run.lines).toContain(`${URL_KEY} is already ${GATEWAY}; nothing to change`);
    expect(cloudFormation.calls).toEqual([]);
  });

  it("shows the origin the functions read, or empty when unset or the stack predates the parameter", async () => {
    const store = await seeded();
    expect((await runConfigGet(services({ store, stacks: controlPlane({ CoreModelGatewayHost: HOST }) }), ENV, URL_KEY)).value).toBe(GATEWAY);
    expect((await runConfigGet(services({ store, stacks: controlPlane({}) }), ENV, URL_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: stacks({ "agentx-staging-control-plane": { CoreEngine: "off" } }) }), ENV, MODEL_KEY)).value).toBe("");
    const rows = await runConfigList(services({ store, stacks: controlPlane({ CoreModelGatewayHost: HOST, CoreAgentModel: MODEL }) }), ENV);
    expect(rows.find((row) => row.key === URL_KEY)?.value).toBe(GATEWAY);
    expect(rows.find((row) => row.key === MODEL_KEY)?.value).toBe(MODEL);
  });

  it("asks for an upgrade first when the stack has no such parameter", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreEngine: "off" } });
    await expect(updateStackParameters({ cloudFormation, stackName: "agentx-staging-control-plane", roleArn: "arn:aws:iam::123456789012:role/x", changes: { CoreModelGatewayHost: HOST }, label: "config", confirm: async () => true, write: () => undefined }))
      .rejects.toThrow("stack agentx-staging-control-plane has no CoreModelGatewayHost parameter; it runs an older AgentX release, so upgrade it with agentx upgrade, then run this again");
  });
});

// L4-AM (DEC 254zzn(2)): the hosted answers model, `agentx config set coreEngine.answersModel`. Empty = the agent model answers (today's behaviour).
describe("coreEngine.answersModel (the hosted answers model)", () => {
  const ANSWERS_KEY = "coreEngine.answersModel";
  const ANSWERS_MODEL = "claude-haiku-5-5";
  const ANSWERS_ALLOWED = `${ANSWERS_KEY} must be empty (none: answers use the agent model) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: the answers run on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_ANSWERS_MODEL_MAX_LENGTH} characters)`;
  const controlPlane = (parameters: Record<string, string>) => stacks({ "agentx-staging-control-plane": { CoreEngine: "off", CoreModelGatewayHost: HOST, CoreAgentModel: MODEL, CoreAnswersModel: "", ...parameters } });

  it("is the stack parameter CoreAnswersModel of the control plane, empty by default, with no model role and no live gateway check", () => {
    const entry = configKey(ANSWERS_KEY);
    expect(entry).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreAnswersModel" }, defaultValue: "" });
    expect(entry.model).toBeUndefined();
    expect(entry.gatewayOffered).toBeUndefined();
    expect(entry.corePairedWith).toBeUndefined();
    expect(whereText(entry.target, ENV)).toBe("stack parameter CoreAnswersModel on agentx-staging-control-plane");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreAnswersModel");
  });

  it.each(["", "none", " none "])("reads %j as empty (the agent model answers)", (value) => {
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
    "claude-made-up-9", "us.anthropic.claude-haiku-5-5", "anthropic.claude-haiku-5-5-v1:0", "Claude-Haiku-4-5", "claude sonnet", `claude-${"a".repeat(80)}`, "claude-",
    GLM, "zai.glm-9", "deepseek.v3.2", "https://evil.example/claude-haiku-5-5", "claude-haiku-5-5,am=x", "claude-haiku-5-5\nam=x", "u:p@claude-haiku-5-5",
  ])("refuses %j, without echoing it", (value) => {
    let message = "";
    try { configKey(ANSWERS_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(ANSWERS_ALLOWED);
    expect(message).not.toContain("evil.example");
  });

  it("sets only CoreAnswersModel, with the previous template and every other parameter kept, and asks the gateway nothing", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreEngine: "off", CoreModelGatewayHost: HOST, CoreAgentModel: MODEL, CoreAnswersModel: "" } });
    const asked: string[] = [];
    const recorder = fakeChangeRecorder();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { asked.push(String(input instanceof Request ? input.url : input)); return await recorder(input, init); }) as typeof fetch;
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({}), fetch: fetchImpl });
    expect((await runConfigSet(run, ENV, { key: ANSWERS_KEY, value: ANSWERS_MODEL, yes: true })).changed).toBe(true);
    expect(run.lines).toContain(`${ANSWERS_KEY}: CoreAnswersModel  -> ${ANSWERS_MODEL} on agentx-staging-control-plane`);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>>; UsePreviousTemplate?: boolean };
    expect(create.UsePreviousTemplate).toBe(true);
    expect(create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined)).toEqual([{ ParameterKey: "CoreAnswersModel", ParameterValue: ANSWERS_MODEL }]);
    expect(create.Parameters).toEqual(expect.arrayContaining([{ ParameterKey: "CoreAgentModel", UsePreviousValue: true }, { ParameterKey: "CoreModelGatewayHost", UsePreviousValue: true }]));
    expect(asked.filter((url) => url.includes(CORE_OFFERED_MODELS_ADMIN_PATH))).toEqual([]);
    expect(run.lines.some((line) => line.startsWith("Note:"))).toBe(false);
  });

  it("clears with none (back to the agent model), changing only CoreAnswersModel", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: MODEL, CoreAnswersModel: ANSWERS_MODEL } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreAnswersModel: ANSWERS_MODEL }) });
    expect((await runConfigSet(run, ENV, { key: ANSWERS_KEY, value: "none", yes: true })).changed).toBe(true);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>> };
    expect(create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined)).toEqual([{ ParameterKey: "CoreAnswersModel", ParameterValue: "" }]);
  });

  it("refuses a Bedrock id, a non-Claude model, an unknown model and a malformed id before any AWS call", async () => {
    for (const value of ["us.anthropic.claude-haiku-5-5", GLM, "claude-made-up-9", "claude-haiku-5-5,am=x"]) {
      const cloudFormation = fakeCloudFormation();
      await expect(runConfigSet(services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) }), ENV, { key: ANSWERS_KEY, value, yes: true }), value).rejects.toThrow("nothing changed");
      expect(cloudFormation.calls, value).toEqual([]);
    }
  });

  it("says nothing changes when the stack already has the value", async () => {
    const cloudFormation = fakeCloudFormation();
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreAnswersModel: ANSWERS_MODEL }) });
    expect((await runConfigSet(run, ENV, { key: ANSWERS_KEY, value: ANSWERS_MODEL, yes: true })).changed).toBe(false);
    expect(cloudFormation.calls).toEqual([]);
  });

  it("shows empty when unset or when the stack predates the parameter, and the value when set", async () => {
    const store = await seeded();
    expect((await runConfigGet(services({ store, stacks: controlPlane({}) }), ENV, ANSWERS_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: stacks({ "agentx-staging-control-plane": { CoreEngine: "off" } }) }), ENV, ANSWERS_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: controlPlane({ CoreAnswersModel: ANSWERS_MODEL }) }), ENV, ANSWERS_KEY)).value).toBe(ANSWERS_MODEL);
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

// DEC 254zzz58: the hosted lessons learning model, `agentx config set coreEngine.learningModel`. Empty = the first Claude model the gateway offers the company.
describe("coreEngine.learningModel (the hosted lessons learning model)", () => {
  const LEARNING_KEY = "coreEngine.learningModel";
  const LEARNING_MODEL = "claude-haiku-5-5";
  const LEARNING_ALLOWED = `${LEARNING_KEY} must be empty (none: the first Claude model the model gateway offers the company) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: lessons learn on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_LEARNING_MODEL_MAX_LENGTH} characters)`;
  const controlPlane = (parameters: Record<string, string>) => stacks({ "agentx-staging-control-plane": { CoreEngine: "off", CoreModelGatewayHost: HOST, CoreAgentModel: GLM, CoreLearningModel: "", ...parameters } });

  it("is the stack parameter CoreLearningModel of the control plane, empty by default, with no model role and no live gateway check", () => {
    const entry = configKey(LEARNING_KEY);
    expect(entry).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreLearningModel" }, defaultValue: "" });
    expect(entry.model).toBeUndefined();
    expect(entry.gatewayOffered).toBeUndefined();
    expect(entry.corePairedWith).toBeUndefined();
    expect(whereText(entry.target, ENV)).toBe("stack parameter CoreLearningModel on agentx-staging-control-plane");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreLearningModel");
  });

  it.each(["", "none", " none "])("reads %j as empty (the first Claude model the gateway offers)", (value) => {
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
    "claude-made-up-9", "us.anthropic.claude-haiku-5-5", "anthropic.claude-haiku-5-5-v1:0", "Claude-Haiku-4-5", "claude sonnet", `claude-${"a".repeat(80)}`, "claude-",
    GLM, "zai.glm-9", "deepseek.v3.2", "https://evil.example/claude-haiku-5-5", "claude-haiku-5-5,lm=x", "claude-haiku-5-5\nlm=x", "u:p@claude-haiku-5-5",
  ])("refuses %j, without echoing it", (value) => {
    let message = "";
    try { configKey(LEARNING_KEY).parse(value); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(LEARNING_ALLOWED);
    expect(message).not.toContain("evil.example");
  });

  it("sets only CoreLearningModel (agent model zai.glm-5 kept), with the previous template and every other parameter kept, and asks the gateway nothing", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreEngine: "off", CoreModelGatewayHost: HOST, CoreAgentModel: GLM, CoreLearningModel: "" } });
    const asked: string[] = [];
    const recorder = fakeChangeRecorder();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { asked.push(String(input instanceof Request ? input.url : input)); return await recorder(input, init); }) as typeof fetch;
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({}), fetch: fetchImpl });
    expect((await runConfigSet(run, ENV, { key: LEARNING_KEY, value: LEARNING_MODEL, yes: true })).changed).toBe(true);
    expect(run.lines).toContain(`${LEARNING_KEY}: CoreLearningModel  -> ${LEARNING_MODEL} on agentx-staging-control-plane`);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>>; UsePreviousTemplate?: boolean };
    expect(create.UsePreviousTemplate).toBe(true);
    expect(create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined)).toEqual([{ ParameterKey: "CoreLearningModel", ParameterValue: LEARNING_MODEL }]);
    expect(create.Parameters).toEqual(expect.arrayContaining([{ ParameterKey: "CoreAgentModel", UsePreviousValue: true }, { ParameterKey: "CoreModelGatewayHost", UsePreviousValue: true }]));
    expect(asked.filter((url) => url.includes(CORE_OFFERED_MODELS_ADMIN_PATH))).toEqual([]);
  });

  it("clears with none (back to the gateway's first Claude model), changing only CoreLearningModel", async () => {
    const cloudFormation = fakeCloudFormation({ parameters: { CoreModelGatewayHost: HOST, CoreAgentModel: GLM, CoreLearningModel: LEARNING_MODEL } });
    const run = services({ store: await seeded(), cloudFormation, stacks: controlPlane({ CoreLearningModel: LEARNING_MODEL }) });
    expect((await runConfigSet(run, ENV, { key: LEARNING_KEY, value: "none", yes: true })).changed).toBe(true);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input as { Parameters: Array<Record<string, unknown>> };
    expect(create.Parameters.filter((parameter) => parameter["ParameterValue"] !== undefined)).toEqual([{ ParameterKey: "CoreLearningModel", ParameterValue: "" }]);
  });

  it("refuses a Bedrock id, a non-Claude model, an unknown model and a malformed id before any AWS call", async () => {
    for (const value of ["us.anthropic.claude-haiku-5-5", GLM, "claude-made-up-9", "claude-haiku-5-5,lm=x"]) {
      const cloudFormation = fakeCloudFormation();
      await expect(runConfigSet(services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) }), ENV, { key: LEARNING_KEY, value, yes: true }), value).rejects.toThrow("nothing changed");
      expect(cloudFormation.calls, value).toEqual([]);
    }
  });

  it("shows empty when unset or when the stack predates the parameter, and the value when set", async () => {
    const store = await seeded();
    expect((await runConfigGet(services({ store, stacks: controlPlane({}) }), ENV, LEARNING_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: stacks({ "agentx-staging-control-plane": { CoreEngine: "off" } }) }), ENV, LEARNING_KEY)).value).toBe("");
    expect((await runConfigGet(services({ store, stacks: controlPlane({ CoreLearningModel: LEARNING_MODEL }) }), ENV, LEARNING_KEY)).value).toBe(LEARNING_MODEL);
  });

  it("is read by the broker (packed lm) and nothing else changes: the agent model, the answers model and the gateway read back as before", () => {
    expect(BROKER_SETTINGS.coreLearningModel).toEqual({ code: "lm", variable: CORE_LEARNING_MODEL_VARIABLE });
    const env = { AGENTX_SETTINGS: `lm=${LEARNING_MODEL},aa=,am=${GLM},gw=${HOST}`, AGENTX_NAMES: "", AGENTX_ENV: ENV, AGENTX_ACCOUNT_ID: "123456789012", AWS_REGION: "us-west-2" } as Record<string, string | undefined>;
    hydrateBrokerEnvironment(env);
    expect(env[CORE_LEARNING_MODEL_VARIABLE]).toBe(LEARNING_MODEL);
    expect(env[CORE_ANSWERS_MODEL_VARIABLE]).toBe("");
    expect(readGatewayModelAccess(env)).toMatchObject({ gatewayUrl: GATEWAY, route: { alias: GLM, catalog: GLM } });
    const empty = { ...env, AGENTX_SETTINGS: `lm=,am=${GLM},gw=${HOST}` } as Record<string, string | undefined>;
    delete empty[CORE_LEARNING_MODEL_VARIABLE];
    hydrateBrokerEnvironment(empty);
    expect(empty[CORE_LEARNING_MODEL_VARIABLE]).toBe("");
  });
});
