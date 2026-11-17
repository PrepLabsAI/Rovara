// Core switch-on blocker (2026-11-17): the core engine's model gateway and agent model are stack parameters of the named control plane (CoreModelGatewayHost, CoreAgentModel),
// packed for the broker and the dispatcher (which read ROVARA_CORE_MODEL_GATEWAY_URL = https://<host> and ROVARA_CORE_AGENT_MODEL), set with `agentx config set
// coreEngine.modelGatewayUrl` / `coreEngine.agentModel`, and kept across upgrades. Before this they could only be set by a template overlay, which every `agentx upgrade` dropped,
// so the core then refused work. The synthesized templates are checked in core-engine-infrastructure.test.ts ("the model gateway settings").
import { describe, expect, it } from "vitest";
import {
  BROKER_SETTINGS, CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_VARIABLE, CORE_ENGINE_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, CORE_MODEL_GATEWAY_URL_VARIABLE,
} from "@agentx/contracts";
import { hydrateBrokerEnvironment, hydrateBrokerSettings } from "../../packages/broker/src/aws/broker-environment.js";
import { gatewayModelKeysModules, readGatewayModelAccess } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { runConfigGet, runConfigList, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { configKey, whereText } from "../../packages/cli/src/config/keys.js";
import { updateStackParameters } from "../../packages/cli/src/deploy/parameter-update.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { seeded, services, stacks } from "../support/config-services.js";

const ENV = "staging";
const HOST = "gateway.staging.example.dev";
const GATEWAY = `https://${HOST}`;
const MODEL = "claude-sonnet-4-6";
const URL_KEY = "coreEngine.modelGatewayUrl";
const MODEL_KEY = "coreEngine.agentModel";
const URL_ALLOWED = `${URL_KEY} must be empty (none) or the model gateway's https origin, such as https://gateway.example.com, with no user name, password, path, query or fragment and a host of at most ${CORE_MODEL_GATEWAY_HOST_MAX_LENGTH} characters; nothing changed`;
const MODEL_ALLOWED = `${MODEL_KEY} must be empty (none) or an Anthropic model id this Rovara knows, such as claude-sonnet-4-6 (not a Bedrock id); nothing changed`;

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
  it.each(["us.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6-v1:0", "gpt-5", "Claude-sonnet-4-6", "claude-", "claude-sonnet 4", "claude-a,b", `claude-${"a".repeat(33)}`])("the model pattern refuses %j", (value) => {
    expect(model.test(value)).toBe(false);
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

  it.each(["claude-made-up-9", "us.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6-v1:0", "gpt-5.4", "Claude-Sonnet-4-6", "claude sonnet", `claude-${"a".repeat(80)}`])("refuses the model %j", (value) => {
    expect(() => configKey(MODEL_KEY).parse(value)).toThrow(MODEL_ALLOWED);
  });

  it("stores only values the stack parameters admit", () => {
    expect(new RegExp(CORE_MODEL_GATEWAY_HOST_PATTERN, "u").test(configKey(URL_KEY).parse("https://GW.Example.com:8443"))).toBe(true);
    expect(new RegExp(CORE_AGENT_MODEL_PATTERN, "u").test(configKey(MODEL_KEY).parse("claude-sonnet-4-5-20250929"))).toBe(true);
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

  it("refuses http, a URL with credentials and an unknown model before any AWS call", async () => {
    for (const [key, value] of [[URL_KEY, "http://gateway.example.dev"], [URL_KEY, "https://u:p@gateway.example.dev"], [MODEL_KEY, "claude-made-up-9"], [MODEL_KEY, "us.anthropic.claude-sonnet-4-6"]] as const) {
      const cloudFormation = fakeCloudFormation();
      await expect(runConfigSet(services({ store: await seeded(), cloudFormation, stacks: controlPlane({}) }), ENV, { key, value, yes: true }), value).rejects.toThrow("nothing changed");
      expect(cloudFormation.calls, value).toEqual([]);
    }
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
