# Phase 15c2: Deploy Engines and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AgentX can deploy (install or upgrade) a named environment from a release, with either
engine:
- **templates**, the default: published CloudFormation templates run as change sets through the
  environment's CloudFormation service role;
- **cdk**: `cdk deploy` from a checkout of the release tag.

A platform team can instead take everything it needs as an `agentx init --export` bundle. The
phase ends with a first real install of a throwaway environment in the AgentX account.

**Architecture:**
- **One deployer interface, two engines.** `StackDeployer` has a templates engine (AWS SDK: S3 and
  CloudFormation change sets) and a cdk engine (a `cdk deploy` subprocess behind an injected
  runner).
- **An orchestrator** (`deployEnvironment`) runs the stacks in `installOrder` or `upgradeOrder`. It:
  - takes the environment lock;
  - refuses a different engine than the one the environment was installed with;
  - feeds each stack's outputs into the next through `stackParameters`;
  - gets or creates the callback signing key in Secrets Manager;
  - writes the environment's settings to SSM when an install completes.
- **Releases carry one template set per supported region,** because the foundation stack picks the
  region's verified AgentCore availability zones at synthesis. This resolves the phase 15c1 region
  blocker by making templates per-region rather than region-free. The installer refuses a region
  the release doesn't cover.
- **Commands:**
  - `agentx init --export` writes the bundle with no AWS write calls;
  - a scriptable `agentx deploy` command drives installs and upgrades. It is what phase 15d's
    wizard calls, and what the live check uses.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest, AWS SDK v3 3.1134.0
(`@aws-sdk/client-cloudformation`, `@aws-sdk/client-s3`, `@aws-sdk/client-secrets-manager`,
`@aws-sdk/client-ssm`, `@aws-sdk/client-sts`), AWS CDK CLI (already a dev dependency), commander 15.

**Spec:** [../spec.md](../spec.md):
- FR-007: engine choice stored and reused.
- FR-009: templates engine, artifact bucket, change sets.
- FR-011: cdk engine at the release tag, bootstrap check.
- FR-013: engine mismatch refusal.
- FR-026: `--export` with no AWS write calls.
- FR-015 in part: region support.
- FR-017 in part: show what will change before applying.
- The 15c1 ledger items: region portability, and live verification of pathed AgentCore roles.

The phase map is in [README.md](README.md).

**Branch:** `feat/015c2-deploy-engines`, cut from mainline `a252255` (phase 15c1 merged). One PR,
against `mainline`.

## Decisions recorded by this plan

- **Per-region templates.**
  - The release builder synthesizes the placeholder environment once for each region in
    `SUPPORTED_REGIONS`, which is exactly the regions with verified AgentCore Instances
    availability-zone IDs in `infra/lib/production-foundation.ts` (today: `us-east-1`).
  - Templates are written to `templates/<region>/<part>.template.json`. Code packages are shared
    across regions, because asset hashes don't depend on region.
  - Adding a region means adding its verified zone IDs. Nothing else changes.
- **The access stack is deployed with the caller's own credentials.** Every other stack is deployed
  through the service role named by the access stack's `CloudFormationRoleArn` output.
- **"No changes" is success.** A change set that fails only because it contains no changes is
  deleted, and the stack's current outputs are returned.
- **The cdk engine passes parameters as `cdk deploy --parameters`.** That includes the `NoEcho`
  callback signing key, which the CDK CLI only accepts as an argument.
  - The runner never logs or prints secret values. Its printed command replaces them with
    `<redacted>`.
  - The value is visible only to the operator's own machine's process list, for the length of that
    command. This is documented as the cdk engine's one difference in secret handling.
- **Image overrides are for testing only.** Until the first published release exists, an install
  can name private-ECR image digests directly (`images` in the deploy answers). `stackParameters`
  uses them as-is instead of mapping public images through the cache.
- **The live check deploys five stacks, not six:** access, foundation, identity, control-plane and
  runtime. The Slack service needs a real Slack app and bot token, which is phase 15d. The check
  reuses the account's existing GitHub App values, read from the production control plane's
  parameters.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Never run vitest with `-u`. Production's stacks are
  never touched by any test or by the live check. The live check uses a new environment name and
  only reads production stacks.
- **Phase 15b and 15c1 guarantees hold:** rendering equality, reproducible releases, full asset and
  parameter coverage, and the IAM scoping and boundary tests.
- **Exact names:**
  - uploaded package key: `packages/<assetId>.zip` (matching `keyParameterValue` `packages/||<assetId>.zip`);
  - uploaded template key: `templates/<version>/<region>/<part>.template.json`;
  - change set name: `agentx-<version with . replaced by ->-<unix seconds>`;
  - callback signing key secret: `agentx/<env>/callback-signing-key`, 48 random bytes base64url;
  - cdk construct ids: access `AgentXAccess`, foundation `AgentXProductionFoundation`, identity
    `AgentXIdentity`, runtime `AgentXProductionRuntime`, control-plane `AgentXControlPlane`,
    slack `AgentXSlackOrchestrator`.
- **Capabilities** on every change set: `CAPABILITY_IAM`, `CAPABILITY_NAMED_IAM`.
- **No secret value in output, logs, errors, settings or bundle files.** `SECRET_PARAMETERS` values
  are redacted wherever parameters are printed or written. The export bundle never contains the
  callback signing key. Its `deploy-access.sh` creates the key when needed.
- **Nothing in `init --export` calls an AWS write API.** A test runs it with AWS clients that throw
  on any call.
- **Commands:** the gate is `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22 (`export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`).
  - Known load flakes (issue #59): rerun that file alone.

## Review Focus

1. **A stack left half-deployed with no clear way forward:**
   - a change set that fails validation;
   - a stack stuck in `ROLLBACK_COMPLETE` from an earlier failed create;
   - a stack in `REVIEW_IN_PROGRESS` from a create change set that was never executed.

   Task 3 tests each state and requires a clear error that says what to do next. It must never be a
   silent success or a raw SDK error.
2. **A secret printed by accident:** in a change-set summary, a thrown error, the cdk runner's
   printed command, or a bundle parameter file. Tasks 3, 4 and 6 each assert that the callback
   signing key's value appears nowhere in the output they produce.
3. **The wrong template for the region:** installing into a region the release does not cover, or
   using another region's template. Tasks 1 and 2 refuse an uncovered region by name and pick the
   template by region.
4. **An upgrade run with the other engine, or into an environment whose settings are missing or
   invalid.** Task 5 refuses both and names the environment.
5. **A package upload that silently uses a stale or tampered zip:** the object already exists with
   different content, or the local file doesn't match `release.json`. Task 2 verifies checksums
   when it loads the release. Task 3 compares the existing object's recorded sha256 metadata and
   re-uploads when it differs.

---

### Task 1: One template set per supported region

**Files:**
- Modify: `infra/lib/production-foundation.ts` (export `SUPPORTED_REGIONS`)
- Modify: `packages/contracts/src/release.ts` (templates entries gain `region`)
- Modify: `scripts/release/build.ts`, `scripts/release/verify.ts`
- Modify: `docs/releases.md` (layout; `docs/` is gitignored, so use `git add -f`)
- Test: `tests/contract/release-build.test.ts`, `tests/contract/release-verify.test.ts` (update the
  layout expectations deliberately), `tests/contract/supported-regions.test.ts`

**Interfaces:**
- Produces:
  - `export const SUPPORTED_REGIONS: readonly string[]`: the keys of `DEFAULT_AZ_IDS`, sorted.
  - `ReleaseManifest.templates[i]` gains `region: string`. `file` becomes
    `templates/<region>/<part>.template.json`.
  - `buildRelease` synthesizes once per supported region (`agentxRegion: <region>`). It writes all
    parts for each region, in `STACK_PARTS` order, grouped by region in `SUPPORTED_REGIONS` order.
  - Packages are deduplicated across regions by asset id. The builder asserts every region produced
    the same asset ids with the same parameter names, and otherwise throws "region <r> produced
    different code packages".

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/supported-regions.test.ts
import { describe, expect, it } from "vitest";
import { SUPPORTED_REGIONS, defaultProductionAvailabilityZoneIds } from "../../infra/lib/production-foundation.js";

describe("supported regions", () => {
  it("are exactly the regions with verified AgentCore availability-zone IDs", () => {
    expect(SUPPORTED_REGIONS).toEqual(["us-east-1"]);
    for (const region of SUPPORTED_REGIONS) expect(defaultProductionAvailabilityZoneIds(region)).toHaveLength(2);
  });
});
```

In `tests/contract/release-build.test.ts`, change the layout expectations as follows:
- every `templates[i]` has `region: "us-east-1"`;
- `file` is `templates/us-east-1/<part>.template.json`;
- the parts per region are `["access", "foundation", "identity", "runtime", "control-plane", "slack"]`;
- the per-region asset-coverage check still holds;
- the reproducibility test compares templates by `(region, part)`.

Keep every other assertion. In `tests/contract/release-verify.test.ts`, compare templates by
`(region, part)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/supported-regions.test.ts tests/contract/release-build.test.ts`
Expected: FAIL, `SUPPORTED_REGIONS` is not exported and the templates carry no region.

- [ ] **Step 3: Implement**

- Export `SUPPORTED_REGIONS = Object.keys(DEFAULT_AZ_IDS).sort()`.
- In the manifest schema, add `region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)` to template
  entries, and refine that each `(region, part)` pair appears once.
- In `build.ts`, loop over `SUPPORTED_REGIONS`, calling the existing synthesis with
  `agentxRegion: region`. Collect templates per region and packages across regions.
- In `verify.ts`, key templates by `` `${region}/${part}` ``.
- Update `docs/releases.md`'s layout section.

- [ ] **Step 4: Run the release suites and the legacy snapshots**

Run: `npx vitest run tests/contract/supported-regions.test.ts tests/contract/release-build.test.ts tests/contract/release-verify.test.ts tests/contract/release-workflow.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/production-foundation.ts packages/contracts/src/release.ts scripts/release tests/contract
git add -f docs/releases.md
git commit -m "feat(release): one template set per supported region"
```

### Task 2: Loading a release for install, and image overrides

**Files:**
- Create: `packages/cli/src/deploy/release.ts`
- Modify: `packages/cli/src/deploy/parameters.ts` (optional `images` override on `InstallAnswers`)
- Test: `tests/contract/deploy-release.test.ts`, `tests/contract/deploy-parameters.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's manifest; `renderTemplate`, `ReleaseManifestSchema` from `@agentx/contracts`;
  `sha256Hex` from `scripts/release/hash.ts`. Copy the tiny helper into the CLI as
  `packages/cli/src/deploy/hash.ts`, because the CLI package cannot import from `scripts/`.
- Produces:

```ts
export interface LoadedRelease {
  manifest: ReleaseManifest;
  dir: string;
  /** The template for part in region, rendered for env. Throws when the release does not cover the region. */
  template(part: DeployPart, region: string, env: string): string;
  /** Absolute path of a package zip. */
  packagePath(assetId: string): string;
  regions(): string[];
}
/** Validates release.json and every file's sha256 before returning. */
export async function loadRelease(dir: string): Promise<LoadedRelease>;
```

- `InstallAnswers` gains `images?: { worker?: string; slack?: string }`.
  - A given image must be a digest reference, matching `^[^@\s]+@sha256:[a-f0-9]{64}$`.
  - It is used as-is for `WorkerImageUri` / `OrchestratorImageUri` instead of `privateImageUri(release.images.*)`.
  - The error for a non-digest override is "image override for <worker|slack> must be referenced by digest".

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/deploy-release.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { loadRelease } from "../../packages/cli/src/deploy/release.js";

let dir: string;
beforeAll(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "agentx-load-")), "r");
  await buildRelease({ version: "1.2.3", out: dir, gitCommit: "a".repeat(40) });
}, 900_000);

describe("loading a release for install", () => {
  it("renders a part's template for an environment in a covered region", async () => {
    const release = await loadRelease(dir);
    expect(release.regions()).toEqual(["us-east-1"]);
    const text = release.template("access", "us-east-1", "staging");
    expect(text).toContain("agentx-staging");
    expect(text).not.toContain("qqenv");
  });

  it("refuses a region the release does not cover, naming it", async () => {
    const release = await loadRelease(dir);
    expect(() => release.template("access", "eu-west-1", "staging")).toThrow(/release 1\.2\.3 does not cover region eu-west-1/);
  });

  it("refuses a release whose files do not match release.json", async () => {
    const tampered = join(await mkdtemp(join(tmpdir(), "agentx-tamper-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out: tampered, gitCommit: "a".repeat(40) });
    await writeFile(join(tampered, manifest.packages[0]!.file), "tampered");
    await expect(loadRelease(tampered)).rejects.toThrow(manifest.packages[0]!.file);
  }, 900_000);
});
```

Append to `tests/contract/deploy-parameters.test.ts`:

```ts
it("uses image overrides as-is, and only by digest", () => {
  const withOverrides = { ...answers(), images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${d("e")}` } };
  expect(stackParameters("runtime", withOverrides, outputs).WorkerImageUri).toBe(withOverrides.images.worker);
  expect(() => stackParameters("runtime", { ...answers(), images: { worker: "x/y:latest" } }, outputs)).toThrow("image override for worker must be referenced by digest");
});
```

- [ ] **Step 2: Run them to verify they fail, then implement**

`loadRelease` does the following:
1. Parse `release.json` with the schema.
2. For each template and package file, read it and compare its sha256. A mismatch or missing file
   throws "release file <file> does not match release.json".
3. Return the object:
   - `template` finds the entry for `(region, part)`, and throws the exact message when there is
     none;
   - `template` reads the file and returns `renderTemplate(text, env)`.

Run: `npx vitest run tests/contract/deploy-release.test.ts tests/contract/deploy-parameters.test.ts`
Expected: first FAIL, then PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/deploy tests/contract/deploy-release.test.ts tests/contract/deploy-parameters.test.ts
git commit -m "feat(cli): load a verified release for install; test-only image overrides"
```

### Task 3: The deployer interface and the templates engine

**Files:**
- Create: `packages/cli/src/deploy/deployer.ts` (interface and types)
- Create: `packages/cli/src/deploy/templates-engine.ts`
- Modify: `packages/cli/package.json` (add `"@aws-sdk/client-s3": "3.1134.0"`), then run `npm install`
- Modify: `infra/lib/access-policies.ts` (operator may enable termination protection on its five stacks)
- Test: `tests/contract/templates-engine.test.ts`, `tests/contract/access-policies.test.ts` (append)

**Interfaces:**
- Produces:

```ts
// deployer.ts
export type StackOutputs = Record<string, string>;
export type DeployEvent =
  | { kind: "uploading"; what: string }
  | { kind: "changes"; stackName: string; changes: Array<{ action: string; logicalId: string; type: string; replacement: string }> }
  | { kind: "no-changes"; stackName: string }
  | { kind: "deploying"; stackName: string }
  | { kind: "deployed"; stackName: string };
export interface DeployRequest {
  part: DeployPart;
  stackName: string;
  parameters: Record<string, string>;
  /** undefined for the access stack (deployed with the caller's credentials) */
  roleArn?: string;
  terminationProtection: boolean;
  onEvent?: (event: DeployEvent) => void;
}
export interface StackDeployer {
  deploy(request: DeployRequest): Promise<StackOutputs>;
  /** undefined when the stack does not exist */
  outputs(stackName: string): Promise<StackOutputs | undefined>;
}
/** Parts whose stacks carry termination protection: access, foundation, identity, runtime. */
export const PROTECTED_PARTS: ReadonlySet<DeployPart>;

// templates-engine.ts
export interface TemplatesEngineClients { cloudFormation: CloudFormationClient; s3: S3Client }
export function templatesDeployer(input: {
  clients: TemplatesEngineClients; release: LoadedRelease; env: string; region: string;
  artifactBucket: () => string;   // read lazily: known only after the access stack exists
  now?: () => number; pollMs?: number;
}): StackDeployer;
```

What `templatesDeployer.deploy` does, in order:
1. **Upload code packages.** For each package whose `parts` include `request.part`, HeadObject
   `packages/<assetId>.zip` in the artifact bucket. If it is missing, or its metadata `sha256`
   differs from the manifest, PutObject the file with metadata `sha256`. Emit `uploading`.
2. **Upload the template.** PutObject the rendered template to
   `templates/<version>/<region>/<part>.template.json`, and use its URL
   (`https://<bucket>.s3.<region>.amazonaws.com/<key>`) as `TemplateURL`. The access stack has no
   bucket yet, so pass its template as `TemplateBody`. It is small; assert it is under 51,200
   bytes, and otherwise throw "the access template is too large to deploy inline".
3. **Look at the current stack state** (DescribeStacks; a missing stack means `CREATE`):
   - `ROLLBACK_COMPLETE`: throw "stack <name> failed to create earlier and must be deleted before
     it can be deployed again (aws cloudformation delete-stack --stack-name <name>)".
   - `REVIEW_IN_PROGRESS` with no executed change set: treat as `CREATE`.
   - Any `*_IN_PROGRESS` other than `REVIEW_IN_PROGRESS`: throw "stack <name> is busy (<status>);
     try again when it finishes".
   - `*_FAILED`: throw "stack <name> is <status>; fix it in the AWS console before deploying".
   - Otherwise `UPDATE`.
4. **Create the change set.** CreateChangeSet with:
   - `ChangeSetName` per Global Constraints;
   - `ChangeSetType`, `TemplateURL` or `TemplateBody`;
   - `Parameters`, from the request as `{ ParameterKey, ParameterValue }`;
   - `Capabilities`;
   - `RoleARN` when given.

   Then poll DescribeChangeSet until it is `CREATE_COMPLETE` or `FAILED`.
5. **When it fails:**
   - If `StatusReason` contains "didn't contain changes" or "No updates are to be performed",
     DeleteChangeSet, emit `no-changes`, and return the current outputs.
   - Otherwise, DeleteChangeSet and throw "change set for <name> failed: <StatusReason>". The reason
     never contains parameter values, and a test asserts that.
6. **Show the changes:** emit `changes` from the change set's `Changes`.
7. **Deploy:** ExecuteChangeSet, emit `deploying`, then poll DescribeStacks until a terminal status.
   - Success is `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
   - Anything else throws "stack <name> ended in <status>: <the most recent FAILED resource status
     reason from DescribeStackEvents>".
8. **Protect new stacks:** on a new stack whose part is in `PROTECTED_PARTS`, call
   UpdateTerminationProtection with `true`.
9. **Finish:** emit `deployed` and return the outputs.

The policy change: in `operatorRoleStatements`, add `cloudformation:UpdateTerminationProtection`
to the change-set statement (the five non-access stacks). Test that it is there and only on those
stacks.

- [ ] **Step 1: Write the failing tests**

Use fake clients that record commands and answer from a scripted table. Build them with
`aws-sdk-client-mock` only if it is already a dependency. Otherwise write a minimal
`{ send(command) }` fake keyed on `command.constructor.name`; check first which one exists.

```ts
// tests/contract/templates-engine.test.ts: shape of the tests (write them fully)
// helpers: makeRelease() builds a small fake LoadedRelease (one package listed for control-plane,
// template text "{}" per part); fakeClients(script) returns { cloudFormation, s3, calls } where
// script maps command names to responses or errors in order.

it("creates a new stack with a change set through the service role, and protects it", ...)
//  expects calls: s3 HeadObject(packages/<id>.zip)->404, PutObject(packages/<id>.zip, Metadata.sha256),
//  PutObject(templates/1.2.3/us-east-1/runtime.template.json), CloudFormation DescribeStacks->ValidationError "does not exist",
//  CreateChangeSet{ChangeSetType:"CREATE", RoleARN, Capabilities:[CAPABILITY_IAM,CAPABILITY_NAMED_IAM], TemplateURL:https://bucket.s3.us-east-1.amazonaws.com/templates/1.2.3/us-east-1/runtime.template.json},
//  DescribeChangeSet->CREATE_COMPLETE with Changes, ExecuteChangeSet, DescribeStacks->CREATE_COMPLETE+Outputs,
//  UpdateTerminationProtection{EnableTerminationProtection:true}; returns the outputs; events include changes/deploying/deployed

it("deploys the access stack inline with the caller's credentials (no RoleARN, TemplateBody)", ...)
it("skips a package upload when the object's recorded sha256 matches, and re-uploads when it differs", ...)
it("treats a change set with no changes as success and deletes it", ...)
it("refuses a stack in ROLLBACK_COMPLETE with the delete command to run", ...)
it("treats REVIEW_IN_PROGRESS as a create", ...)
it("refuses a stack that is busy or failed, naming its status", ...)
it("reports the failing resource's reason when a deploy rolls back", ...)
it("never includes a secret parameter value in any thrown error or event", ...)
//  parameters include CallbackSigningKey: "s3cr3t-value-that-must-not-leak-00000000000";
//  force a change-set failure and a rollback; assert JSON.stringify(events) and every error message lack the value
```

Write each test fully, with its scripted responses and exact assertions. The comments above fix
the expected calls and messages.

- [ ] **Step 2: Run them to verify they fail, implement, and run them to see them pass**

Run: `npx vitest run tests/contract/templates-engine.test.ts tests/contract/access-policies.test.ts`
Expected: first FAIL, then PASS. Use a `pollMs` of `0` in tests.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/deploy infra/lib/access-policies.ts tests/contract/templates-engine.test.ts tests/contract/access-policies.test.ts
git commit -m "feat(cli): templates engine deploys stacks as change sets through the service role"
```

### Task 4: The cdk engine

**Files:**
- Create: `packages/cli/src/deploy/cdk-engine.ts`
- Test: `tests/contract/cdk-engine.test.ts`

**Interfaces:**
- Consumes: `StackDeployer`, `DeployRequest`, `PROTECTED_PARTS` (Task 3); `ParameterStore` (15a);
  `SECRET_PARAMETERS` (15c1).
- Produces:

```ts
export interface CommandRunner { run(command: string, args: string[], options: { cwd: string; display: string }): Promise<{ stdout: string }> }
export const CDK_CONSTRUCT_IDS: Record<DeployPart, string>;
export async function assertCdkBootstrapped(input: { store: ParameterStore; region: string }): Promise<void>;   // SSM /cdk-bootstrap/hnb659fds/version
export async function assertSourceAtRelease(input: { runner: CommandRunner; source: string; version: string }): Promise<void>; // git describe --tags --exact-match == v<version>
export function cdkDeployer(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc"; outputsDir: string; outputs: (stackName: string) => Promise<StackOutputs | undefined> }): StackDeployer;
```

- `cdkDeployer.deploy` runs `npx` with
  `cdk deploy <constructId> --exclusively --app "node infra/dist/bin/agentx.js" -c agentxEnv=<env> -c agentxRegion=<region> [-c agentxIdentity=oidc] --require-approval never --outputs-file <outputsDir>/<part>.json [--role-arn <roleArn>] --parameters <constructId>:<Key>=<Value> …`.
- It then reads the outputs file (`{ [stackName]: { key: value } }`) and returns that stack's
  outputs.
- `display` is the same command with every `SECRET_PARAMETERS` value replaced by `<redacted>`.
  The runner prints only `display`.
- Termination protection comes from the CDK app itself (`terminationProtection: true` on the
  protected stacks), so the engine does not call UpdateTerminationProtection.
- `assertCdkBootstrapped` throws "CDK is not bootstrapped in <region>; run: npx cdk bootstrap
  aws://<account>/<region> (or use --engine templates, which needs no bootstrap)" when the SSM
  parameter is missing.
- `assertSourceAtRelease` throws "the cdk engine must run from a checkout of tag v<version>; <source>
  is at <describe output or 'no tag'>".

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/cdk-engine.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CDK_CONSTRUCT_IDS, assertCdkBootstrapped, assertSourceAtRelease, cdkDeployer, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SECRET = "s3cr3t-value-that-must-not-leak-0000000000000";

function recordingRunner(outputsDir: string, outputs: Record<string, Record<string, string>>): CommandRunner & { calls: Array<{ command: string; args: string[]; display: string }> } {
  const calls: Array<{ command: string; args: string[]; display: string }> = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, display: options.display });
      const outIndex = args.indexOf("--outputs-file");
      if (outIndex >= 0) await writeFile(args[outIndex + 1]!, JSON.stringify(outputs));
      return { stdout: "" };
    },
  };
}

describe("cdk engine", () => {
  it("maps every part to its construct id", () => {
    expect(CDK_CONSTRUCT_IDS).toEqual({ access: "AgentXAccess", foundation: "AgentXProductionFoundation", identity: "AgentXIdentity", runtime: "AgentXProductionRuntime", "control-plane": "AgentXControlPlane", slack: "AgentXSlackOrchestrator" });
  });

  it("deploys one stack exclusively with its parameters and role, and returns its outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-control-plane": { ApiEndpoint: "https://x" } });
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    const out = await deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: { CallbackSigningKey: SECRET, OidcIssuer: "https://i" }, roleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", terminationProtection: false });
    expect(out).toEqual({ ApiEndpoint: "https://x" });
    const call = runner.calls[0]!;
    expect(call.command).toBe("npx");
    expect(call.args.slice(0, 4)).toEqual(["cdk", "deploy", "AgentXControlPlane", "--exclusively"]);
    expect(call.args).toContain("agentxEnv=staging");
    expect(call.args).toContain("--role-arn");
    expect(call.args).toContain(`AgentXControlPlane:OidcIssuer=https://i`);
    expect(call.display).not.toContain(SECRET);
    expect(call.display).toContain("AgentXControlPlane:CallbackSigningKey=<redacted>");
  });

  it("passes agentxIdentity=oidc when the environment brings its own provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-runtime": {} });
    await cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "oidc", outputsDir: dir, outputs: async () => undefined })
      .deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: true });
    expect(runner.calls[0]!.args).toContain("agentxIdentity=oidc");
  });

  it("refuses to run when CDK is not bootstrapped, naming the fix and the alternative", async () => {
    await expect(assertCdkBootstrapped({ store: new MemoryParameterStore(), region: "us-east-1" })).rejects.toThrow(/cdk bootstrap .*--engine templates/);
  });

  it("refuses a source checkout that is not at the release tag", async () => {
    const runner: CommandRunner = { run: async () => ({ stdout: "v1.2.2\n" }) };
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).rejects.toThrow("must run from a checkout of tag v1.2.3");
  });
});
```

Adjust the bootstrap message's account placeholder to what the function knows. If it has no
account, say `aws://<account>/<region>` literally, and the test's regex still passes.

- [ ] **Step 2: Run them to verify they fail, implement, and run them to see them pass**

Run: `npx vitest run tests/contract/cdk-engine.test.ts`
Expected: first FAIL, then PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/deploy/cdk-engine.ts tests/contract/cdk-engine.test.ts
git commit -m "feat(cli): cdk engine deploys one stack at a time from the release tag"
```

### Task 5: The callback signing key and the deploy orchestrator

**Files:**
- Create: `packages/cli/src/deploy/signing-key.ts`
- Create: `packages/cli/src/deploy/deploy-environment.ts`
- Test: `tests/contract/deploy-environment.test.ts`

**Interfaces:**
- Consumes: `installOrder`/`upgradeOrder`/`stackParameters` (15c1); `StackDeployer` (Task 3);
  `withEnvironmentLock`, settings read and write, and `ParameterStore` (15a); `LoadedRelease` (Task 2).
- Produces:

```ts
// signing-key.ts
export interface SecretValueStore { get(name: string): Promise<string | undefined>; create(name: string, value: string): Promise<void> }
export function secretsManagerValueStore(client: SecretsManagerClient): SecretValueStore;
/** Returns the environment's callback signing key, creating agentx/<env>/callback-signing-key (48 random bytes, base64url) when missing. */
export async function callbackSigningKey(store: SecretValueStore, env: string): Promise<string>;

// deploy-environment.ts
export type DeployAnswers = Omit<InstallAnswers, "release" | "callbackSigningKey">;
export async function deployEnvironment(input: {
  mode: "install" | "upgrade";
  engine: "templates" | "cdk";
  answers: DeployAnswers;
  release: LoadedRelease;
  deployer: StackDeployer;
  store: ParameterStore;            // settings + lock
  secrets: SecretValueStore;
  holder: string;                   // lock holder (caller ARN)
  parts?: DeployPart[];             // subset, in order; default: the whole order for the mode
  onEvent?: (event: DeployEvent) => void;
  now?: () => number;
}): Promise<{ outputs: Partial<Record<DeployPart, StackOutputs>>; settingsWritten: boolean }>;
```

Behaviour, exact:
1. Read the existing settings.
   - When they exist and `settings.engine !== engine`, throw "environment <env> was installed with
     the <x> engine; switching engines is not supported".
   - In `upgrade` mode, settings must exist, or throw "environment <env> is not installed; install
     it first".
   - In `install` mode with existing settings, refuse unless `parts` is given. Phase 15d resumes
     installs by parts: throw "environment <env> is already installed; use upgrade".
2. Run the rest inside `withEnvironmentLock` with command `deploy <mode>`.
3. Get the callback signing key once.
4. For each part in order (the mode's order filtered by `parts` when given):
   - Parts not being deployed that are earlier in the order supply outputs through
     `deployer.outputs(stackName)`.
   - Compute `stackParameters(part, { ...answers, release: release.manifest, callbackSigningKey }, outputs)`.
   - Call `deployer.deploy` with:
     - `roleArn`: `outputs.access.CloudFormationRoleArn` for every part except access;
     - `terminationProtection: PROTECTED_PARTS.has(part)`;
     - `stackName: environmentStackName(env, part)`.
   - Record the outputs.
5. When control-plane outputs are present and the identity is known, write the environment
   settings:
   - `engine`, `version: release.manifest.version`, `naming: "environment"`;
   - `stacks` for every deployed or existing part;
   - `controlPlaneUrl: ApiEndpoint`;
   - `identity` from the identity outputs (Cognito, with `clientId` = `ClientId`) or from the
     answers (OIDC; `clientId` is required in OIDC answers for the CLI login, so add
     `clientId?: string` to the OIDC answers and require it here);
   - `models`, and the `access` block from the access outputs plus the boundary.

   Return `settingsWritten: true`.

- [ ] **Step 1: Write the failing tests** (a fake `StackDeployer` that records requests and returns scripted outputs per part)

```ts
// tests/contract/deploy-environment.test.ts: tests to write fully
it("installs every part in install order, feeding outputs forward and using the service role after access", ...)
//  asserts request order access, foundation, identity, control-plane, runtime, slack; access has no roleArn; others roleArn = access CloudFormationRoleArn;
//  runtime parameters ControlPlaneUrl == control-plane ApiEndpoint; terminationProtection true for access/foundation/identity/runtime only
it("creates the callback signing key once and reuses it on later deploys", ...)
it("writes settings with the engine, version, stacks, identity and access block after an install", ...)
it("upgrades in upgrade order and reads outputs of parts it does not deploy", ...)
it("refuses a different engine than the environment was installed with, before deploying anything", ...)
it("refuses an upgrade of an environment that is not installed, and an install over an installed one", ...)
it("deploys only the requested parts, in order, reading earlier parts' outputs", ...)
it("holds the environment lock while deploying and releases it after a failure", ...)
it("never writes the callback signing key into settings", ...)
```

Write each test fully. Use `MemoryParameterStore`, a memory `SecretValueStore`, the fixtures from
`tests/support/environment-fixtures.ts`, and the release built in Task 2's style. Use a small fake
`LoadedRelease` to avoid a slow build: `manifest` with `version: "1.2.3"`, empty packages, and the
two image digests.

- [ ] **Step 2: Run them to verify they fail, implement, and run them to see them pass**

Run: `npx vitest run tests/contract/deploy-environment.test.ts tests/contract/deploy-parameters.test.ts`
Expected: first FAIL, then PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/deploy tests/contract/deploy-environment.test.ts
git commit -m "feat(cli): deploy orchestrator with engine lock-in, key handling and settings"
```

### Task 6: The export bundle

**Files:**
- Create: `packages/cli/src/deploy/export-bundle.ts`
- Test: `tests/contract/export-bundle.test.ts`

**Interfaces:**
- Consumes: `LoadedRelease` (Task 2); `stackParameters`, `installOrder` and `SECRET_PARAMETERS`
  (15c1); `serviceRoleStatements`, `operatorRoleStatements`, `defaultBoundaryStatements` (copy
  these pure functions' outputs through a tiny adapter; the CLI may import `@agentx/contracts` but
  not `infra/`, so move the three pure policy functions into
  `packages/contracts/src/access-policies.ts` and re-export them from `infra/lib/access-policies.ts`,
  keeping infra imports working).
- Produces: `writeExportBundle(input: { dir: string; answers: DeployAnswers & { clientId?: string }; release: LoadedRelease }): Promise<{ files: string[] }>`.

Bundle layout, exact, under `dir` (which must be empty or absent):
- `README.md`, which covers:
  - what the platform team deploys: the access stack;
  - its exact commands (from `deploy-access.sh`);
  - the IAM it creates;
  - that everything after it is deployed by the AgentX operator through the service role
    (`agentx init --resume`, phase 15d);
  - the full list of stacks and order.
- `deploy-access.sh`: bash with `set -euo pipefail`. It uses the AWS CLI only:
  1. `aws cloudformation create-change-set --stack-name agentx-<env>-access --change-set-type CREATE --template-body file://templates/access.template.json --parameters file://parameters/access.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM`;
  2. wait;
  3. describe (print changes);
  4. execute;
  5. wait;
  6. `update-termination-protection --enable-termination-protection`.

  It must pass `bash -n`.
- `templates/<part>.template.json`: every part's template rendered for the environment and region.
- `packages/<assetId>.zip`: copies, plus `packages/SHA256SUMS` in `sha256sum` format.
- `parameters/<part>.json`: `[{ "ParameterKey": ..., "ParameterValue": ... }]` for every part.
  - Values that depend on earlier stacks' outputs are written as `"{{output:<part>.<Name>}}"`.
  - `CallbackSigningKey` is written as `"{{secret:agentx/<env>/callback-signing-key}}"`.
  - GitHub App values, which are not known at export, are written as `"{{github:<field>}}"`.
  - Produce these by calling `stackParameters` with answers and outputs whose unknown values are
    exactly these markers, so the mapping is the same code path as a real install.
- `policies/service-role.json`, `policies/operator-role.json`, `policies/default-boundary.json`:
  policy documents with concrete account, region and partition `aws`.
- `policies/access-deployer.json`: what the platform team needs to deploy the access stack.
  - It allows CloudFormation on `stack/agentx-<env>-access/*` and `iam:*Role*`/`iam:*Policy*` on
    `role/agentx-<env>-*` and `policy/agentx/<env>/*`.
  - It also allows `iam:CreatePolicy` for the default boundary, `s3:CreateBucket*`/`s3:PutBucket*`
    on `agentx-<env>-access-*`, and `ecr:CreatePullThroughCacheRule`/`ecr:DeletePullThroughCacheRule`
    on `*`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/export-bundle.test.ts: tests to write fully
it("writes the documented layout for the environment and region", ...)
it("writes parameter files whose unknown values are markers, and never a secret value", ...)
//  assert CallbackSigningKey == "{{secret:agentx/staging/callback-signing-key}}"; runtime ControlPlaneUrl == "{{output:control-plane.ApiEndpoint}}";
//  grep every file in the bundle for any 40+ char base64url run matching a generated key pattern: none (there is no key to leak: assert no file contains "CallbackSigningKey\":\"" followed by a non-marker value)
it("writes a deploy-access.sh that passes bash -n and names only the access stack", ...)
it("writes policies with concrete account and region, and the access deployer policy scoped to the environment", ...)
it("refuses a non-empty directory and an uncovered region, writing nothing", ...)
it("makes no AWS calls at all", ...)   // writeExportBundle takes no clients; assert by type (no client parameter) and by running with no AWS env vars
```

- [ ] **Step 2: Run them to verify they fail, implement, and run them to see them pass**

Run: `npx vitest run tests/contract/export-bundle.test.ts tests/contract/access-policies.test.ts tests/contract/access-stack.test.ts`
Expected: first FAIL, then PASS. The access-policy tests keep passing after the move to contracts.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src packages/cli/src/deploy/export-bundle.ts infra/lib/access-policies.ts tests/contract/export-bundle.test.ts
git commit -m "feat(cli): export bundle for platform teams"
```

### Task 7: The `agentx deploy` and `agentx init --export` commands

**Files:**
- Create: `packages/cli/src/deploy/commands.ts`
- Modify: `packages/cli/src/main.ts` (the `deploy` and `init` commands; `CliDependencies.deploy` for injection)
- Test: `tests/contract/deploy-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6.
- Produces:
  - **`agentx deploy`** (description: "deploy or upgrade an environment from a release; used by
    init and upgrade, and for automation"). Flags:
    - `--mode install|upgrade` (required);
    - `--engine templates|cdk` (default `templates`);
    - `--release <dir>` (required);
    - `--answers <file.json>` (required; validated with a Zod `DeployAnswersSchema` that mirrors
      `DeployAnswers`, strict, including optional `images`);
    - `--parts <comma list>`;
    - `--source <dir>` (required for cdk);
    - `--yes` (otherwise it prints each change set's changes and asks for confirmation before
      executing).

    It prints the progress events as plain lines. It never prints parameter values.
  - **`agentx init --export <dir>`.** Flags:
    - `--region`, `--account` (default: sts GetCallerIdentity, read-only), `--release <dir>`;
    - `--identity cognito|oidc`, plus `--oidc-issuer`, `--oidc-audience`, `--oidc-client-id`,
      `--admin-claim`, `--admin-values <comma list>` for OIDC;
    - `--permission-boundary <arn>`, `--operator-principal <arn>`;
    - `--orchestrator-model`, `--classifier-model`, `--worker-model`, defaulting to
      `us.anthropic.claude-sonnet-4-6`, `amazon.nova-lite-v1:0` and `amazon.nova-pro-v1:0`.

    It writes the bundle and prints its path and the next step.
  - `agentx init` with no `--export` prints "interactive install arrives in a later AgentX release;
    use agentx init --export or agentx deploy" and exits 2.

- [ ] **Step 1: Write the failing tests** (executeCli with injected fakes; no AWS)

```ts
// tests/contract/deploy-cli.test.ts: tests to write fully
it("init --export writes a bundle and makes no AWS write call", ...)
it("init without --export explains how to proceed and exits non-zero", ...)
it("deploy refuses answers that do not match the schema, naming the field", ...)
it("deploy --engine cdk requires --source", ...)
it("deploy prints progress and never a parameter value", ...)   // inject a fake deployer; answers include a recognisable secret-bearing field? (the key is generated by the fake secret store: assert its value is not in stdout/stderr)
it("deploy without --yes asks before executing each change set and stops when refused", ...)
```

- [ ] **Step 2: Run them to verify they fail, implement, and run them to see them pass**

Run: `npx vitest run tests/contract/deploy-cli.test.ts tests/contract/cli-main.test.ts`
Expected: first FAIL, then PASS. Update the root-command list assertion in `cli-main.test.ts`
deliberately, to add `deploy` and `init`.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src tests/contract/deploy-cli.test.ts tests/contract/cli-main.test.ts
git commit -m "feat(cli): agentx deploy and agentx init --export"
```

### Task 8: Documentation

**Files:**
- Modify: `docs/architecture-production.md` (a "Deploying an environment" section; `git add -f`)
- Modify: `specs/015-installer/spec.md` (Decisions: per-region templates; the cdk engine's argument secret handling)

- [ ] **Step 1: Write the docs (the section under 50 lines, in plain words)**

Cover:
- the two engines and when to pick each;
- what a deploy does, stack by stack;
- how to read the change summary;
- what "no changes" means;
- how to recover from `ROLLBACK_COMPLETE` and `REVIEW_IN_PROGRESS`;
- the supported regions and how a region is added;
- the export bundle and who runs what;
- the cdk engine's secret-in-arguments note.

- [ ] **Step 2: Full gate and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass, and the legacy snapshots are unchanged.

```bash
git add -f docs/architecture-production.md
git add specs/015-installer/spec.md
git commit -m "docs: deploying an environment, engines, regions, export"
```

### Task 9: First live install of a throwaway environment (owner present)

This task changes no code unless it finds a defect, which then goes through TDD and review. It
needs the owner's explicit go-ahead and an admin AWS session: the access stack creates IAM roles.
It uses a new environment name and never touches production stacks.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release: `npm run release:build -- --version 0.0.1-live --out <scratch>/rel`. It has
    no image digests, so the check uses image overrides.
  - Read the production stacks (read-only) to get:
    - the current worker image digest (runtime `WorkerImageUri` parameter);
    - the Slack image digest (Slack `OrchestratorImageUri` parameter);
    - the GitHub App values (control-plane `GitHubAppAccount`, `GitHubAppId`,
      `GitHubAppInstallationId`, `GitHubAppPrivateKeySecretArn`).
  - Write `<scratch>/answers.json` for environment `live15c` in us-east-1:
    - Cognito identity;
    - the production models;
    - `images` set to the two private digests;
    - the GitHub values.

- [ ] **Step 2: Owner approval and an admin session**

Ask the owner to approve the deploy. Tell them:
- the stacks it creates;
- the approximate cost of the two NAT gateways and the capacity provider while it exists;
- that it will be deleted afterwards.

Then ask for an admin session: either CloudShell with the repository, or `aws login` to an admin
profile for this session only.

- [ ] **Step 3: Install five stacks**

Run: `agentx deploy --mode install --engine templates --release <scratch>/rel --answers <scratch>/answers.json --parts access,foundation,identity,control-plane,runtime --yes`, under the admin session. Admin rights are needed for the access stack; the remaining stacks go through the service role.

Expected: all five stacks reach `CREATE_COMPLETE`, which proves the following:
- the default boundary allows everything the roles need;
- the service role's permissions are complete;
- AgentCore accepts the pathed runtime role and the pathed capacity-provider operator role;
- the worker image is pulled.

Record every failure. A failure caused by a defect becomes a fix with a failing test first.

- [ ] **Step 4: Verify**
  - The runtime is READY (`bedrock-agentcore-control get-agent-runtime`).
  - The control-plane endpoint answers 401 without a token.
  - The operator role can DescribeStacks for `agentx-live15c-*` and cannot CreateChangeSet on
    `agentx-live15c-access`. Check with `aws sts assume-role` into the operator role from the
    admin session, then a denied call.
  - `/agentx/live15c/settings` is written, with engine `templates`.

- [ ] **Step 5: Tear down**

Give the owner the exact commands:
1. Disable termination protection, then delete the stacks in reverse order: runtime,
   control-plane, identity, foundation, access.
2. Remove what is retained:
   - the Cognito user pool: disable deletion protection, then delete;
   - the artifact bucket: empty it, then delete;
   - `agentx/live15c/callback-signing-key`: force-delete;
   - the default boundary policy, if left behind.
3. Confirm the stacks no longer exist.

- [ ] **Step 6: Record the evidence**

Record the commands, the outcomes, timings, and any defects fixed, in the ledger and the PR
description.

## Not in this phase

- The interactive `agentx init` wizard: GitHub App and Slack app creation, the admin user, the
  first project, connectors and alerts. That is phase 15d.
- `agentx upgrade`, `config` and `doctor` as user commands. That is phase 15e, and it builds on
  `deployEnvironment({ mode: "upgrade" })`.
- Deploying the Slack stack in the live check, which needs a real Slack app from phase 15d.
