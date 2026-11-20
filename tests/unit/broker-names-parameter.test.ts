// ENV-ROOM 2 (broker 4 KB, owner decision 2026-11-17): a named environment's broker names are in one SSM String parameter, and the broker's entry reads them before any broker
// module loads. These pin that the names arrive where hydrateBrokerEnvironment reads them, that nothing is read or changed where the environment points at no parameter, and that
// every way the names could be missing, corrupt or from another deploy stops the broker in fixed words that carry no value.
import { describe, expect, it, vi } from "vitest";
import {
  BROKER_NAMES_PARAMETER_MAX_BYTES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_REVISION_VARIABLE, BROKER_NAMES_VARIABLE, brokerNamesParameterName, decodeBrokerNamesParameter,
  encodeBrokerNamesParameterPrefix,
} from "@agentx/contracts";
import { loadBrokerNamesParameter, type FetchedParameter } from "../../packages/broker/src/aws/broker-names-parameter.js";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { createBrokerLambdaHandler, readOneParameter } from "../../packages/broker/src/aws/broker-handler.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";

const REVISION = "a".repeat(64);
const OTHER_REVISION = "b".repeat(64);
/** A value no message may carry: a refusal that echoed the parameter, a name or an AWS message would show it. */
const SECRETISH = "zz9plural9z9alpha";
const LIST = `ts=agentx-staging-control-plane-State-${SECRETISH},ar=agentx-staging-artifacts-${SECRETISH}`;
const PARAMETER = brokerNamesParameterName("staging");
const POINTED = (): MutableEnvironment => ({
  AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging",
  [BROKER_NAMES_PARAMETER_VARIABLE]: PARAMETER, [BROKER_NAMES_REVISION_VARIABLE]: REVISION,
});
const stored = (value: string, type = "String") => vi.fn(async (): Promise<FetchedParameter> => ({ type, value }));
const written = (revision = REVISION, list = LIST): string => `${encodeBrokerNamesParameterPrefix(revision)}${list}`;

async function refusal(env: MutableEnvironment, read: (name: string) => Promise<FetchedParameter>): Promise<Error> {
  const before = { ...env };
  const error = await loadBrokerNamesParameter(env, read).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  // Nothing is set on a refusal.
  expect(env).toEqual(before);
  expect((error as Error).message).not.toContain(SECRETISH);
  return error as Error;
}

describe("the parameter's name and format", () => {
  it("is the environment's own parameter, under its settings prefix", () => {
    expect(brokerNamesParameterName("staging")).toBe("/agentx/staging/broker-names");
    expect(() => brokerNamesParameterName("Not/AName")).toThrow();
  });

  it("writes v1, the revision and the list, and reads back exactly those", () => {
    expect(written()).toBe(`v1:${REVISION}:${LIST}`);
    expect(decodeBrokerNamesParameter(written())).toEqual({ revision: REVISION, list: LIST });
    expect(decodeBrokerNamesParameter(written(REVISION, ""))).toEqual({ revision: REVISION, list: "" });
    expect(() => encodeBrokerNamesParameterPrefix("A".repeat(64))).toThrow("64 lowercase hex digits");
  });

  it.each([
    ["no format", `${REVISION}:${LIST}`],
    ["another format", `v2:${REVISION}:${LIST}`],
    ["a short revision", `v1:${REVISION.slice(1)}:${LIST}`],
    ["an uppercase revision", `v1:${REVISION.toUpperCase()}:${LIST}`],
    ["no list separator", `v1:${REVISION}${LIST}`],
    ["a second line", `v1:${REVISION}:${LIST}\nts=other`],
    ["empty", ""],
  ])("refuses %s", (_label, raw) => {
    expect(decodeBrokerNamesParameter(raw)).toEqual({ error: "is not in the v1 format" });
  });

  it("refuses a value longer than a Standard parameter, before it looks at it", () => {
    const at = written(REVISION, `ts=${"n".repeat(BROKER_NAMES_PARAMETER_MAX_BYTES - written(REVISION, "ts=").length)}`);
    expect(at).toHaveLength(BROKER_NAMES_PARAMETER_MAX_BYTES);
    expect(decodeBrokerNamesParameter(at)).toMatchObject({ revision: REVISION });
    expect(decodeBrokerNamesParameter(`${at}n`)).toEqual({ error: "is longer than a parameter can be" });
  });
});

describe("loadBrokerNamesParameter", () => {

  it.each([
    ["a pointer without a revision", { [BROKER_NAMES_REVISION_VARIABLE]: undefined }, "AGENTX_NAMES_PARAMETER and AGENTX_NAMES_REVISION are given together or not at all"],
    ["a revision without a pointer", { [BROKER_NAMES_PARAMETER_VARIABLE]: undefined }, "AGENTX_NAMES_PARAMETER and AGENTX_NAMES_REVISION are given together or not at all"],
    ["the names given in the environment as well", { [BROKER_NAMES_VARIABLE]: LIST }, "AGENTX_NAMES is given as well as AGENTX_NAMES_PARAMETER; the broker takes its names from one place"],
    ["a revision that is not one", { [BROKER_NAMES_REVISION_VARIABLE]: `${SECRETISH}${"0".repeat(47)}` }, "AGENTX_NAMES_REVISION is not a revision"],
    ["no environment name", { AGENTX_ENV: undefined }, "AGENTX_ENV (a valid environment name) is required to read AGENTX_NAMES_PARAMETER"],
    ["another environment's parameter", { [BROKER_NAMES_PARAMETER_VARIABLE]: brokerNamesParameterName("production") }, "AGENTX_NAMES_PARAMETER is not this environment's broker names parameter"],
    ["any other parameter", { [BROKER_NAMES_PARAMETER_VARIABLE]: `/agentx/staging/${SECRETISH}` }, "AGENTX_NAMES_PARAMETER is not this environment's broker names parameter"],
  ])("refuses, without reading, %s", async (_label, change, message) => {
    const env = { ...POINTED(), ...change } as MutableEnvironment;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const read = stored(written());
    expect((await refusal(env, read)).message).toBe(message);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing parameter", Object.assign(new Error(`Parameter ${SECRETISH} not found`), { name: "ParameterNotFound" }), "the broker names parameter could not be read (ParameterNotFound)"],
    ["a denied read", Object.assign(new Error(`User ${SECRETISH} is not authorized`), { name: "AccessDeniedException" }), "the broker names parameter could not be read (AccessDeniedException)"],
    ["throttling", Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }), "the broker names parameter could not be read (ThrottlingException)"],
    ["an error whose name is not a name", Object.assign(new Error("x"), { name: `bad name ${SECRETISH}` }), "the broker names parameter could not be read (an error)"],
    ["something thrown that is not an error", SECRETISH, "the broker names parameter could not be read (an error)"],
  ])("refuses %s, naming only the error", async (_label, thrown, message) => {
    expect((await refusal(POINTED(), () => Promise.reject(thrown as Error))).message).toBe(message);
  });

  it.each([
    ["a SecureString", { type: "SecureString", value: written() }, "the broker names parameter is not a plain String parameter"],
    ["a StringList", { type: "StringList", value: written() }, "the broker names parameter is not a plain String parameter"],
    ["no type", { type: undefined, value: written() }, "the broker names parameter is not a plain String parameter"],
    ["no value", { type: "String", value: undefined }, "the broker names parameter has no value"],
    ["a corrupt value", { type: "String", value: `v1:${SECRETISH}` }, "the broker names parameter is not in the v1 format"],
    ["the bare list, with no format", { type: "String", value: LIST }, "the broker names parameter is not in the v1 format"],
    ["a value too long", { type: "String", value: written(REVISION, `ts=${SECRETISH.repeat(300)}`) }, "the broker names parameter is longer than a parameter can be"],
  ])("refuses %s", async (_label, fetched, message) => {
    expect((await refusal(POINTED(), async () => fetched)).message).toBe(message);
  });
});

describe("hydrateBrokerEnvironment, where the names are in a parameter", () => {
  it("refuses to start a broker whose names were not read first (loaded other than through broker-handler.ts)", () => {
    expect(() => hydrateBrokerEnvironment(POINTED())).toThrow("AGENTX_NAMES_PARAMETER is set but the names were not read from it before the broker loaded");
  });
});

describe("the broker's Lambda entry", () => {
  const event = { rawPath: "/v1/health" };
  const context = { awsRequestId: "r-1" };

  it("serves nothing while the names cannot be read, never loads the broker, and reads again on the next invocation", async () => {
    const env = POINTED();
    const loadBroker = vi.fn(async () => ({ handler: async () => "served" }));
    const read = vi.fn(async (): Promise<FetchedParameter> => ({ type: "String", value: written(OTHER_REVISION) }));
    const handler = createBrokerLambdaHandler({ environment: env, readParameter: read, loadBroker });
    await expect(handler(event, context)).rejects.toThrow("refusing to start");
    await expect(handler(event, context)).rejects.toThrow("refusing to start");
    expect(loadBroker).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(env[BROKER_NAMES_VARIABLE]).toBeUndefined();
    // Once the parameter is the function's own revision (the deploy finished), the next invocation starts.
    read.mockResolvedValue({ type: "String", value: written() });
    expect(await handler(event, context)).toBe("served");
    expect(loadBroker).toHaveBeenCalledTimes(1);
  });

  it("does not load the broker a second time after it failed to load, and refuses a module with no handler", async () => {
    const loadBroker = vi.fn(async () => { throw new Error("broker failed to load"); });
    const handler = createBrokerLambdaHandler({ environment: {}, readParameter: stored(written()), loadBroker });
    await expect(handler(event, context)).rejects.toThrow("broker failed to load");
    await expect(handler(event, context)).rejects.toThrow("broker failed to load");
    expect(loadBroker).toHaveBeenCalledTimes(1);
    const empty = createBrokerLambdaHandler({ environment: {}, readParameter: stored(written()), loadBroker: async () => ({}) });
    await expect(empty(event, context)).rejects.toThrow("the broker module has no handler");
  });
});

describe("readOneParameter (GetParameters for exactly one name)", () => {
  const client = (output: unknown) => ({ send: vi.fn(async (command: unknown) => { void command; return output; }) });

  it("asks for exactly the one name and returns its type and value", async () => {
    const fake = client({ Parameters: [{ Name: PARAMETER, Type: "String", Value: written() }], InvalidParameters: [] });
    expect(await readOneParameter(fake as never, PARAMETER)).toEqual({ type: "String", value: written() });
    const command = fake.send.mock.calls[0]![0] as GetParametersCommand;
    expect(command).toBeInstanceOf(GetParametersCommand);
    expect(command.input).toEqual({ Names: [PARAMETER] });
  });

  it.each([
    ["an invalid (missing) name", { Parameters: [], InvalidParameters: [PARAMETER] }],
    ["nothing returned", {}],
    ["another parameter returned", { Parameters: [{ Name: "/agentx/staging/other", Type: "String", Value: written() }] }],
    ["the name returned twice", { Parameters: [{ Name: PARAMETER, Type: "String", Value: written() }, { Name: PARAMETER, Type: "String", Value: written(OTHER_REVISION) }] }],
    ["found and also invalid", { Parameters: [{ Name: PARAMETER, Type: "String", Value: written() }], InvalidParameters: [PARAMETER] }],
  ])("throws ParameterNotFound for %s, which the loader refuses", async (_label, output) => {
    const error = await readOneParameter(client(output) as never, PARAMETER).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.name).toBe("ParameterNotFound");
    expect((await refusal(POINTED(), (name) => readOneParameter(client(output) as never, name))).message).toBe("the broker names parameter could not be read (ParameterNotFound)");
  });
});
