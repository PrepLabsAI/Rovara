// The generator of the AWS emulator service table (scripts/aws-emulator/gen-service-table.ts): the score formula, the rules it refuses on, determinism, and that the committed files are what its renderer writes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ENGINE_COMMIT, OUTPUT_FILES, SCORES_SHA256_GZ, SCORES_SHA256_JSON, boundOperations, buildTable, readOverrides, readScores, readServiceSources, renderAll, renderNotImplementedJson, renderTableJson, renderTypeScript,
  type Overrides, type ScoreUnit, type ScoresFile, type ServiceSource, type SmithyModel, type TableOutput,
} from "../../scripts/aws-emulator/gen-service-table.js";
import { awsServiceKeyOrSelf, awsServicesForSigningName } from "../../packages/contracts/src/aws-emulator-service-keys.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const root = mkdtempSync(join(process.env["TMPDIR"] ?? process.env["RUNNER_TEMP"] ?? "node_modules/.cache", "gen-service-table-")); roots.push(root); return root; };

const SCRIPT = new URL("../../scripts/aws-emulator/gen-service-table.ts", import.meta.url).pathname;
const SHA = "b".repeat(64);

function model(input: { namespace: string; name: string; sdkId: string; signing?: string | null; protocol?: string[]; version?: string; operations?: string[]; resourceOperations?: string[]; prefix?: string }): SmithyModel {
  const ns = input.namespace;
  const traits: Record<string, unknown> = { "aws.api#service": { sdkId: input.sdkId, ...(input.prefix === undefined ? {} : { endpointPrefix: input.prefix }), cloudFormationName: input.sdkId.replace(/ /gu, "") } };
  if (input.signing !== null) traits["aws.auth#sigv4"] = { name: input.signing ?? input.namespace };
  for (const protocol of input.protocol ?? ["aws.protocols#awsJson1_1"]) traits[protocol] = {};
  const shapes: SmithyModel["shapes"] = {
    [`com.amazonaws.${ns}#${input.name}`]: {
      type: "service", version: input.version ?? "2020-01-01", traits,
      operations: (input.operations ?? []).map((op) => ({ target: `com.amazonaws.${ns}#${op}` })),
      resources: input.resourceOperations === undefined ? [] : [{ target: `com.amazonaws.${ns}#Thing` }],
    },
  };
  if (input.resourceOperations !== undefined) shapes[`com.amazonaws.${ns}#Thing`] = { type: "resource", operations: [{ target: `com.amazonaws.${ns}#${input.resourceOperations[0]!}` }], create: { target: `com.amazonaws.${ns}#${input.resourceOperations[1]!}` }, resources: [] };
  return { shapes };
}

const source = (dir: string, m: SmithyModel, scaffoldedOps: string[] = [], unwiredOps: string[] = []): ServiceSource => ({ dir, model: m, scaffoldedOps, unwiredOps });
const ALPHA = "com.amazonaws.alpha#AlphaService";
const BETA = "com.amazonaws.beta#BetaService";
const GAMMA = "com.amazonaws.gamma#GammaService";
const sources = (): ServiceSource[] => [
  source("service-alpha", model({ namespace: "alpha", name: "AlphaService", sdkId: "Alpha Thing", signing: "shared", operations: ["GetA", "PutA", "DeleteA"], prefix: "alpha" }), ["DeleteA", "DeleteA"], ["Odd"]),
  source("service-beta", model({ namespace: "beta", name: "BetaService", sdkId: "Beta", signing: "shared", protocol: ["aws.protocols#awsQuery", "aws.protocols#awsQueryCompatible"], version: "2012-11-05", operations: ["Ping"], resourceOperations: ["ListB", "CreateB"] })),
  source("service-gamma", model({ namespace: "gamma", name: "GammaService", sdkId: "Gamma X", signing: null, protocol: ["smithy.protocols#rpcv2Cbor", "aws.protocols#awsJson1_0"], operations: ["Run"] })),
];
// `Odd` is unwired and must be an operation of the model.
const withOdd = (): ServiceSource[] => {
  const all = sources();
  const alpha = all[0]!.model.shapes[ALPHA] as { operations: Array<{ target: string }> };
  alpha.operations.push({ target: "com.amazonaws.alpha#Odd" });
  return all;
};

const unit = (unitId: string, kind: ScoreUnit["kind"], outcome: ScoreUnit["outcome"], services: string[]): ScoreUnit => ({ unitId, kind, outcome, services });
const scores = (units: ScoreUnit[]): ScoresFile => ({ commit: ENGINE_COMMIT, schemaVersion: 1, scoredAt: "2026-01-01T00:00:00Z", units });
const UNITS: ScoreUnit[] = [
  unit("a1", "behavioral", "pass", [ALPHA]), unit("a2", "behavioral", "pass", [ALPHA]), unit("a3", "behavioral", "fail", [ALPHA]), unit("a4", "behavioral", "skipped", [ALPHA]),
  unit("ab1", "behavioral", "fail", [ALPHA, BETA]), unit("ab2", "behavioral", "pass", [BETA, ALPHA, ALPHA]),
  unit("w1", "wire", "pass", [ALPHA]), unit("w2", "wire", "fail", [BETA]),
];
const overrides = (): Overrides => ({ legacyKeys: { gam: "gamma-x", oldalpha: "alpha-thing" }, boto3Names: { "alpha-thing": "alpha" } });
const build = (all: ServiceSource[] = withOdd(), file: ScoresFile = scores(UNITS), over: Overrides = overrides()): TableOutput => buildTable(all, file, SHA, over);
const row = (output: TableOutput, key: string) => output.rows.find((candidate) => candidate.key === key)!;

describe("the score of a service", () => {
  it("is passed over passed plus failed, over the units that name it", () => {
    const output = build();
    // alpha: behavioral a1 pass, a2 pass, a3 fail, ab1 fail, ab2 pass (a4 skipped counts in neither); wire w1 pass.
    expect(row(output, "alpha-thing")).toMatchObject({ behavioralScore: 0.6, behavioralUnits: 5, wireScore: 1, wireUnits: 1 });
    // beta: ab1 fail, ab2 pass; wire w2 fail. A unit that names a service twice counts once.
    expect(row(output, "beta")).toMatchObject({ behavioralScore: 0.5, behavioralUnits: 2, wireScore: 0, wireUnits: 1 });
  });

  it("scores the units that name a service alone apart from the cross-service ones", () => {
    const output = build();
    expect(row(output, "alpha-thing")).toMatchObject({ behavioralOwnScore: 0.6667, behavioralOwnUnits: 3 });
    expect(row(output, "beta")).toMatchObject({ behavioralOwnScore: null, behavioralOwnUnits: 0 });
  });

  it("is null, with no units, for a service no unit names", () => {
    expect(row(build(), "gamma-x")).toMatchObject({ behavioralScore: null, behavioralUnits: 0, wireScore: null, wireUnits: 0, behavioralOwnScore: null, behavioralOwnUnits: 0 });
    const onlySkipped = build(withOdd(), scores([unit("s", "behavioral", "skipped", [GAMMA])]));
    expect(row(onlySkipped, "gamma-x")).toMatchObject({ behavioralScore: null, behavioralUnits: 0 });
  });

  it("refuses scores that name a service the engine does not have", () => {
    expect(() => build(withOdd(), scores([unit("x", "wire", "pass", ["com.amazonaws.delta#Missing"])]))).toThrow(/not in the engine/u);
  });
});

describe("the rows", () => {
  it("derives every column from the model", () => {
    const output = build();
    expect(output.rows.map((candidate) => candidate.key)).toEqual(["alpha-thing", "beta", "gamma-x"]);
    expect(row(output, "alpha-thing")).toMatchObject({
      smithyId: ALPHA, sdkId: "Alpha Thing", envKey: "ALPHA_THING", signingName: "shared", endpointPrefix: "alpha", cfnName: "AlphaThing", protocols: ["awsJson1_1"], targetPrefix: "AlphaService", queryVersion: null,
      jsPackage: "@aws-sdk/client-alpha-thing", goPackage: "github.com/aws/aws-sdk-go-v2/service/alphathing", javaPackage: "software.amazon.awssdk.services.alphathing", boto3Name: "alpha",
      opCount: 4, notImplementedCount: 1, unwiredCount: 1, legacyKeys: ["oldalpha"],
    });
    expect(row(output, "beta")).toMatchObject({ protocols: ["awsQuery", "awsQueryCompatible"], targetPrefix: null, queryVersion: "2012-11-05", opCount: 3, boto3Name: "beta", endpointPrefix: null });
    expect(row(output, "gamma-x")).toMatchObject({ key: "gamma-x", envKey: "GAMMA_X", signingName: null, protocols: ["awsJson1_0", "rpcv2Cbor"], targetPrefix: "GammaService", queryVersion: null, legacyKeys: ["gam"] });
  });

  it("counts the operations of a service's resources, and each once", () => {
    const m = model({ namespace: "beta", name: "BetaService", sdkId: "Beta", operations: ["Ping"], resourceOperations: ["ListB", "CreateB"] });
    expect(boundOperations(m, m.shapes["com.amazonaws.beta#BetaService"] as never)).toEqual(["CreateB", "ListB", "Ping"]);
  });

  it("lists the operations that answer NotImplemented, and the ones the engine does not route, for the services that have any", () => {
    const output = build();
    expect(output.notImplemented).toEqual({ "alpha-thing": { notImplemented: ["DeleteA"], unwired: ["Odd"] } });
  });

  it("names the signing names more than one service uses", () => {
    const output = build();
    expect(output.sharedSigningNames).toEqual({ shared: ["alpha-thing", "beta"] });
    expect(awsServicesForSigningName("sqs")).toEqual(["sqs"]);
  });
});

describe("what it refuses", () => {
  it("refuses a model with no service shape, or two", () => {
    const empty: ServiceSource = source("service-empty", { shapes: {} });
    expect(() => build([empty])).toThrow(/expected one service shape/u);
    const two = model({ namespace: "alpha", name: "AlphaService", sdkId: "Alpha" });
    two.shapes["com.amazonaws.alpha#Other"] = two.shapes["com.amazonaws.alpha#AlphaService"]!;
    expect(() => build([source("service-two", two)])).toThrow(/expected one service shape/u);
  });

  it("refuses two services with the same SDK endpoint name", () => {
    const a = source("service-a", model({ namespace: "a1", name: "A", sdkId: "Same Name" }));
    const b = source("service-b", model({ namespace: "a2", name: "B", sdkId: "SAME NAME" }));
    expect(() => build([a, b], scores([]), { legacyKeys: {}, boto3Names: {} })).toThrow(/key is not unique/u);
  });

  it("refuses a key that is not a plannable service id", () => {
    expect(() => build([source("service-x", model({ namespace: "x", name: "X", sdkId: "X" }))], scores([]), { legacyKeys: {}, boto3Names: {} })).toThrow(/not a plannable service id/u);
    expect(() => build([source("service-x", model({ namespace: "x", name: "X", sdkId: "Bad!" }))], scores([]), { legacyKeys: {}, boto3Names: {} })).toThrow(/unexpected characters/u);
  });

  it("refuses a legacy id that points nowhere, is a key already, or is not an id", () => {
    expect(() => build(withOdd(), scores([]), { legacyKeys: { gone: "missing" }, boto3Names: {} })).toThrow(/not a key/u);
    expect(() => build(withOdd(), scores([]), { legacyKeys: { beta: "gamma-x" }, boto3Names: {} })).toThrow(/key of the table already/u);
    expect(() => build(withOdd(), scores([]), { legacyKeys: { "Bad Id": "beta" }, boto3Names: {} })).toThrow(/not a service id/u);
    expect(() => build(withOdd(), scores([]), { legacyKeys: {}, boto3Names: { missing: "x" } })).toThrow(/boto3 override/u);
  });

  it("refuses an operation that the model does not have", () => {
    expect(() => build([source("service-a", model({ namespace: "alpha", name: "AlphaService", sdkId: "Alpha Thing", operations: ["GetA"] }), ["Nope"])], scores([]), { legacyKeys: {}, boto3Names: {} })).toThrow(/not an operation of the model/u);
  });

  it("refuses a scores file that is not the pinned release", () => {
    const root = temp();
    writeFileSync(join(root, "scores.json"), JSON.stringify(scores([])));
    writeFileSync(join(root, "scores.json.gz"), "not gzip");
    expect(() => readScores(join(root, "scores.json"))).toThrow(/not the pinned release/u);
    expect(() => readScores(join(root, "scores.json.gz"))).toThrow(/not the pinned release/u);
    expect(SCORES_SHA256_GZ).toMatch(/^[0-9a-f]{64}$/u);
    expect(SCORES_SHA256_JSON).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("exits with a usage error when it is not given its inputs", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });
});

describe("determinism", () => {
  it("gives byte-identical files from the same inputs, run twice, in any order of services", () => {
    const first = renderAll(build());
    const second = renderAll(build());
    expect(second).toEqual(first);
    const reversed = renderAll(build(withOdd().reverse()));
    expect(reversed).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(Object.values(OUTPUT_FILES).sort());
  });

  it("writes no clock, path or machine name", () => {
    const files = renderAll(build());
    for (const text of Object.values(files)) {
      expect(text).not.toMatch(/\/Users\/|\/private\/|\/home\/|scoredAt|20\d\d-\d\d-\d\dT/u);
    }
  });

  it("writes a table of valid JSON and a TypeScript file that names the engine, its commit and the scores", () => {
    const output = build();
    const table = JSON.parse(renderTableJson(output)) as { engine: string; engineCommit: string; scoresSha256: string; services: unknown[] };
    expect(table).toMatchObject({ engine: "aws-emulator@1.0.343", engineCommit: ENGINE_COMMIT, scoresSha256: SHA });
    expect(table.services).toHaveLength(3);
    JSON.parse(renderNotImplementedJson(output));
    const text = renderTypeScript(output);
    expect(text).toContain("Engine: aws-emulator@1.0.343");
    expect(text).toContain(`Engine commit: ${ENGINE_COMMIT}`);
    expect(text).toContain(`Scores sha256: ${SHA}`);
    expect(text).toContain("passed / (passed + failed)");
    expect(text).not.toMatch(/^\s*import\s/mu);
  });
});

describe("the committed files", () => {
  const dir = new URL("../../packages/contracts/src/generated/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, dir), "utf8");

  it("are exactly what the renderer writes for the table they hold", () => {
    const table = JSON.parse(read(OUTPUT_FILES.table)) as { scoresSha256: string; services: TableOutput["rows"]; sharedSigningNames: TableOutput["sharedSigningNames"] };
    const notImplemented = JSON.parse(read(OUTPUT_FILES.notImplemented)) as { services: TableOutput["notImplemented"] };
    const output: TableOutput = { rows: table.services, sharedSigningNames: table.sharedSigningNames, notImplemented: notImplemented.services, scoresSha256: table.scoresSha256 };
    const rendered = renderAll(output);
    expect(rendered[OUTPUT_FILES.typescript]).toBe(read(OUTPUT_FILES.typescript));
    expect(rendered[OUTPUT_FILES.table]).toBe(read(OUTPUT_FILES.table));
    expect(rendered[OUTPUT_FILES.notImplemented]).toBe(read(OUTPUT_FILES.notImplemented));
    expect(table.scoresSha256).toBe(SCORES_SHA256_JSON);
  });

  it("carry the legacy ids and boto3 names of the checked-in override files", () => {
    const overrides = readOverrides();
    const table = JSON.parse(read(OUTPUT_FILES.table)) as { services: TableOutput["rows"] };
    for (const [alias, key] of Object.entries(overrides.legacyKeys)) expect(table.services.find((candidate) => candidate.key === key)?.legacyKeys).toContain(alias);
    for (const [key, name] of Object.entries(overrides.boto3Names)) expect(table.services.find((candidate) => candidate.key === key)?.boto3Name).toBe(name);
    for (const alias of Object.keys(overrides.legacyKeys)) expect(awsServiceKeyOrSelf(alias)).toBe(overrides.legacyKeys[alias]);
  });
});

describe("reading the engine's source tree", () => {
  it("finds each service's model, the operations still scaffolded, and the operations that were skipped with no source file", () => {
    const root = temp();
    const service = join(root, "services", "service-com-amazonaws-alpha-alphaservice");
    mkdirSync(join(service, "smithy-model"), { recursive: true });
    mkdirSync(join(service, "src", "ops"), { recursive: true });
    writeFileSync(join(service, "smithy-model", "com-amazonaws-alpha-alphaservice.json"), JSON.stringify(model({ namespace: "alpha", name: "AlphaService", sdkId: "Alpha", operations: ["GetA", "PutA", "Odd", "Skipped"] })));
    // A profile file beside the model is not the model.
    writeFileSync(join(service, "smithy-model", "local-reported-service-profile.json"), "{}");
    writeFileSync(join(service, "src", "ops", "mod.rs"), "pub mod get_a;\n");
    writeFileSync(join(service, "src", "ops", "get_a.rs"), "// SPDX-License-Identifier: CC0-1.0\n\n//! @op GetA\n//! IMPLEMENTED: reads it.\n");
    writeFileSync(join(service, "src", "ops", "put_a.rs"), "// SPDX-License-Identifier: CC0-1.0\n\n//! @op PutA\n//! SCAFFOLDED, NOT IMPLEMENTED: this operation answers HTTP 501.\n");
    // A hand-written operation file for an operation the skipped list also names: it is wired, so it is not "unwired".
    writeFileSync(join(service, "src", "ops", "odd.rs"), "//! @op Odd\n//! Implemented here.\n");
    writeFileSync(join(service, "src", "ops", "SKIPPED_STUBS.md"), "# Skipped\n\n// SKIPPED: Odd — a reason\n// SKIPPED: Skipped — a reason\n");
    mkdirSync(join(root, "services", "common"), { recursive: true });
    const found = readServiceSources(root);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dir: "service-com-amazonaws-alpha-alphaservice", scaffoldedOps: ["PutA"], unwiredOps: ["Skipped"] });
    expect(build(found, scores([]), { legacyKeys: {}, boto3Names: {} }).rows[0]).toMatchObject({ key: "alpha", opCount: 4, notImplementedCount: 1, unwiredCount: 1 });
  });

  it("ignores only local-additions.json beside the real model", () => {
    const root = temp();
    const directory = join(root, "services", "service-workspaces", "smithy-model");
    mkdirSync(directory, { recursive: true });
    const real = model({ namespace: "workspaces", name: "Workspaces", sdkId: "WorkSpaces", operations: ["DescribeWorkspaces"] });
    writeFileSync(join(directory, "workspaces.json"), JSON.stringify(real));
    expect(readServiceSources(root)[0]?.model).toEqual(real);
    writeFileSync(join(directory, "local-additions.json"), "not a standalone model");
    expect(readServiceSources(root)).toEqual([source("service-workspaces", real)]);
  });

  it.each(["other.json", "local-additions-extra.json"])("refuses an unexpected second model %s", (name) => {
    const root = temp();
    const directory = join(root, "services", "service-workspaces", "smithy-model");
    mkdirSync(directory, { recursive: true });
    const real = model({ namespace: "workspaces", name: "Workspaces", sdkId: "WorkSpaces" });
    writeFileSync(join(directory, "workspaces.json"), JSON.stringify(real));
    writeFileSync(join(directory, name), JSON.stringify(real));
    expect(() => readServiceSources(root)).toThrow("expected one model file, found 2");
  });

  it("refuses local additions without a real model", () => {
    const root = temp();
    const directory = join(root, "services", "service-workspaces", "smithy-model");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "local-additions.json"), "{}");
    expect(() => readServiceSources(root)).toThrow("expected one model file, found 0");
  });

  it("refuses an operation file with no @op line", () => {
    const root = temp();
    const service = join(root, "services", "service-x");
    mkdirSync(join(service, "smithy-model"), { recursive: true });
    mkdirSync(join(service, "src", "ops"), { recursive: true });
    writeFileSync(join(service, "smithy-model", "x.json"), JSON.stringify(model({ namespace: "x", name: "X", sdkId: "Xx" })));
    writeFileSync(join(service, "src", "ops", "broken.rs"), "// nothing\n");
    expect(() => readServiceSources(root)).toThrow(/no @op line/u);
  });
});
