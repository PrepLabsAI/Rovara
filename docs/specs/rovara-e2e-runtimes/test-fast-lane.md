# TEST fast lane: standing access packet and runbook (M1.0)

Status: **APPROVED by the owner on 2026-10-18.** Owner message: "Approve the standing TEST access packet (part of M1.0) once - approved".

This is a Tier 3 proposal in the form `AGENTS.md` (Material change control) asks for. The owner approves it once. After that, M1 asks for no per-run grants: every TEST deploy goes through `scripts/test-deploy.ts` or CDK, and anything outside this packet stops and comes back as a new proposal.

Scope: the single TEST installation `agentxlivetest123`, nothing else. `scripts/test-deploy.allowlist.json` lists it, and the script refuses any other environment with "test-deploy only targets allowlisted TEST installations".

## 1. What is approved

| # | Item | Current value | Proposed value (approved) |
|---|---|---|---|
| a | Qualification transport for the EC2 runtime runner | No standing grant. Each qualification needs temporary S3 grants. | The control-plane stack of `agentxlivetest123` carries one IAM policy, `E2eQualificationTransport`, on the worker instance role. Deployed from Task 0.1's CDK context `agentx:e2eQualificationTransport=enabled` (the exact string `enabled`; `true` and `"true"` stay off) through the `qualification-transport` unit of `scripts/test-deploy.ts`. |
| b | Owner membership on the fixture project | None: the project does not exist in TEST. | A lasting developer membership for the owner on project `rovara-web-fixture`, backed by the private repository `abhishek255/rovara-orders-web-fixture` (created by the owner, empty today; seeded by Task 0.3). |
| c | Workspaces per member in TEST | `limits.workspacesPerMember` = 3 (the product default). | `limits.workspacesPerMember` = 5, TEST only. |
| d | Deploy path | Hand-built, per-run reviewed change sets (the P0 procedure). | `npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --apply` is the standing TEST deploy path. |

### a. Exact grant

- Principal: the worker instance role of `agentxlivetest123` (`sessions.instanceRoleName`). The policy is attached from the control-plane stack because the artifact bucket lives there and the foundation stack stays untouched.
- Actions and resources, nothing else (no List, no Delete, no bucket-level access):
  - `s3:GetObject` on `<artifact bucket>/e2e-runtime/*/challenge.json`.
  - `s3:PutObject` on `<artifact bucket>/e2e-runtime/*/proposal.json` and `<artifact bucket>/e2e-runtime/*/status.json`.
  - The `*` stands for the installation ID (Task 1.6 uses `e2e-runtime/<installationId>/`). IAM wildcards also match `/`, so a deeper path that ends in one of those three file names matches too.
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

### d. Standing deploy path

Principal: the `agentx-test` AWS profile (`aws login --profile agentx-test`), account and region of `agentxlivetest123`. The script uses only this profile's credentials. It performs only:

- Read: `cloudformation:DescribeStacks`, `GetTemplate`, `DescribeStackResource`, `DescribeChangeSet`; `lambda:GetFunctionConfiguration`; `ecr:DescribeImages`; `s3:HeadObject`.
- Write, only on the two stacks `agentx-agentxlivetest123-control-plane` and `agentx-agentxlivetest123-runtime`: `cloudformation:CreateChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet`.
- Write, immutable and checksummed, only under `test-deploy/` in the control-plane stack's existing versioned artifact bucket (named by the stack output `ArtifactBucketName`): `s3:PutObject` with `If-None-Match: *`.
- Write, only to the ECR repository the runtime stack's current `WorkerImageUri` already points to: an image push by a `test-` tag. The script never creates a repository or changes ECR policy; it does not call `ensureRepository`.

If the `agentx-test` principal lacks any of these, the script fails and stops. It never widens IAM, trust, bucket policy, ECR policy or secrets to make a call work; that comes back as a new proposal.

## 2. Evidence for and against

For:
- It reproduces the P0 TEST procedure (`pr400-test-deployment-runtime-plan-2026-10-16.md`, evidence directory of the P0 run), which the owner already authorized per deployment: a Broker-only or Dispatcher-only change set that changes only `Properties.Code`, an image change set that changes only `WorkerImageUri`, every other parameter `UsePreviousValue`, and Lambda `CodeSha256` verification.
- The plan is pure and unit-tested (`tests/unit/test-deploy-plan.test.ts`), and every change set is checked against an exact expectation before it executes.
- The qualification grant is the exact-key policy reviewed in Task 0.1, off by default.

Against:
- A standing grant is wider in time than a per-run grant. It is limited to three exact object names in one bucket, in one TEST installation.
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
# one unit: --only broker | dispatcher | worker-image | executor-image | qualification-transport  (comma separated)
```

- Default units: `broker,dispatcher,worker-image`. `executor-image` is opt-in (it needs the executor repository). `qualification-transport` runs on its own.
- The dry run reads the stacks' current parameters (read-only) so it can show the exact parameter set; run it first and read it.
- Order inside one run: the worker image is pushed and its runtime change set executes first, then the control-plane change set, as the release pipeline does.
- Each step is checked: the zip is hashed and uploaded to a checksummed object version; the change set must hold only the expected changes; the stack must end in `UPDATE_COMPLETE`; Lambda `CodeSha256` must equal the zip's sha256 (base64); `WorkerImageUri` must equal the pushed digest.
- Before executing, confirm there is no running worker with active work. A new image affects newly launched workers only; a running worker keeps its old runtime and its qualification.

Stop and bring a Tier 3 proposal when a run needs a new role, grant, repository, bucket or policy, secret access, data scope, runtime privilege, or a change to protected authority. Never edit state directly or fabricate a pass.

Rollback of a code or image deploy: check out the previous known-good commit and run the same command; it deploys that code and image the same way. For a failed stack update, CloudFormation rolls back by itself; keep the evidence and do not retry blindly.

## 6. Approval record

| Date | Approver | Decision |
|---|---|---|
| 2026-10-18 | Owner | Approved items a, b, c and d as written above. |
