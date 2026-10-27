// AUTOREQUALIFY (AR-5): the deploy tooling for the automatic test machine renewal. The units are planned, never run here; the readers answer from fakes and the check says what it found.
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LAMBDAS,
  assertCheckAllowsApply,
  formatPlan,
  lambdaUnitsFor,
  parseTestDeployArgs,
  patchLiftedCode,
  planTestDeploy,
  plannedRequalifyGrants,
  assertOnlyExpectedChanges,
  type BuiltArtifacts,
  type ObservedChange,
  type CfnTemplate,
  type DeployStep,
  type StackParameters,
} from "../../scripts/test-deploy.js";
import { evaluateTestDeployCheck, tier3Request, type Finding } from "../../scripts/test-deploy-check.js";
import {
  REQUALIFY_INFRA,
  REQUALIFY_LAMBDA,
  REQUALIFY_DEPLOY_ORDER,
  REQUALIFY_NOW_PAYLOAD,
  REQUALIFY_SCHEDULE_LOGICAL_ID,
  REQUALIFY_STEPS_POLICY_LOGICAL_ID,
  drainReadIsNarrowed,
  enableScheduleTemplate,
  narrowDrainReadTemplate,
  lockFact,
  lockHeldMessage,
  parseStartAnswer,
  plainItem,
  readInstalledFacts,
  readLastRun,
  readRow,
  readRunnerTags,
  readinessProblems,
  requalifyFindings,
  requalifyInstalled,
  type RequalifyReader,
} from "../../scripts/test-deploy-requalify.js";

const ENV = "agentxlivetest123";
const CONTROL_PLANE = `agentx-${ENV}-control-plane`;
const artifacts: BuiltArtifacts = { revision: "0123456789ab", outputDir: "/tmp/test-deploy-0123456789ab" };
const previous: StackParameters = { "control-plane": { OidcIssuer: "https://issuer.example", AdminValues: "admin" }, runtime: {} };
const plan = (only: Parameters<typeof planTestDeploy>[0]["only"], requalifyInstalled?: boolean) => planTestDeploy({ env: ENV, only, artifacts, previous, ...(requalifyInstalled === undefined ? {} : { requalifyInstalled }) });
const NOW = new Date("2026-10-27T12:00:00.000Z");
const RUN_ID = "0b6f2c3e-8f0e-4c55-9d2e-1a2b3c4d5e6f";
const iso = (ms: number) => new Date(ms).toISOString();

describe("the requalify-infra unit", () => {
  const steps = plan(["requalify-infra"], false);

  it("builds and uploads the renewal's Lambda, then adds the RuntimeRequalify resources with an Add-only change set that carries that code", () => {
    expect(steps.map((step) => step.kind)).toEqual(["build-lambda-zip", "upload-artifact", "create-change-set", "execute-change-set", "verify-stack-resources", "verify-lambda-code"]);
    const [build, upload, changeSet, execute, verifyResources, verifyCode] = steps as [
      Extract<DeployStep, { kind: "build-lambda-zip" }>, Extract<DeployStep, { kind: "upload-artifact" }>, Extract<DeployStep, { kind: "create-change-set" }>,
      Extract<DeployStep, { kind: "execute-change-set" }>, Extract<DeployStep, { kind: "verify-stack-resources" }>, Extract<DeployStep, { kind: "verify-lambda-code" }>,
    ];
    // boot.sh rides beside the handler, as it does for the session steps.
    expect(build).toMatchObject({ unit: "requalify-steps", logicalId: REQUALIFY_LAMBDA.logicalId, entry: "packages/broker/src/aws/runtime-requalify-handler.ts", extraFiles: [{ from: "packages/worker/ec2/boot.sh", name: "boot.sh" }] });
    // The function does not exist yet: its bucket is checked against the Broker's, which reads from the same artifact bucket.
    expect(upload).toMatchObject({ logicalId: REQUALIFY_LAMBDA.logicalId, from: build.id, bucketCheckLogicalId: CONTROL_PLANE_LAMBDAS.broker.logicalId });
    expect(upload.keyPrefix).toBe(`test-deploy/0123456789ab/${REQUALIFY_LAMBDA.logicalId}-`);
    expect(changeSet).toMatchObject({
      stack: CONTROL_PLANE, stackKind: "control-plane",
      template: { source: "lift-resources", logicalIdPrefix: "RuntimeRequalify", cdkContext: { "agentx:autoRequalify": "enabled", "agentx:e2eQualificationTransport": "enabled" }, codePatches: [{ logicalId: REQUALIFY_LAMBDA.logicalId, zip: upload.id }] },
      expect: { action: "Add", logicalIdPrefixes: ["RuntimeRequalify"] },
    });
    expect(changeSet.expect.allowedAttributes).toBeUndefined();
    expect(changeSet.parameters).toEqual([{ key: "AdminValues", usePreviousValue: true }, { key: "OidcIssuer", usePreviousValue: true }]);
    expect(execute).toMatchObject({ createdBy: changeSet.id });
    expect(verifyResources).toMatchObject({ createdBy: changeSet.id, logicalIdPrefix: "RuntimeRequalify", expectedStatus: "CREATE_COMPLETE" });
    expect(verifyCode).toMatchObject({ logicalId: REQUALIFY_LAMBDA.logicalId, expectedSha256Base64: { fromStep: build.id, output: "sha256Base64" } });
  });

  it("runs alone, and refuses on a stack that already has the renewal (its code then moves with control-plane-code)", () => {
    for (const other of ["control-plane-code", "broker", "qualification-transport", "worker-image"] as const) {
      expect(() => plan(["requalify-infra", other], false), other).toThrow(/runs on its own/);
    }
    expect(() => plan(["requalify-infra"], true)).toThrow(/already installed/);
  });

  it("says in the printed plan that the lifted Lambda runs the uploaded zip and that only additions are allowed", () => {
    const text = formatPlan(steps);
    expect(text).toContain(`Code replaced for ${REQUALIFY_LAMBDA.logicalId} by the uploaded zip`);
    expect(text).toContain("abort unless the only changes are Add RuntimeRequalify*");
    expect(text).toContain(`${CONTROL_PLANE_LAMBDAS.broker.logicalId} already reads its code from it`);
  });
});

describe("the requalify-now unit", () => {
  it("checks the shared lock and then starts one renewal, and only where the renewal is installed", () => {
    const steps = plan(["requalify-now"], true);
    expect(steps).toEqual([
      { id: "check-requalify-ready", kind: "check-requalify-ready", stack: CONTROL_PLANE, identityMode: "cognito" },
      { id: "check-requalify-lock", kind: "check-requalify-lock", stack: CONTROL_PLANE },
      { id: "start-requalify", kind: "start-requalify", stack: CONTROL_PLANE, logicalId: REQUALIFY_LAMBDA.logicalId },
    ]);
    expect(() => plan(["requalify-now"], false)).toThrow(/deploy requalify-infra first/);
    expect(() => plan(["requalify-now"])).toThrow(/deploy requalify-infra first/);
    expect(() => plan(["requalify-now", "broker"], true)).toThrow(/runs on its own/);
  });

  it("starts nothing before the ready check: control-plane-code current and the runner and its volume tagged (AR-5 review I1)", () => {
    expect(plan(["requalify-now"], true)[0]!.kind).toBe("check-requalify-ready");
    expect(plan(["requalify-schedule"], true)[0]!.kind).toBe("check-requalify-ready");
  });

  it("says in the printed plan that it is owner-run and what it sends", () => {
    const text = formatPlan(plan(["requalify-now"], true));
    expect(text).toContain("owner-run, never started by an agent");
    // The ready check comes first, and the lock step is honest that the machine, not this step, takes the lock (AR-5 review M1).
    expect(text.indexOf("check-requalify-ready")).toBeLessThan(text.indexOf("check-requalify-lock"));
    expect(text).toContain("control-plane-code and the stack are current");
    expect(text).toContain("agentx:requalify-managed=true");
    expect(text).toContain("this step does not take the lock, the renewal machine's first step does");
    expect(text).toContain(REQUALIFY_NOW_PAYLOAD);
    expect(REQUALIFY_NOW_PAYLOAD).toBe('{"action":"due","force":true}');
  });

  it("both new units parse as --only values and stay out of the default set", () => {
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "requalify-infra"]).only).toEqual(["requalify-infra"]);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "requalify-now", "--apply"]).only).toEqual(["requalify-now"]);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p"]).only).not.toContain("requalify-infra");
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p"]).only).not.toContain("requalify-now");
  });
});

describe("control-plane-code and the renewal's Lambda", () => {
  const logicalIds = (steps: DeployStep[]) => steps.flatMap((step) => (step.kind === "build-lambda-zip" ? [step.logicalId] : []));

  it("leaves the renewal's Lambda out of a stack that lacks it, and moves it, with its boot.sh, once the stack has it", () => {
    expect(logicalIds(plan(["control-plane-code"], false))).not.toContain(REQUALIFY_LAMBDA.logicalId);
    expect(logicalIds(plan(["control-plane-code"]))).not.toContain(REQUALIFY_LAMBDA.logicalId);
    const installed = plan(["control-plane-code"], true);
    expect(logicalIds(installed)).toContain(REQUALIFY_LAMBDA.logicalId);
    expect(logicalIds(installed)).toHaveLength(Object.keys(CONTROL_PLANE_LAMBDAS).length + 1);
    const changeSet = installed.find((step): step is Extract<DeployStep, { kind: "create-change-set" }> => step.kind === "create-change-set")!;
    expect(changeSet.expect.logicalIds).toContain(REQUALIFY_LAMBDA.logicalId);
    expect(changeSet.template.source === "lambda-code" && changeSet.template.patches.map((patch) => patch.logicalId)).toContain(REQUALIFY_LAMBDA.logicalId);
    expect(installed.filter((step) => step.kind === "verify-lambda-code")).toHaveLength(Object.keys(CONTROL_PLANE_LAMBDAS).length + 1);
    expect(installed.find((step) => step.kind === "build-lambda-zip" && step.logicalId === REQUALIFY_LAMBDA.logicalId)).toMatchObject({ extraFiles: [{ name: "boot.sh" }] });
  });

  it("does not make the renewal's Lambda a unit of its own: broker and dispatcher stay what they were", () => {
    expect(lambdaUnitsFor(["broker"], true)).toEqual(["broker"]);
    expect(lambdaUnitsFor(["control-plane-code"], false)).not.toContain("requalify-steps");
    expect(lambdaUnitsFor(["control-plane-code"], true)).toContain("requalify-steps");
  });

  it("patches the lifted Lambda's Code with the uploaded zip, and leaves a template without patches as it is", () => {
    const template: CfnTemplate = { Resources: { [REQUALIFY_LAMBDA.logicalId]: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-assets", S3Key: "never-published.zip" }, Handler: "index.handler" } } } };
    const code = { S3Bucket: "artifacts", S3Key: "test-deploy/x/y.zip", S3ObjectVersion: "v1" };
    const patched = patchLiftedCode(template, [{ logicalId: REQUALIFY_LAMBDA.logicalId, code }]);
    expect(patched.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties).toEqual({ Code: code, Handler: "index.handler" });
    expect(template.Resources?.[REQUALIFY_LAMBDA.logicalId]?.Properties?.Code).toEqual({ S3Bucket: "cdk-assets", S3Key: "never-published.zip" });
    expect(patchLiftedCode(template, [])).toBe(template);
    expect(() => patchLiftedCode(template, [{ logicalId: "NotThere", code }])).toThrow(/no resource NotThere/);
  });
});

describe("whether the renewal is installed", () => {
  it("is read from the deployed template: the renewal's Lambda must be there as a Lambda function", () => {
    expect(requalifyInstalled({ Resources: {} })).toBe(false);
    expect(requalifyInstalled({})).toBe(false);
    expect(requalifyInstalled({ Resources: { [REQUALIFY_LAMBDA.logicalId]: { Type: "AWS::SSM::Parameter" } } })).toBe(false);
    expect(requalifyInstalled({ Resources: { [REQUALIFY_LAMBDA.logicalId]: { Type: "AWS::Lambda::Function" } } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The readers and the findings
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
/** A fake `aws dynamodb query` over rows by `pk|sk`; "DENIED" makes the read fail. Records every call. */
function fakeReader(rows: Record<string, Row | "DENIED" | "NOT-JSON">) {
  const calls: string[][] = [];
  const reader: RequalifyReader = {
    aws(args) {
      calls.push([...args]);
      const values = JSON.parse(args[args.indexOf("--expression-attribute-values") + 1] ?? "{}") as { ":pk": { S: string }; ":sk": { S: string } };
      const row = rows[`${values[":pk"].S}|${values[":sk"].S}`];
      if (row === "DENIED") return { status: 254, stdout: "", stderr: "An error occurred (AccessDeniedException) when calling the Query operation: not authorized to perform: dynamodb:Query" };
      if (row === "NOT-JSON") return { status: 0, stdout: "<html>", stderr: "" };
      return { status: 0, stdout: JSON.stringify({ Items: row === undefined ? [] : [row] }), stderr: "" };
    },
  };
  return { reader, calls };
}
const dynamo = (value: unknown): unknown => {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (value === null) return { NULL: true };
  return { M: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, dynamo(inner)])) };
};
const item = (fields: Record<string, unknown>): Row => (dynamo(fields) as { M: Row }).M;

const LOCK_KEY = "RUNTIME_REQUALIFY#linux-arm64-web-api-v1|LOCK";
const HOLD_KEY = "RUNTIME_REQUALIFY#linux-arm64-web-api-v1|HOLD";
const POINTER_KEY = "E2E_MODEL_ROUTES|E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1";
const RUN_KEY = `RUNTIME_REQUALIFY_RUN#${RUN_ID}|RECORD`;
const NEW_RUNNER = { instanceId: "i-0fcff78d50c71bc57", roleId: "AROAEXAMPLEROLE1234", transportCorrelationId: "6f9c0d3a-2b7e-4c41-8e0a-5d1f3b2a4c6d" };
const OLD_RUNNER = { instanceId: "i-0c77bc514b2508cad", roleId: "AROAEXAMPLEROLE1234", transportCorrelationId: "1e8d7c6b-5a49-4382-9a1b-0c2d3e4f5a6b" };
const runRecord = (overrides: Record<string, unknown> = {}): Row => item({
  pk: `RUNTIME_REQUALIFY_RUN#${RUN_ID}`, sk: "RECORD", schemaVersion: 1, entityType: "RUNTIME_REQUALIFY_RUN", runId: RUN_ID, environment: ENV, profileId: "linux-arm64-web-api-v1",
  requestedBySubject: `runtime-requalifier/${ENV}`, switchedAt: "2026-10-26T06:30:00.000Z", generation: 3, featureRevisions: { web: 4, api: 4 }, proposalSha256: "a".repeat(64),
  challengeId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", newRunner: NEW_RUNNER, previousRunner: OLD_RUNNER, amiId: "ami-0123456789abcdef0",
  images: { worker: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker@sha256:" + "b".repeat(64), executor: null }, ...overrides,
});
const pointerRow = (fields: Record<string, unknown> = {}): Row => item({ pk: "E2E_MODEL_ROUTES", sk: "E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1", instanceId: NEW_RUNNER.instanceId, requalifyRunId: RUN_ID, ...fields });
const lockRow = (expiresAt: string): Row => item({ pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "LOCK", entityType: "RUNTIME_REQUALIFY_LOCK", runId: RUN_ID, acquiredAt: "2026-10-27T11:00:00.000Z", expiresAt });
const input = { table: "state-table", region: "us-east-1" };

describe("plainItem", () => {
  it("turns DynamoDB JSON into the plain object: text, numbers, null, maps, lists", () => {
    expect(plainItem({ a: { S: "x" }, b: { N: "4" }, c: { NULL: true }, d: { M: { e: { S: "y" }, f: { BOOL: false } } }, g: { L: [{ S: "z" }] } })).toEqual({ a: "x", b: 4, c: null, d: { e: "y", f: false }, g: ["z"] });
  });
});

describe("readRow", () => {
  it("is a consistent query by the exact key, and tells absent, found and unreadable apart", () => {
    const { reader, calls } = fakeReader({ [LOCK_KEY]: lockRow("2030-01-01T00:00:00.000Z"), [HOLD_KEY]: "DENIED", [POINTER_KEY]: "NOT-JSON" });
    expect(readRow(reader, { ...input, key: { pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "LOCK" } })).toMatchObject({ state: "found", item: { runId: RUN_ID } });
    expect(readRow(reader, { ...input, key: { pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "HOLD" } })).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(readRow(reader, { ...input, key: { pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "HOLD" } }))).toContain("AccessDeniedException");
    expect(readRow(reader, { ...input, key: { pk: "E2E_MODEL_ROUTES", sk: "E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1" } })).toEqual({ state: "unreadable", reason: "the answer was not JSON" });
    expect(readRow(reader, { ...input, key: { pk: "nothing", sk: "here" } })).toEqual({ state: "absent" });
    for (const call of calls) {
      expect(call.slice(0, 2)).toEqual(["dynamodb", "query"]);
      expect(call).toContain("--consistent-read");
      expect(call[call.indexOf("--key-condition-expression") + 1]).toBe("pk = :pk AND sk = :sk");
    }
  });
});

describe("the renewal lock", () => {
  const read = (expiresAt: string) => lockFact({ state: "found", item: plainItem(lockRow(expiresAt) as never) }, NOW);

  it("is free without a row and after its time, held before it, and unreadable (never free) when the row is not a lock or cannot be read", () => {
    expect(lockFact({ state: "absent" }, NOW)).toEqual({ state: "free" });
    expect(read(iso(NOW.getTime() - 1))).toEqual({ state: "free" });
    expect(read(iso(NOW.getTime()))).toEqual({ state: "free" });
    expect(read(iso(NOW.getTime() + 1_000))).toEqual({ state: "held", runId: RUN_ID, expiresAt: iso(NOW.getTime() + 1_000) });
    expect(lockFact({ state: "found", item: { pk: "x", sk: "LOCK", runId: "not-a-uuid" } }, NOW)).toMatchObject({ state: "unreadable" });
    // The row as the table holds it carries its key; any other extra field is not a lock.
    expect(lockFact({ state: "found", item: { ...plainItem(lockRow(iso(NOW.getTime() + 1_000)) as never), owner: "someone" } }, NOW)).toMatchObject({ state: "unreadable" });
    expect(lockFact({ state: "unreadable", reason: "denied" }, NOW)).toEqual({ state: "unreadable", reason: "denied" });
  });

  it("is a refusal in the owner's words naming the run and the time", () => {
    const held = read(iso(NOW.getTime() + 3_600_000)) as Extract<ReturnType<typeof lockFact>, { state: "held" }>;
    expect(lockHeldMessage(held)).toBe(`a renewal (run ${RUN_ID}) or a by-hand qualification holds the renewal lock until ${held.expiresAt}; wait for it to end, then run this again`);
  });
});

describe("the last renewal", () => {
  it("is the run record the model-check runner pointer names", () => {
    const { reader, calls } = fakeReader({ [POINTER_KEY]: pointerRow(), [RUN_KEY]: runRecord() });
    expect(readLastRun(reader, input)).toEqual({
      state: "found", runId: RUN_ID, switchedAt: "2026-10-26T06:30:00.000Z", generation: 3, newRunner: NEW_RUNNER.instanceId, previousRunner: OLD_RUNNER.instanceId,
      amiId: "ami-0123456789abcdef0", workerImage: `123456789012.dkr.ecr.us-east-1.amazonaws.com/worker@sha256:${"b".repeat(64)}`, executorImage: null, pointerRunner: NEW_RUNNER.instanceId,
    });
    expect(calls).toHaveLength(2);
  });

  it("is none when no automatic renewal ever switched (no pointer, or one a script wrote without a run id)", () => {
    expect(readLastRun(fakeReader({}).reader, input)).toEqual({ state: "none" });
    expect(readLastRun(fakeReader({ [POINTER_KEY]: item({ pk: "E2E_MODEL_ROUTES", sk: "E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1", instanceId: "i-0123456789abcdef0" }) }).reader, input)).toEqual({ state: "none" });
  });

  it("is unreadable, never none, when the pointer or the record cannot be read, is missing, or is not a renewal record", () => {
    expect(readLastRun(fakeReader({ [POINTER_KEY]: "DENIED" }).reader, input)).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(readLastRun(fakeReader({ [POINTER_KEY]: "DENIED" }).reader, input))).toContain("runner pointer could not be read");
    expect(readLastRun(fakeReader({ [POINTER_KEY]: pointerRow() }).reader, input)).toEqual({ state: "unreadable", reason: "the runner pointer names a renewal whose record is missing" });
    expect(readLastRun(fakeReader({ [POINTER_KEY]: pointerRow(), [RUN_KEY]: "DENIED" }).reader, input)).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(readLastRun(fakeReader({ [POINTER_KEY]: pointerRow(), [RUN_KEY]: "DENIED" }).reader, input))).toContain("run record could not be read");
    expect(readLastRun(fakeReader({ [POINTER_KEY]: pointerRow(), [RUN_KEY]: runRecord({ generation: 0 }) }).reader, input)).toEqual({ state: "unreadable", reason: "the run record is not a renewal record" });
    expect(readLastRun(fakeReader({ [POINTER_KEY]: pointerRow(), [RUN_KEY]: runRecord({ extra: "field" }) }).reader, input)).toMatchObject({ state: "unreadable" });
    expect(readLastRun(fakeReader({ [POINTER_KEY]: item({ pk: "E2E_MODEL_ROUTES", sk: "E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1", requalifyRunId: 7 }) }).reader, input)).toEqual({ state: "unreadable", reason: "the runner pointer's requalifyRunId is not text" });
  });

  it("notes the runner the pointer names now when a by-hand qualification replaced it afterwards", () => {
    const { reader } = fakeReader({ [POINTER_KEY]: pointerRow({ instanceId: "i-0aaaaaaaaaaaaaaaa" }), [RUN_KEY]: runRecord() });
    expect(readLastRun(reader, input)).toMatchObject({ state: "found", pointerRunner: "i-0aaaaaaaaaaaaaaaa", newRunner: NEW_RUNNER.instanceId });
  });
});

describe("readInstalledFacts", () => {
  it("reads the lock, the hold and the last renewal, and nothing else", () => {
    const { reader, calls } = fakeReader({ [LOCK_KEY]: lockRow(iso(NOW.getTime() + 60_000)), [HOLD_KEY]: item({ pk: "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", sk: "HOLD" }), [POINTER_KEY]: pointerRow(), [RUN_KEY]: runRecord() });
    const facts = readInstalledFacts(reader, { ...input, now: NOW });
    expect(facts).toMatchObject({ state: "installed", lock: { state: "held", runId: RUN_ID }, hold: "present", lastRun: { state: "found", generation: 3 } });
    expect(calls.map((call) => call[call.indexOf("--expression-attribute-values") + 1]).map((text) => (JSON.parse(text ?? "{}") as { ":pk": { S: string } })[":pk"].S).sort())
      .toEqual(["E2E_MODEL_ROUTES", "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", "RUNTIME_REQUALIFY#linux-arm64-web-api-v1", `RUNTIME_REQUALIFY_RUN#${RUN_ID}`].sort());
    const quiet = readInstalledFacts(fakeReader({}).reader, { ...input, now: NOW });
    expect(quiet).toEqual({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: { state: "none" } });
    expect(readInstalledFacts(fakeReader({ [HOLD_KEY]: "DENIED" }).reader, { ...input, now: NOW }).hold).toBe("unreadable");
  });
});

describe("requalifyFindings", () => {
  const NOW_COMMAND = "npx tsx scripts/test-deploy.ts --env x --profile p --only requalify-now --apply";
  const kinds = (facts: Parameters<typeof requalifyFindings>[0]) => requalifyFindings(facts, NOW_COMMAND).map((finding) => `${finding.severity} ${finding.kind}`);
  const found = { state: "found", runId: RUN_ID, switchedAt: "2026-10-26T06:30:00.000Z", generation: 3, newRunner: NEW_RUNNER.instanceId, previousRunner: OLD_RUNNER.instanceId, amiId: "ami-0123456789abcdef0", workerImage: "w@sha256:1", executorImage: null, pointerRunner: NEW_RUNNER.instanceId } as const;

  it("says nothing without facts, and says it is not installed (information, never an error) when the stack lacks the renewal", () => {
    expect(requalifyFindings(undefined, NOW_COMMAND)).toEqual([]);
    expect(kinds({ state: "not-installed" })).toEqual(["info requalify-not-installed"]);
    expect(requalifyFindings({ state: "not-installed" }, NOW_COMMAND)[0]!.message).toContain("--only requalify-infra");
  });

  it("reports the last renewal in full: run, time, generation, both runners, AMI and images", () => {
    const [finding] = requalifyFindings({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: found }, NOW_COMMAND);
    expect(finding).toMatchObject({ severity: "info", kind: "requalify-last-run" });
    for (const part of [RUN_ID, "2026-10-26T06:30:00.000Z", "generation 3", NEW_RUNNER.instanceId, OLD_RUNNER.instanceId, "ami-0123456789abcdef0", "w@sha256:1", "executor image none"]) expect(finding!.message).toContain(part);
  });

  it("names the owner's start command when no automatic renewal has switched yet, and reports a held lock and a hold", () => {
    const none = requalifyFindings({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: { state: "none" } }, NOW_COMMAND);
    expect(none).toHaveLength(1);
    expect(none[0]!.message).toContain(NOW_COMMAND);
    // A by-hand qualification writes the pointer without the run id, so "none" can also mean a later by-hand renewal hid the last automatic one.
    expect(none[0]!.message).toMatch(/or a by-hand qualification replaced it/);
    const busy = requalifyFindings({ state: "installed", lock: { state: "held", runId: RUN_ID, expiresAt: "2026-10-27T15:00:00.000Z" }, hold: "present", lastRun: found }, NOW_COMMAND);
    expect(busy.map((finding) => `${finding.severity} ${finding.kind}`)).toEqual(["info requalify-running", "info requalify-running", "info requalify-last-run"]);
    expect(busy[0]!.message).toContain(RUN_ID);
  });

  it("warns, never stays silent, on what it cannot read, and on a pointer a by-hand qualification moved", () => {
    expect(kinds({ state: "installed", lock: { state: "unreadable", reason: "denied" }, hold: "unreadable", lastRun: { state: "unreadable", reason: "gone" } }))
      .toEqual(["warning requalify-unreadable", "warning requalify-unreadable", "warning requalify-unreadable"]);
    expect(kinds({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: { ...found, pointerRunner: "i-0aaaaaaaaaaaaaaaa" } })).toEqual(["info requalify-last-run", "warning requalify-last-run"]);
  });

  it("never makes the check fail: nothing here is an error", () => {
    const all: Parameters<typeof requalifyFindings>[0][] = [
      { state: "not-installed" },
      { state: "installed", lock: { state: "unreadable", reason: "x" }, hold: "unreadable", lastRun: { state: "unreadable", reason: "y" } },
      { state: "installed", lock: { state: "held", runId: RUN_ID, expiresAt: "z" }, hold: "present", lastRun: { state: "none" } },
    ];
    for (const facts of all) expect(requalifyFindings(facts, NOW_COMMAND).filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("goes through evaluateTestDeployCheck with the renewal command the check passes (the owner's start command once installed)", () => {
    const result = evaluateTestDeployCheck({
      headTemplate: {}, deployedTemplate: {}, lambdaCodeShas: {}, builtZipShas: {}, catalogRows: [], runnerFacts: undefined, now: NOW,
      renewCommand: NOW_COMMAND, requalify: { state: "installed", lock: { state: "free" }, hold: "none", lastRun: { state: "none" } },
    });
    expect(result.findings.find((finding) => finding.kind === "requalify-last-run")?.message).toContain(NOW_COMMAND);
  });
});

describe("parseStartAnswer", () => {
  it("takes only { started, reason }; anything else is refused so a start nobody can confirm is never reported as started", () => {
    expect(parseStartAnswer('{"started":true,"reason":"requested"}')).toEqual({ started: true, reason: "requested" });
    expect(parseStartAnswer('{"started":false,"reason":"already-started"}')).toEqual({ started: false, reason: "already-started" });
    expect(() => parseStartAnswer("<html>")).toThrow(/not JSON/);
    expect(() => parseStartAnswer("null")).toThrow(/not \{ started, reason \}/);
    expect(() => parseStartAnswer('{"started":"yes","reason":"requested"}')).toThrow(/not \{ started, reason \}/);
    expect(() => parseStartAnswer('{"started":true}')).toThrow(/not \{ started, reason \}/);
  });
});

// ---------------------------------------------------------------------------------------------
// Tier 3: the statements for the new grants, from the synthesized templates (the same comparison the check and the code deploy use)
// ---------------------------------------------------------------------------------------------

describe("the IAM statements the check prints for the renewal's grants", () => {
  const lambdaRole = "RuntimeRequalifyStepsServiceRole13C83860";
  const policyId = "RuntimeRequalifyStepsServiceRoleDefaultPolicyEE5F0143";
  const drainRead = { Sid: "DrainRead", Effect: "Allow", Action: ["dynamodb:Query", "dynamodb:GetItem"], Resource: ["arn:table", "arn:table/index/bySessionState"], Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["READY", "WORKSPACE#*", "RUNTIME_REQUALIFY_WORK#*", "PROJECT_SETUP#*"] } } };
  const other = { Effect: "Allow", Action: "sns:Publish", Resource: "arn:topic" };
  const headWithRenewal = (statements: unknown[]): CfnTemplate => ({
    Resources: {
      [REQUALIFY_LAMBDA.logicalId]: { Type: "AWS::Lambda::Function", Properties: { Role: { "Fn::GetAtt": [lambdaRole, "Arn"] } } },
      [lambdaRole]: { Type: "AWS::IAM::Role", Properties: {} },
      [policyId]: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: lambdaRole }], PolicyDocument: { Statement: statements } } },
      BrokerServiceRole1938BCC9: { Type: "AWS::IAM::Role", Properties: {} },
      BrokerServiceRoleDefaultPolicyDDFD9E7E: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "BrokerServiceRole1938BCC9" }], PolicyDocument: { Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:bucket/*" }] } } },
    },
  });

  it("lists every statement of the renewal's roles while the stack lacks them, and only those", () => {
    const planned = plannedRequalifyGrants(headWithRenewal([drainRead, other]), { Resources: { BrokerServiceRole1938BCC9: { Type: "AWS::IAM::Role" } } });
    expect(planned.map((finding) => [finding.kind, finding.policyLogicalId])).toEqual([["iam-missing-grant", policyId]]);
    const text = tier3Request(planned);
    expect(text).toContain(`Add to ${policyId} (role ${lambdaRole})`);
    expect(text).toContain("dynamodb:Query");
    expect(text).toContain("RUNTIME_REQUALIFY_WORK#*");
    expect(text).toContain("sns:Publish");
    // The Broker's own grant is not the renewal's and is not listed.
    expect(text).not.toContain("s3:GetObject");
  });

  it("is quiet once the stack has them", () => {
    const head = headWithRenewal([drainRead, other]);
    expect(plannedRequalifyGrants(head, head)).toEqual([]);
  });

  it("prints exactly the DrainRead statement when an installed stack lacks it (AR-3), and refuses the code deploy that would run without it", () => {
    const head = headWithRenewal([drainRead, other]);
    const deployed = headWithRenewal([other]);
    const findings: Finding[] = evaluateTestDeployCheck({ headTemplate: head, deployedTemplate: deployed, lambdaCodeShas: {}, builtZipShas: {}, catalogRows: [], runnerFacts: undefined, now: NOW }).findings
      .filter((finding) => finding.kind === "iam-missing-grant");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.statements).toEqual([{ Effect: "Allow", Action: ["dynamodb:Query", "dynamodb:GetItem"], Resource: ["arn:table", "arn:table/index/bySessionState"], Condition: drainRead.Condition }]);
    expect(tier3Request(findings)).toContain("PROJECT_SETUP#*");
    // The renewal's Lambda moves only on a stack that has it: then its role's gap refuses the apply.
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head, true)).toThrow(/iam-missing-grant RuntimeRequalifySteps/);
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head, false)).not.toThrow();
    expect(() => assertCheckAllowsApply(findings, ["broker"], head, true)).not.toThrow();
  });

  it("uses the context flag and prefix the infra gives the renewal", () => {
    expect(REQUALIFY_INFRA.context["agentx:autoRequalify"]).toBe("enabled");
    expect(REQUALIFY_INFRA.logicalIdPrefix).toBe("RuntimeRequalify");
    expect(REQUALIFY_LAMBDA.logicalId.startsWith(REQUALIFY_INFRA.logicalIdPrefix)).toBe(true);
  });
});

describe("the requalify-schedule unit (AR-5 review I1)", () => {
  it("enables the daily check with a change set that may touch only the schedule's State, after the ready check, and verifies it", () => {
    const steps = plan(["requalify-schedule"], true);
    expect(steps.map((step) => step.kind)).toEqual(["check-requalify-ready", "create-change-set", "execute-change-set", "verify-requalify-schedule", "record-requalify-enabled"]);
    const changeSet = steps[1] as Extract<DeployStep, { kind: "create-change-set" }>;
    expect(changeSet).toMatchObject({ stack: CONTROL_PLANE, template: { source: "enable-schedule" }, expect: { action: "Modify", logicalIds: [REQUALIFY_SCHEDULE_LOGICAL_ID], allowedAttributes: ["Properties.State"] } });
    expect(steps[3]).toMatchObject({ kind: "verify-requalify-schedule", logicalId: REQUALIFY_SCHEDULE_LOGICAL_ID });
    // The guard accepts the State change and nothing else.
    const modify = (attributes: string[]): ObservedChange[] => [{ action: "Modify", logicalId: REQUALIFY_SCHEDULE_LOGICAL_ID, type: "AWS::Scheduler::Schedule", attributes, replacement: "False" }];
    expect(() => assertOnlyExpectedChanges(modify(["Properties.State"]), changeSet.expect)).not.toThrow();
    expect(() => assertOnlyExpectedChanges(modify(["Properties.State", "Properties.ScheduleExpression"]), changeSet.expect)).toThrow(/also changes Properties.ScheduleExpression/);
    expect(() => assertOnlyExpectedChanges([...modify(["Properties.State"]), { action: "Modify", logicalId: "RuntimeRequalifyStepsAC5E645B", type: "AWS::Lambda::Function", attributes: ["Properties.Code"] }], changeSet.expect)).toThrow(/unexpected changes/);
    expect(formatPlan(steps)).toContain(`${REQUALIFY_SCHEDULE_LOGICAL_ID} State set to ENABLED`);
  });

  it("runs alone and only where the renewal is installed", () => {
    expect(() => plan(["requalify-schedule"], false)).toThrow(/deploy requalify-infra first/);
    expect(() => plan(["requalify-schedule"])).toThrow(/deploy requalify-infra first/);
    expect(() => plan(["requalify-schedule", "requalify-now"], true)).toThrow(/runs on its own/);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "requalify-schedule"]).only).toEqual(["requalify-schedule"]);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p"]).only).not.toContain("requalify-schedule");
  });

  it("sets the State of the schedule and nothing else, on a copy, and refuses a stack without the schedule", () => {
    const template: CfnTemplate = { Resources: { [REQUALIFY_SCHEDULE_LOGICAL_ID]: { Type: "AWS::Scheduler::Schedule", Properties: { State: "DISABLED", ScheduleExpression: "cron(0 6 * * ? *)" } }, Other: { Type: "AWS::SNS::Topic" } } };
    const enabled = enableScheduleTemplate(template);
    expect(enabled.Resources?.[REQUALIFY_SCHEDULE_LOGICAL_ID]?.Properties).toEqual({ State: "ENABLED", ScheduleExpression: "cron(0 6 * * ? *)" });
    expect(enabled.Resources?.Other).toEqual(template.Resources?.Other);
    expect(template.Resources?.[REQUALIFY_SCHEDULE_LOGICAL_ID]?.Properties?.State).toBe("DISABLED");
    expect(() => enableScheduleTemplate({ Resources: {} })).toThrow(/deploy requalify-infra first/);
    expect(() => enableScheduleTemplate({ Resources: { [REQUALIFY_SCHEDULE_LOGICAL_ID]: { Type: "AWS::SNS::Topic" } } })).toThrow(/deploy requalify-infra first/);
  });

  it("names the owner's order: stack update, control-plane-code, requalify-infra, tags, requalify-now, then the schedule", () => {
    const at = (needle: string) => REQUALIFY_DEPLOY_ORDER.indexOf(needle);
    const order = ["Tier 3", "control-plane-code", "requalify-infra", "agentx:requalify-managed=true", "requalify-now", "requalify-schedule"].map(at);
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(REQUALIFY_DEPLOY_ORDER).toContain("DISABLED");
  });
});

describe("readiness before a renewal starts", () => {
  const TAGS = { DeploymentMode: "e2e-qualification", Environment: ENV, "agentx:requalify-managed": "true" };
  const ready = { state: "read", instanceId: "i-0fcff78d50c71bc57", instanceState: "running", instanceTags: TAGS, volumes: [{ volumeId: "vol-02fd92eeeb0b1b1d4", tags: TAGS }] } as const;
  const finding = (kind: Finding["kind"], severity: Finding["severity"] = "error"): Finding => ({ kind, severity, subject: "X", label: "Broker", message: "m" });

  it("is ready with current code, a running tagged runner and a tagged workspace volume", () => {
    expect(readinessProblems([], ready, ENV)).toEqual([]);
    expect(readinessProblems([finding("catalog-expiring", "warning"), finding("requalify-last-run", "info")], ready, ENV)).toEqual([]);
  });

  it("refuses on a stale Lambda, a missing grant or a missing environment variable, each in its own words", () => {
    expect(readinessProblems([finding("stale-lambda")], ready, ENV)).toEqual(["control-plane-code is not current: stale-lambda Broker"]);
    expect(readinessProblems([finding("iam-missing-grant")], ready, ENV)).toEqual(["the control-plane stack is not current: iam-missing-grant Broker"]);
    expect(readinessProblems([finding("lambda-env-missing")], ready, ENV)).toEqual(["the control-plane stack is not current: lambda-env-missing Broker"]);
  });

  it("refuses a runner or a volume missing any one of the three tags, or the wrong environment", () => {
    for (const key of Object.keys(TAGS)) {
      const without = Object.fromEntries(Object.entries(TAGS).filter(([name]) => name !== key));
      expect(readinessProblems([], { ...ready, instanceTags: without }, ENV)[0], key).toContain(`runner ${ready.instanceId} lacks the tags`);
      expect(readinessProblems([], { ...ready, volumes: [{ volumeId: "vol-02fd92eeeb0b1b1d4", tags: without }] }, ENV)[0], key).toContain("workspace volume vol-02fd92eeeb0b1b1d4");
    }
    expect(readinessProblems([], { ...ready, instanceTags: { ...TAGS, Environment: "other" } }, ENV)[0]).toContain(`Environment=${ENV}`);
    expect(readinessProblems([], { ...ready, instanceState: "stopped" }, ENV)).toEqual([`the current runner ${ready.instanceId} is stopped, not running`]);
    expect(readinessProblems([], { ...ready, volumes: [] }, ENV)[0]).toContain("no separate workspace volume");
  });

  it("is never ready when the runner cannot be read, and still reports the stale code beside it", () => {
    expect(readinessProblems([finding("stale-lambda")], { state: "unknown", reason: "no runner pointer is recorded" }, ENV))
      .toEqual(["control-plane-code is not current: stale-lambda Broker", "the current runner cannot be checked for its tags: no runner pointer is recorded"]);
  });

  describe("readRunnerTags", () => {
    const POINTER = "E2E_MODEL_ROUTES|E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1";
    const reader = (answers: { instance?: unknown; volumes?: unknown; pointer?: Row | "DENIED" | undefined }): { reader: RequalifyReader; calls: string[][] } => {
      const inner = fakeReader(answers.pointer === undefined ? {} : { [POINTER]: answers.pointer });
      const calls: string[][] = [];
      return {
        calls,
        reader: {
          aws(args, allowFailure) {
            calls.push([...args]);
            if (args[0] === "ec2" && args[1] === "describe-instances") return answers.instance === undefined ? { status: 254, stdout: "", stderr: "denied" } : { status: 0, stdout: JSON.stringify(answers.instance), stderr: "" };
            if (args[0] === "ec2" && args[1] === "describe-volumes") return answers.volumes === undefined ? { status: 254, stdout: "", stderr: "denied" } : { status: 0, stdout: JSON.stringify(answers.volumes), stderr: "" };
            return inner.reader.aws(args, allowFailure);
          },
        },
      };
    };
    const tagList = (tags: Record<string, string>) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
    const pointer = item({ pk: "E2E_MODEL_ROUTES", sk: "E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1", instanceId: "i-0fcff78d50c71bc57" });

    it("reads the pointer's instance and the volumes that outlive it (not the root), with read-only calls", () => {
      const { reader: r, calls } = reader({ pointer, instance: [{ state: "running", tags: tagList(TAGS) }], volumes: [{ id: "vol-root00000001", tags: null, root: true }, { id: "vol-02fd92eeeb0b1b1d4", tags: tagList(TAGS), root: false }] });
      expect(readRunnerTags(r, input)).toEqual({ state: "read", instanceId: "i-0fcff78d50c71bc57", instanceState: "running", instanceTags: TAGS, volumes: [{ volumeId: "vol-02fd92eeeb0b1b1d4", tags: TAGS }] });
      expect(calls.map((call) => `${call[0]} ${call[1]}`)).toEqual(["dynamodb query", "ec2 describe-instances", "ec2 describe-volumes"]);
      expect(calls[1]).toContain("i-0fcff78d50c71bc57");
      expect(calls[2]).toContain("Name=attachment.instance-id,Values=i-0fcff78d50c71bc57");
    });

    it("is unknown, never ready, on every read that fails or answers something else", () => {
      const ok = { instance: [{ state: "running", tags: [] }], volumes: [] };
      expect(readRunnerTags(reader({ ...ok }).reader, input)).toMatchObject({ state: "unknown", reason: "no runner pointer is recorded" });
      expect(readRunnerTags(reader({ ...ok, pointer: "DENIED" }).reader, input)).toMatchObject({ state: "unknown" });
      expect(readRunnerTags(reader({ ...ok, pointer: item({ pk: "E2E_MODEL_ROUTES", sk: "x" }) }).reader, input)).toEqual({ state: "unknown", reason: "the runner pointer names no instance" });
      expect(readRunnerTags(reader({ pointer, volumes: [] }).reader, input)).toMatchObject({ state: "unknown", reason: expect.any(String) as string });
      expect(readRunnerTags(reader({ pointer, instance: [], volumes: [] }).reader, input)).toMatchObject({ state: "unknown" });
      expect(readRunnerTags(reader({ pointer, instance: [{ state: "running", tags: [] }] }).reader, input)).toMatchObject({ state: "unknown" });
    });
  });
});

describe("the requalify-drain-iam unit (DRAINREAD review I1)", () => {
  const POLICY = REQUALIFY_STEPS_POLICY_LOGICAL_ID;
  const broad = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["READY", "WORKSPACE#*"] } };
  const narrow = { ...broad, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "workspaceId"] }, StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } };
  const template = (condition: unknown, extra: Record<string, unknown> = {}): CfnTemplate => ({
    Resources: {
      [POLICY]: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role" }], PolicyDocument: { Statement: [
        { Sid: "Other", Effect: "Allow", Action: "sns:Publish", Resource: "arn:topic" },
        { Sid: "DrainRead", Effect: "Allow", Action: ["dynamodb:Query", "dynamodb:GetItem"], Resource: ["arn:table"], Condition: condition },
      ] } } },
      Lambda: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "old" } } },
      ...extra,
    },
  });
  const planIam = (installed?: boolean) => plan(["requalify-drain-iam"], installed);

  it("plans: build the renewal zip, refuse unless it is live, then ONE guarded change set (Modify of the steps policy only) on the deployed template with every parameter UsePreviousValue, execute, verify", () => {
    const steps = planIam(true);
    expect(steps.map((step) => step.kind)).toEqual(["build-lambda-zip", "check-lambda-code-current", "create-change-set", "execute-change-set", "verify-requalify-drain-iam"]);
    expect(steps[1]).toMatchObject({ kind: "check-lambda-code-current", stack: CONTROL_PLANE, logicalId: REQUALIFY_LAMBDA.logicalId, expectedSha256Base64: { fromStep: "build-requalify-steps", output: "sha256Base64" } });
    const changeSet = steps[2] as Extract<DeployStep, { kind: "create-change-set" }>;
    expect(changeSet).toMatchObject({
      stack: CONTROL_PLANE, template: { source: "narrow-drain-read", identityMode: "cognito" },
      expect: { action: "Modify", logicalIds: [POLICY], allowedAttributes: ["Properties.PolicyDocument"] },
    });
    // Every parameter of the stack is kept as it is (a missing one would fall back to its default and change other resources).
    expect(changeSet.parameters.length).toBeGreaterThan(0);
    expect(changeSet.parameters.every((parameter) => "usePreviousValue" in parameter)).toBe(true);
    // The guard: the policy's PolicyDocument alone passes; another resource, another attribute, an Add or a replacement does not.
    const modify = (logicalId: string, attributes: string[], replacement = "False"): ObservedChange => ({ action: "Modify", logicalId, type: "AWS::IAM::Policy", attributes, replacement });
    expect(() => assertOnlyExpectedChanges([modify(POLICY, ["Properties.PolicyDocument"])], changeSet.expect)).not.toThrow();
    expect(() => assertOnlyExpectedChanges([modify(POLICY, ["Properties.PolicyDocument", "Properties.Roles"])], changeSet.expect)).toThrow(/also changes Properties.Roles/);
    expect(() => assertOnlyExpectedChanges([modify(POLICY, ["Properties.PolicyDocument"], "True")], changeSet.expect)).toThrow(/would replace/);
    expect(() => assertOnlyExpectedChanges([modify(POLICY, ["Properties.PolicyDocument"]), modify("RuntimeRequalifyMachineRoleDefaultPolicyAAACD94F", ["Properties.PolicyDocument"])], changeSet.expect)).toThrow(/unexpected changes/);
    expect(() => assertOnlyExpectedChanges([modify(POLICY, ["Properties.PolicyDocument"]), { action: "Add", logicalId: "RuntimeRequalifyStepsServiceRoleOverflowPolicy1", type: "AWS::IAM::ManagedPolicy" }], changeSet.expect)).toThrow(/unexpected changes/);
    const text = formatPlan(steps);
    expect(text).toContain("stop unless RuntimeRequalifyStepsAC5E645B CodeSha256 equals <build-requalify-steps.sha256Base64>");
    expect(text).toContain(`only the Condition of the DrainRead statement in ${POLICY}`);
    expect(text).toContain("all UsePreviousValue");
  });

  it("runs alone, only where the renewal is installed, and is not a default unit", () => {
    expect(() => planIam(false)).toThrow(/deploy requalify-infra first/);
    expect(() => planIam()).toThrow(/deploy requalify-infra first/);
    expect(() => plan(["requalify-drain-iam", "control-plane-code"], true)).toThrow(/runs on its own/);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "requalify-drain-iam"]).only).toEqual(["requalify-drain-iam"]);
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p"]).only).not.toContain("requalify-drain-iam");
    expect(parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "requalify-drain-iam"]).apply).toBe(false);
  });

  it("changes only the DrainRead Condition of the deployed template, taking nothing else from head", () => {
    const deployed = template(broad);
    const head = template(narrow, { Lambda: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "new" } } } });
    const result = narrowDrainReadTemplate(deployed, head);
    expect(drainReadIsNarrowed(deployed)).toBe(false);
    expect(drainReadIsNarrowed(result)).toBe(true);
    // Head's Lambda asset did not ride along; the deployed one stays. The input is not changed.
    expect(result.Resources?.["Lambda"]).toEqual(deployed.Resources?.["Lambda"]);
    const statements = (result.Resources?.[POLICY]?.Properties?.["PolicyDocument"] as { Statement: Array<{ Sid: string; Condition?: unknown }> }).Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual(["Other", "DrainRead"]);
    expect(statements[1]!.Condition).toEqual(narrow);
    expect(statements[0]).toEqual((deployed.Resources?.[POLICY]?.Properties?.["PolicyDocument"] as { Statement: unknown[] }).Statement[0]);
    expect(drainReadIsNarrowed(deployed)).toBe(false);
    // Already narrowed: nothing to change.
    expect(narrowDrainReadTemplate(result, head)).toBe(result);
  });

  it("refuses head's statement unless it is the same grant with a narrower condition, and a stack without the policy", () => {
    const deployed = template(broad);
    // A different LeadingKeys list is not a narrowing.
    expect(() => narrowDrainReadTemplate(deployed, template({ ...narrow, "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["READY"] } }))).toThrow(/not only a narrowing/);
    // A condition that drops a part of the deployed one is a widening.
    expect(() => narrowDrainReadTemplate(template(narrow), template(broad))).toThrow(/not only a narrowing/);
    // Another action is another grant.
    const wider = template(narrow);
    ((wider.Resources?.[POLICY]?.Properties?.["PolicyDocument"] as { Statement: Array<{ Sid: string; Action: unknown }> }).Statement[1]!).Action = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"];
    expect(() => narrowDrainReadTemplate(deployed, wider)).toThrow(/Effect or Action differs/);
    expect(() => narrowDrainReadTemplate({ Resources: {} }, template(narrow))).toThrow(/deploy requalify-infra first/);
    expect(() => narrowDrainReadTemplate(deployed, { Resources: {} })).toThrow(/head has no/);
  });
});
