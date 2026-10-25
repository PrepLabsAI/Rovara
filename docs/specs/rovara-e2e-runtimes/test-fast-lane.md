# TEST fast lane: standing access packet and runbook (M1.0)

Status: **APPROVED by the owner on 2026-10-18**, amended on 2026-10-19 for Task 1.6b (see the approval record in section 6). Owner message: "Approve the standing TEST access packet (part of M1.0) once - approved".

This is a Tier 3 proposal in the form `AGENTS.md` (Material change control) asks for. The owner approves it once. After that, M1 asks for no per-run grants: every TEST deploy goes through `scripts/test-deploy.ts` or CDK, and anything outside this packet stops and comes back as a new proposal.

Scope: the single TEST installation `agentxlivetest123`, nothing else. `scripts/test-deploy.allowlist.json` lists it, and the script refuses any other environment with "test-deploy only targets allowlisted TEST installations".

## 1. What is approved

| # | Item | Current value | Proposed value (approved) |
|---|---|---|---|
| a | Qualification transport for the EC2 runtime runner | No standing grant. Each qualification needs temporary S3 grants. | The control-plane stack of `agentxlivetest123` carries one IAM policy, `E2eQualificationTransport`, on the worker instance role, scoped per instance (see "a. Exact grant"). Deployed from Task 0.1's CDK context `agentx:e2eQualificationTransport=enabled` (the exact string `enabled`; `true` and `"true"` stay off) through the `qualification-transport` unit of `scripts/test-deploy.ts`. |
| b | Owner membership on the fixture project | None: the project does not exist in TEST. | A lasting developer membership for the owner on project `rovara-web-fixture`, backed by the private repository `abhishek255/rovara-orders-web-fixture` (created by the owner, empty today; seeded by Task 0.3). |
| c | Workspaces per member in TEST | `limits.workspacesPerMember` = 3 (the product default). | `limits.workspacesPerMember` = 5, TEST only. |
| d | Deploy path | Hand-built, per-run reviewed change sets (the P0 procedure). | `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --apply` is the standing TEST deploy path. |

### a. Exact grant

- Principal: the worker instance role of `agentxlivetest123` (`sessions.instanceRoleName`). The policy is attached from the control-plane stack because the artifact bucket lives there and the foundation stack stays untouched.
- Actions and resources, nothing else (no List, no Delete, no bucket-level access). `${aws:userid}` is the IAM policy variable that, for a session of an EC2 instance role, is `<the role's unique ID, AROA...>:<instance ID>`, so each instance of the shared worker role reaches only the keys under its own ID (the synthesized template keeps it as literal text; `tests/contract/ec2-worker-infrastructure.test.ts` pins it):
  - `s3:GetObject` on `<artifact bucket>/e2e-runtime/${aws:userid}/challenge.json`.
  - `s3:PutObject` on exactly `<artifact bucket>/e2e-runtime/${aws:userid}/proposal.json`, `<artifact bucket>/e2e-runtime/${aws:userid}/ready.json` and `<artifact bucket>/e2e-runtime/${aws:userid}/status.json`.
  - The 2026-10-18 approval named `e2e-runtime/*/challenge.json`, `.../proposal.json` and `.../status.json`. Two things changed on 2026-10-19: `ready.json` was added (the worker's "healthy" marker, so boot time does not use the challenge's lifetime; widening, approved), and the `*` was replaced by `${aws:userid}` (narrowing: before, any instance of the role could read or plant another run's files; now only its own prefix). There are no other keys.
  - Instance side: the hook builds `e2e-runtime/<role unique ID>:<its instance ID>/` from the role ID the script passes (user-data variable `AGENTX_E2E_QUALIFICATION_ROLE_ID`) and the instance ID boot read from the instance metadata service (IMDSv2); the script builds the same prefix from the RunInstances response. Both validate the IDs against `^AROA[A-Z0-9]{12,}$` and `^i-[0-9a-f]{8,17}$`.
- Duration: standing, until revoked.
- Reason: the TEST runner publishes its qualification proposal and status and reads its challenge without a temporary grant for each run.
- Rollback: deploy the control-plane stack without the context flag through the normal CDK engine; CloudFormation then removes the policy. `test-deploy.ts` never removes anything: its guard refuses any change set that is not a pure add.
- How it is deployed: `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only qualification-transport --apply`. The unit takes the deployed control-plane template, adds only the `E2eQualificationTransport*` resources a CDK synth with the flag produces, and creates a change set. It executes only if every change is an `Add` of a resource whose logical ID starts with `E2eQualificationTransport`. Otherwise it deletes the change set and lists the unexpected changes.

### b. Fixture membership

- Principal: the owner (the developer account that signs in to TEST).
- Resource: project `rovara-web-fixture` only. It is registered in Task 0.3 with the normal `agentx --env agentxlivetest123 project add` flow, then the owner is granted developer access through the normal admin tool (`agentx_admin_grant_project_access`).
- Duration: lasting, until the owner revokes it with the matching admin tool.
- Reason: M1 live demos need a project the owner can use without a new grant each time.
- Rollback: revoke the grant; remove the project if the fixture is retired.

### c. Workspaces per member

`agentx --env agentxlivetest123 config set limits.workspacesPerMember 5 --region us-east-1`. Reason: the M1 demos open several workspaces for one person. Rollback: set it back to 3.

### d. Standing deploy path and the qualification run

Principal: the `agentx-test` AWS profile (`aws login --profile agentx-test`), account and region of `agentxlivetest123`. The two scripts use only this profile's credentials. Between them they perform exactly the following, and nothing else.

`scripts/test-deploy.ts` (approved 2026-10-18):

- Read: `cloudformation:DescribeStacks`, `GetTemplate`, `DescribeStackResource`, `DescribeStackResources`, `DescribeChangeSet`; `lambda:GetFunctionConfiguration`; `ecr:DescribeRepositories`, `ecr:DescribeImages`; `s3:HeadObject` (`s3:GetObject`); `s3:GetBucketVersioning` on the access stack's artifact bucket (the script refuses to upload unless versioning is `Enabled`). `DescribeStacks` also covers the `agentx-agentxlivetest123-access` stack, which is only read, for its `ArtifactBucketName` output.
- Write, only on the two stacks `agentx-agentxlivetest123-control-plane` and `agentx-agentxlivetest123-runtime`: `cloudformation:CreateChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet`.
- Write, immutable and checksummed, only under `test-deploy/` in the access stack's existing versioned artifact bucket (named by the `agentx-agentxlivetest123-access` stack output `ArtifactBucketName`; the bucket the deployed Lambda code already lives in): `s3:PutObject` with `If-None-Match: *`. These are the code-artifact keys and the change-set template keys. Before any upload the script checks that the bucket's versioning is `Enabled` and, for code, that the deployed Broker's `Code.S3Bucket` is that same bucket; it refuses otherwise. It never writes to the control-plane stack's own artifact bucket, which is not versioned.
- Write, only to the ECR repositories the runtime stack's current `WorkerImageUri` already points to and the executor repository beside it: `ecr:GetAuthorizationToken` and an image push by a `test-` tag (`ecr:BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`). The repositories are named as the script derives them: the worker's from `WorkerImageUri`, the executor's by replacing the last `worker` in the worker repository's name with `executor` (`executorRepositoryUri` in `scripts/test-deploy.ts`; `.../agentx-test/worker` gives `.../agentx-test/executor`). The script never creates a repository or changes ECR policy; it does not call `ensureRepository`.
- What CloudFormation applies with those change sets, under the operator's credentials: `iam:PutRolePolicy` (the `E2eQualificationTransport` policy on the worker instance role), `lambda:UpdateFunctionCode` (Broker and Dispatcher), `ssm:PutParameter` (the worker-image and `worker-executor-image` settings the runtime stack owns).

`scripts/test-qualify-runtime.ts` (covered by the 2026-10-19 approvals in section 6; every call is after the script's plan-first output and `--apply`):

- Rovara: `agentx admin workspace list`, `admin runtime-installation challenge` and `register`, run with the owner's admin sign-in. They go to the Rovara control plane; they are not new AWS permissions.
- Read: `cloudformation:DescribeStacks` and `DescribeStackResources` (control-plane and foundation); `ssm:GetParameters` on the environment's worker settings; `kms:GetPublicKey` on the invoke signing key; `ec2:DescribeLaunchTemplateVersions`, `DescribeInstances`, `DescribeVolumes`; `iam:GetRole` on the worker instance role (to read its unique ID, `RoleId`, which scopes the grant above).
- EC2, one instance and one volume: `ec2:CreateVolume` (one encrypted 20 GiB gp3 volume, client token = the run's UUID), `ec2:RunInstances` (exactly one `m6g.large` from the environment's launch template, `MinCount=MaxCount=1`, client token = the run's UUID, tagged `DeploymentMode=e2e-qualification` so the session reconciler does not end it), `ec2:CreateTags` (the tags in that request), `ec2:AttachVolume`. RunInstances with the template's instance profile also needs `iam:PassRole` on the worker instance-profile role only.
- S3, in the control-plane stack's artifact bucket (the control-plane stack output `ArtifactBucketName`, not the access stack's) and only under `e2e-runtime/`: `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `e2e-runtime/<run UUID>/preflight.json` (the preflight: put, read back, delete, before anything is launched); `s3:PutObject` and `s3:DeleteObject` on `e2e-runtime/<role unique ID>:<instance ID>/challenge.json`; `s3:GetObject` on that prefix's `ready.json`, `status.json` and `proposal.json`. The script deletes nothing else. The worker instance, not the operator, writes `ready.json`, `status.json` and `proposal.json`.
- Never: `ec2:TerminateInstances`, `ec2:DeleteVolume` or any other delete of what it created. On failure it prints those commands for the owner to run.

If the `agentx-test` principal lacks any of these, the script fails and stops; the qualification script's preflight names the missing S3 permission before it launches anything. It never widens IAM, trust, bucket policy, ECR policy or secrets to make a call work; that comes back as a new proposal.

#### The executor ECR repository is an operator step

`test-deploy.ts --only executor-image` stops when the executor repository does not exist. The owner approved creating one on 2026-10-19. The operator creates it, with the worker repository's settings (image scanning on, immutable tags), named as the script derives it (the worker repository's name with `worker` replaced by `executor`). With the TEST worker repository `<worker repo>` (read it from the runtime stack's `WorkerImageUri` parameter) it is:

```sh
aws ecr create-repository --repository-name <worker repo with the last "worker" replaced by "executor"> \
  --image-scanning-configuration scanOnPush=true --image-tag-mutability IMMUTABLE \
  --region us-east-1 --profile agentx-test
```

For example, `agentx-test/worker` becomes `aws ecr create-repository --repository-name agentx-test/executor ...`. Check the result against `aws ecr describe-repositories --repository-names <worker repo>` and copy any other setting (encryption, lifecycle policy) it has.

#### The local Docker VM must let Chromium's sandbox start (operator step)

Before pushing the executor image, `test-deploy.ts --only executor-image` smoke-tests it locally (`smokeTestExecutor` in `scripts/release-common.ts`, built from `scripts/executor-smoke.ts`, the same definition the CI `linux-runtime` job runs): the image runs with the executor container's own sandbox and limit flags (`executorContainerArgs` in the verifier, the source the Docker host builds its executor command from): the pinned seccomp profile `packages/verifier/assets/executor-seccomp.json` (checked against its digest in contracts), every capability dropped, no-new-privileges, a read-only root, a `/tmp` tmpfs, 2 GiB, 1024 processes and 2 CPUs (the VM needs at least 2), plus no network. The script uses the verifier's built output, so run `npm run build` first. Chromium's own sandbox is on and is never skipped: if it cannot start, the smoke test fails and the push is refused.

A Docker VM on Ubuntu 24.04 (colima's default VM) restricts unprivileged user namespaces for AppArmor-confined containers, which stops the sandbox. The smoke test then says "Chromium's sandbox could not start in this Docker VM". Lift the restriction in the VM and retry:

```sh
colima ssh -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # temporary: resets when the VM restarts
```

On another Linux Docker host run the same `sysctl` there, and check that `user.max_user_namespaces` is above 0. Production runners (Amazon Linux 2023) need no such change. The fix is the VM's setting, never `--no-sandbox` and never a weaker profile.

## 2. Evidence for and against

For:
- It reproduces the P0 TEST procedure (`pr400-test-deployment-runtime-plan-2026-10-16.md`, evidence directory of the P0 run), which the owner already authorized per deployment: a Broker-only or Dispatcher-only change set that changes only `Properties.Code`, an image change set that changes only `WorkerImageUri`, every other parameter `UsePreviousValue`, and Lambda `CodeSha256` verification.
- The plan is pure and unit-tested (`tests/unit/test-deploy-plan.test.ts`), and every change set is checked against an exact expectation before it executes.
- The qualification grant is the exact-key policy reviewed in Task 0.1 (now scoped per instance with `${aws:userid}`), off by default.

Against:
- A standing grant is wider in time than a per-run grant. It is limited to four exact object names under an instance's own ID in one bucket, in one TEST installation. A worker running other code can still write its own prefix; it cannot read or plant another instance's.
- A script that executes change sets is a standing mutation path. The allowlist, the exact-change guard and the clean-tree requirement bound it, and it is TEST only.

## 3. Why the current position is insufficient, and cost

Per-run grants made every M1 live demo wait for a human review of the same change. Keeping them costs one owner review per demo. Changing costs this one approval and the standing exposure described above.

## 4. Downstream work affected

- Task 0.1: the policy this packet approves.
- Task 0.3: registers `rovara-web-fixture`, then the membership in item b follows.
- Task 1.6 (and every later M1 task): deploys through this path. The `executor-image` unit pushes the executor image to the repository beside the worker's and changes only `ExecutorImageUri` (the first run also adds that parameter and its SSM setting to the runtime stack). It never creates the repository: a missing one stops the run and comes back as a Tier 3 item.

## 5. Runbook

Each run, from a clean checkout of the commit to deploy (the script refuses a dirty tree, so the deployed bytes match the recorded revision):

```sh
aws login --profile agentx-test
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test            # prints the plan, changes nothing
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --apply    # runs it
# one unit: --only control-plane-code | broker | dispatcher | worker-image | executor-image | qualification-transport  (comma separated)
```

- Default units: `control-plane-code,worker-image`. `executor-image` is opt-in (it needs the executor repository). `qualification-transport` runs on its own, apart from every code unit.
- `--check` (read-only, Task 3.0; all reads: `get-template`, `list-stack-resources`, `get-function`, `describe-stacks`, a DynamoDB `query` of the feature-verifier catalog, `ec2 describe-instances`, `iam get-role` and an S3 `get-object` of the runner's `status.json`) reports `stale-lambda`, `iam-missing-grant`, `iam-extra-grant`, `lambda-env-missing`, `catalog-not-ready`, `catalog-expiring`, `runner-image-mismatch` and `worker-feature-missing`. Exit 0 means nothing is wrong, 1 means findings, 2 means the check could not run; `--json` ends stdout with the report as one JSON line.
  - Before a demo, `--check` must exit 0.
  - Before a deploy it is expected to report `stale-lambda`: that is the reason to deploy. Stale means the running code is not a test-deploy artifact whose S3Key proves its hash (unknown provenance), or its inputs changed since the commit it was built from.
  - The real pre-deploy gate is built into `--apply` of Lambda code, before anything is pushed or changed. It refuses on an `iam-missing-grant` for a role of a Lambda being deployed (and prints the statements for a Tier 3 request) and on a `lambda-env-missing` for one (a code-only change set cannot add `Environment`; it needs a stack update). `--apply` never applies IAM or stack changes. Catalog and runner findings are for `--check`, not `--apply`.
- `control-plane-code` rebuilds every packaged control-plane Lambda in one change set, so a normal TEST deploy cannot leave one on old code (the notifier still on Oct 14 code could not parse the v2 plan document, and its card gave the owner no way to the plan). The set is `CONTROL_PLANE_LAMBDAS` in `scripts/test-deploy.ts`: Broker, Dispatcher, PlanEvidence, OutboxPublisher, SlackIngress, EvalBatchTick, DeveloperSignInFunction, DeveloperTaskNotifierFunction, SessionsSteps, SessionsReaper and SessionsReconciler. Each zip is the release bundle's own shape (the esbuild handler and its source map; SessionsSteps also holds `boot.sh`), uploaded to the access stack's versioned bucket. A unit test keeps the set equal to the `packagedFunction(...)` entries in `infra/lib` (the installer's setup page is in another stack and is not part of it). `broker` and `dispatcher` remain as narrower units and are contained in `control-plane-code`.
- One change set holds every code change. It executes only if the changes are exactly a `Modify` of each code unit that changes `Properties.Code` alone (Static, DirectModification, no replacement), plus Modify entries whose every detail is a Dynamic ResourceAttribute re-evaluation caused by one of those functions' `<fn>.Arn` (CloudFormation's conservative no-ops, as before). A code unit may carry such a re-evaluation detail itself only when another code unit of the run, itself changed only in Code, causes it: the Broker's `DEVELOPER_IDENTITY_FUNCTION_ARN` reads `DeveloperSignInFunction10B62B05.Arn`, the only Lambda-to-Lambda `Arn` reference among the code units. Anything else, or a missing code unit, deletes the change set. A function the release pipeline deployed names its code bucket through a stack parameter; the guard accepts that only when the parameter's current value is the access stack's bucket, and the change set then writes the literal location (as it already did for Broker and Dispatcher).
- Not in the unit: the Slack service (an ECS image built from `environments/slack`; it routes Slack requests and does not parse plan documents, and test-deploy never changes it) and the TaskPersonProof Lambda (a conditional resource of its own, with a published version).
- The dry run reads the stacks' current parameters (read-only) so it can show the exact parameter set; run it first and read it.
- Order inside one run: the worker image is pushed and its runtime change set executes first, then the control-plane change set, as the release pipeline does.
- Each step is checked: the zip is hashed and uploaded to a checksummed object version; the change set must hold only the expected changes; the stack must end in `UPDATE_COMPLETE`; every code unit's Lambda `CodeSha256` must equal its zip's sha256 (base64); `WorkerImageUri` must equal the pushed digest.
- Before executing, confirm there is no running worker with active work. A new image affects newly launched workers only; a running worker keeps its old runtime and its qualification.

Stop and bring a Tier 3 proposal when a run needs a new role, grant, repository, bucket or policy, secret access, data scope, runtime privilege, or a change to protected authority. Never edit state directly or fabricate a pass.

Rollback of a code or image deploy: check out the previous known-good commit and run the same command; it deploys that code and image the same way. For a failed stack update, CloudFormation rolls back by itself; keep the evidence and do not retry blindly.

## 6. Approval record

| Date | Approver | Decision |
|---|---|---|
| 2026-10-18 | Owner | Approved items a, b, c and d as written above. |
| 2026-10-19 | Owner | Approved for Task 1.6b: (1) launch one `m6g.large` instance and one 20 GiB gp3 volume in TEST as the qualification runner, kept as the qualified runner afterwards; (2) create one executor ECR repository in TEST beside the worker repository (the operator step above); (3) widen the standing grant with `s3:PutObject` on `e2e-runtime/.../ready.json` (item a above); (4) run `aws login --profile agentx-test`. Per-instance scoping of the grant with `${aws:userid}` (item a) narrows the approved grant and was added after review; the actions listed in item d for the qualification run are the actions of those four approvals. |
