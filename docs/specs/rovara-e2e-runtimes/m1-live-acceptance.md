# M1 live acceptance

What the owner and the controller run in TEST to accept each M1 sub-milestone, and how the evidence is recorded in `status.md`. Every command here targets the one allowlisted TEST installation (`agentxlivetest123`, `scripts/test-deploy.allowlist.json`) and never production.

## M1.1: the TEST runner qualifies `linux-arm64-web-api-v1`

M1.1 is accepted when the TEST worker has run the six web/API probes with the expected outcomes and both catalog rows are registered. Two commands do it, each plan-first.

### Preconditions

- The commit to deploy is committed on the branch (both scripts refuse a dirty tree, so the bytes that run are the bytes recorded) and `npm run build` has been run.
- The owner has signed in to AWS: `aws login --profile agentx-test`.
- The owner has signed in to Rovara TEST as an administrator: `agentx --env agentxlivetest123 login --admin`. `test-qualify-runtime` checks this before it creates anything, with a read-only `admin workspace list`.
- The ECR repository for the executor image exists beside the worker's (the worker's repository name with `worker` replaced by `executor`, for example `.../worker` becomes `.../executor`). `test-deploy` never creates a repository: a missing one stops the run. The owner approved creating one on 2026-10-19; the operator creates it with the `aws ecr create-repository` command in `test-fast-lane.md` (image scanning on).
- The standing qualification transport (Task 0.1) is deployed. The first deploy below does it.

### 0. Check TEST before a deploy or a demo

```sh
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --check
```

Read-only. Exit 0: nothing is wrong. Exit 1: findings. Exit 2: the check could not run. `--json` ends stdout with the report as one JSON line. It needs a clean working tree. Run it before a demo (it must exit 0). Before a deploy it is expected to report `stale-lambda`, which is the reason to deploy; the real pre-deploy gate is the IAM and environment check that `--apply` of Lambda code runs first. Findings:

- `stale-lambda`: a control-plane Lambda that is not on head's code (every one, not only the units being deployed). Provenance first: the deployed `S3Key` must be a test-deploy artifact (`test-deploy/<revision>/<logicalId>-<sha256>.zip`) whose hash is the running `CodeSha256`, otherwise it is stale with unknown provenance. Then currency: current if head's zip is the same, or the artifact was built from head, or `git diff <revision> HEAD` touches nothing the bundle is built from (esbuild inputs, extra files, `package-lock.json`).
- `iam-missing-grant` (error) and `iam-extra-grant` (warning): an IAM grant the head template has and the deployed role lacks, or the reverse, compared per role after ignoring statement order and the asset-parameter and version hashes. An error prints the exact statements for a Tier 3 request.
- `lambda-env-missing`: an environment variable head's function sets that the deployed function lacks. A code-only change set cannot add it; it needs a control-plane stack update.
- `--apply` of Lambda code refuses on an `iam-missing-grant` or `lambda-env-missing` for a Lambda it deploys. The script never applies IAM or stack changes.
- `catalog-not-ready` and `catalog-expiring`: a `#web` or `#api` catalog row that is missing, not `READY`, or expires within 24 hours. Rows are read from the state table (`dynamodb:Query`), because the admin API has no catalog read route.
- `runner-image-mismatch` and `worker-feature-missing`: the qualified runner's `status.json` (found by the web row's private IP, no SSH) names an executor image other than the deployed `ExecutorImageUri`, or the worker's `/ping` lacks a feature string this build needs. A runner qualified before the hook recorded these facts reports both as unknown: qualify it again. The facts are a snapshot from qualification time.

### 1. Deploy the build

```sh
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only qualification-transport            # plan only
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only qualification-transport --apply    # once
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only broker,dispatcher,worker-image,executor-image            # plan only; read it
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only broker,dispatcher,worker-image,executor-image --apply
```

`qualification-transport` runs on its own, and only the first time. Expected output of the second run:

- The runtime stack `agentx-agentxlivetest123-runtime` ends `UPDATE_COMPLETE` twice: once for `WorkerImageUri`, and once for `ExecutorImageUri`. The first executor run is an add-only change set (the `ExecutorImageUri` parameter and its `WorkerExecutorImageParameter` SSM setting); later runs modify only the parameter's value. Each change set's own execution status reaches `EXECUTE_COMPLETE`; a stale stack status is never taken for success.
- The control-plane stack `agentx-agentxlivetest123-control-plane` ends `UPDATE_COMPLETE` with the Broker and Dispatcher code replaced.
- The script prints each Lambda's `CodeSha256` equal to the uploaded zip's sha256 (base64), `WorkerImageUri` equal to the pushed worker digest, and `ExecutorImageUri` equal to the pushed executor digest.
- For the transport run: `E2eQualificationTransport` is read back with `DescribeStackResource` as `CREATE_COMPLETE`.

Running workers keep their old image: only workers booted afterwards use the new one. The session-steps Lambda that renders a normal workspace's boot reads the new `worker-executor-image` setting only once the control-plane stack itself is deployed with this build (a full CDK deploy); the qualification script below reads the setting directly, so it does not wait for that.

### 2. Qualify and register

```sh
npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test            # plan only
npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test --apply
```

**Spend: this launches one m6g.large instance and one 20 GiB gp3 volume. It needs the owner's explicit OK at run time, every time; the standing fast-lane approval does not cover it.**

What `--apply` does, in order: checks the admin sign-in; reads the live stacks, settings, signing key, launch template and the worker role's unique ID (`iam get-role`; refusing unless the executor image and the qualification transport are deployed and the template is the reviewed shape); runs the transport preflight (puts `e2e-runtime/<run UUID>/preflight.json`, reads it back and deletes it; if any of the three fails it refuses to launch and names the permission, so an AccessDenied is never a silent 20-minute wait); creates one volume; launches exactly one instance from the environment's launch template (client token = the run's UUID, `MinCount=MaxCount=1`, tagged `DeploymentMode=e2e-qualification` so the session reconciler, which ends any unowned `ec2-ebs` instance of the environment after 15 minutes, leaves it alone) with the worker's normal boot plus the three qualification settings of `boot.sh`'s opt-in hook (bucket, profile, and the worker role's unique ID); attaches the volume; reads the instance's private IP; waits (up to 20 minutes) for the hook's `ready.json` marker, which the worker uploads once it answers `/ping`; issues a `linux-arm64-web-api-v1` challenge for `http://<ip>:8080`, bound to every worker subnet in the foundation's `Ec2WorkerSubnets` output exactly as `agentx project add` builds the project's runtime binding (so the registered rows match the project's binding), while the worker itself launches into the first of them; uploads `challenge.json` to `e2e-runtime/<role unique ID>:<instance ID>/` in the control artifacts bucket (the one prefix the standing grant `e2e-runtime/${aws:userid}/` allows that instance); polls `status.json` for up to 60 minutes (the challenge's lifetime, which starts only after the worker is ready); only on `SUCCEEDED` downloads `proposal.json` and registers it; and then deletes `challenge.json` (a one-use secret) from the bucket. If that delete fails it warns and prints the delete command: run it by hand. A failed run prints the same command for a `challenge.json` it uploaded and did not delete. The challenge is issued after the launch, not before, because it names the instance's private endpoint. A missing or unreadable `ready.json`/`status.json` (including AccessDenied, since the principal may lack `s3:ListBucket`) counts as not there yet until the deadline.

On the instance the hook waits for the worker to answer `/ping`, checks as root that the executor image is on the host (`docker image inspect`; if missing it logs in to ECR the way boot does and pulls it, bounded, and fails with the status reason `executor-image-unavailable` if it is still missing), uploads `ready.json`, waits for the challenge and copies it into the evidence directory, runs the qualifier with `docker exec --user node agentx-worker ... install-qualification-cli.js --profile linux-arm64-web-api-v1`, and uploads `proposal.json` and then `status.json` (`{state, reason, finishedAt}`). On any failure it uploads a `FAILED` status with a fixed reason code (`worker-not-healthy`, `executor-image-unavailable`, `challenge-unavailable`, `qualification-failed-exit-<n>`, `proposal-too-large`, ...) and stops; it never touches the worker.

On any failure the script leaves the instance running for diagnosis and prints its ID, the volume's ID, and the commands that end them. It also prints the launch's client token and an `aws ec2 describe-instances --filters Name=tag:agentx:qualification-run,Values=<uuid>` command, so an instance that RunInstances created before it threw can still be found:

```sh
aws ec2 terminate-instances --instance-ids <id> --profile agentx-test --region us-east-1
aws ec2 delete-volume --volume-id <vol> --profile agentx-test --region us-east-1     # after the instance is gone
```

The script never terminates an instance or deletes a volume itself; the only objects it deletes are its own preflight object and the one-use `challenge.json`. Read the instance's console output and the hook's journal (`agentx-e2e-qualification.service`) before ending it.

### The registration expires after 7 days

The web/API registration expires 7 days after the qualification that wrote it. M1.2 demos must run within that window; after it, run `test-qualify-runtime` again (a new instance and volume, and the owner's explicit OK for that spend again).

### Expected result

- Both stacks are `UPDATE_COMPLETE` with the `CodeSha256` values matching (step 1).
- The registration prints two catalog rows, both `READY`:
  - `E2E_FEATURE_VERIFIER#<featureCatalogId> / PROFILE#linux-arm64-web-api-v1#web revision <n>`
  - `E2E_FEATURE_VERIFIER#<featureCatalogId> / PROFILE#linux-arm64-web-api-v1#api revision <n>`
- All six probes had their expected outcomes (CSV and API state positives passed; the CSV defect, web egress, API egress and build IMDS probes failed for their stated reasons). The registrar re-derives each from the retained evidence; a proposal that does not hold is refused with its reason (for example `negative-probe-passed:web-csv-negative-v1`).

### Recording the evidence in `status.md`

Add one entry to the Log and set M1.1 to done, with: the deployed commit SHA; both stack names with `UPDATE_COMPLETE` and the Lambda `CodeSha256` values; the worker and executor image digests; the run's UUID, the role unique ID and the `e2e-runtime/<role unique ID>:<instance ID>/` prefix; the challenge ID and the proposal's sha256 (the registration answer's `proposalSha256`); the two catalog rows with their revisions; the instance ID and when it was ended. Never paste the challenge file (it holds a one-use secret) or any token.

## M1.2 live demo (TEST, 2026-10-20)

**Result:** passed. First shipped end-to-end browser verification of a real feature.

- Environment: agentxlivetest123, branch `claude/rovara-e2e-m1-2-workflow` (TEST ran a7f014ec, then df8a677b for the Slack retry wiring). Qualified runner `i-0ea63cdc793ff48c6`; rows `PROFILE#linux-arm64-web-api-v1#web/#api` revision 4.
- Project: `rovara-web-fixture` (repo `abhishek255/rovara-orders-web-fixture`), Slack `#rovara-web-fixture`.
- Request (Slack): "Add an Export CSV button to the orders page. Export only the selected date range and the current tenant's orders."
- Task: `a43e54fe-236e-499d-9e10-b950cdef12d7`.

| Step | Outcome |
|---|---|
| Plan | v2 application intent, two web scenarios: `owner-csv-export` (orders-owner), `viewer-csv-export` (orders-viewer); owner approved |
| Coding + project checks | PASS |
| Browser round 1 (candidate 9b051f39) | broker-verified PASS (round ba4756b9) |
| Security review | BLOCKED: CSV injection (MEDIUM), unvalidated from/to (LOW) |
| Send-back 1 → browser round (candidate 77ae80f3) | broker-verified PASS (round 2ac2a059) |
| Security review | BLOCKED: `total` column unprotected (MEDIUM) |
| Send-back 2 → browser round (candidate 822e59fc) | broker-verified PASS (round 6667a8b2) |
| Review | PASS |
| Pull request | draft https://github.com/abhishek255/rovara-orders-web-fixture/pull/1, CI green |

Pass criteria from the plan:
- At least one browser scenario FAILED on a real candidate before a repair: **not exercised live** (the agent's first CSV export passed its browser scenarios). The repair loop was exercised live through the security review (two send-backs, each re-running the browser round). The browser FAILED → send-back → PASS path is covered by `tests/e2e/m1-web-journey.test.ts` in CI `linux-runtime`.
- PASS on the repaired candidate: yes (three verified rounds).
- Draft PR in `rovara-orders-web-fixture` with green CI: yes.
- Rovara page shows the scenario results: task page shows the qualified round.

Live findings fixed on the way (all on the branch, reviewed, CI green):
1. FX1: publication failed for projects registered before 2026-10-14 (missing catalog `latestRevision`), shown as WORKSPACE_BUSY; was in the paused production queue.
2. FX2: TEST deploys left 9 control-plane Lambdas on 2026-10-14 code (notifier could not read v2 plans; SessionsSteps did not pass the executor image); plan cards now always link the task page; E2E fallback wording no longer reads as a verdict.
3. IAM (owner-approved): SessionsSteps role could not read `worker-executor-image`.
4. FX3: verification compared the raw stored intent with the admission's derived intent; collector resolved accounts by application only (two-account plans went UNKNOWN).
5. FX4: Slack "Choose checks and retry" could not re-approve after requalification.

Security hotfix shipped to production the same day (worker git hardening, H3/H3b/H3c backported onto 2deee3d7, release 236bcc99).

## M1.4: AI navigation (agent steps)

M1.4 is accepted when a live web scenario with an `agent` step finds the renamed export button on a real candidate through the governed model route, the deterministic CSV assertion decides PASS, the verified round replays without the model, and the evidence is recorded. This section is the operator runbook for Task 4.9 steps 3 to 7 (`m1-4-plan.md`); the pass criteria are in that plan's "M1.4 live acceptance" section and are not repeated here. The cost of each step is in `m1-4-cost-estimate.md`.

Facts this runbook uses: TEST installation `agentxlivetest123`, account `944937319445`, `us-east-1`; provider Amazon Bedrock; model Claude Haiku 5.5 through the inference profile `us.anthropic.claude-haiku-5-5` (model agreement `AVAILABLE`); fixture project `rovara-web-fixture` (repo `abhishek255/rovara-orders-web-fixture`, Slack `#rovara-web-fixture`). Qualification uses the route `rovara-scripted/v1`, which calls no provider and costs no model spend. The replay (Task 4.6b) runs with no model.

### Owner-approval gates

| Gate | Where | What the owner approves |
|---|---|---|
| **G1: first real model call** | Step 3 (the driving test) | The first call to Bedrock from Rovara (decision D1). Show the owner the cost table in `m1-4-cost-estimate.md` (and Ruling M4-Q's cost ceiling) before the call. D7 pre-approves model spend within the D2 caps, but not this first call. |
| G2: runner spend | Step 2 | Covered by D7 (up to 3 qualification runner launches pre-approved, 2026-10-21). Tell the owner when a launch starts; a fourth launch needs a new OK. |
| G3: fixture push | Step 4 | Covered by D6 (push the m14 baseline to `main` of the fixture repo, close the M1.3 demo PR unmerged). The dry run's file list is shown to the owner first. |
| G4: Tier 3 | Steps 1 and 3 | Any `iam-missing-grant` the head does not declare, missing Bedrock model access, or a network gap from the runner to `bedrock-runtime`: stop and send the owner one Tier 3 packet. |
| **G5: merge** | Step 7 | Merging PR E into mainline (D10: no production release). Only after the owner has read the recorded evidence. |

### Preconditions

- PR E is open as a draft with every CI job green, including `linux-runtime` with all `m1-4-journeys` cases, and it has had one full review (Task 4.9 step 2).
- The PR E head is deployed to TEST with `scripts/test-deploy.ts` (the M1.1 section above, step 1; units `broker,dispatcher,worker-image,executor-image`, plus `control-plane-code` when the head changes other control-plane Lambdas).
- The owner is signed in to AWS (`aws login --profile agentx-test`) and to Rovara TEST as an administrator (`agentx --env agentxlivetest123 login --admin`).
- The working tree is clean and `npm run build` has been run (both scripts refuse a dirty tree).

### 1. Check TEST (Task 4.9 step 3)

```sh
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --check
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --check --json   # same, with the report as one JSON line
```

Expected result: exit 1 with only these findings, all expected at this point:

- `catalog-not-ready` or a descriptor without `agent`: the rows are still the M1.3 revision (fixed by step 2);
- `model-route-not-approved` (warning until step 4);
- `model-access-unverified` (info) if the deploy profile cannot read model availability;
- `runner-image-mismatch` / `worker-feature-missing` for `task.workflowE2EAgentSteps.v1` on the old runner, which was qualified from an older image (fixed by step 2).

Anything else stops the run:

- `stale-lambda`: deploy again.
- `iam-missing-grant` that the head template declares: apply it under the standing TEST pre-approval (guarded change set) and tell the owner after.
- `iam-missing-grant` the head does not declare, `iam-explicit-deny`, `model-agreement-missing` or `model-not-in-catalog`: gate G4, Tier 3 packet.

Record: the head SHA, the exit code, and the `--json` line (the "before" `--check` output for `status.md`).

### 2. Requalify the runner with the 14 probes (Task 4.9 step 4)

The canary of step 3 runs on this runner, so it must be launched from a head that has the canary hook (boot.sh) and the worker image with `e2e-model-canary-cli.js`, and the canary's two object keys must be granted first. Add the grant once (a guarded add-only change set: it adds the policy `E2eQualificationTransportCanary` beside the deployed `E2eQualificationTransport` and changes nothing else; declared in the head template, so it is under the standing TEST pre-approval):

```sh
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only qualification-transport          # plan; read it
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only qualification-transport --apply
```

```sh
npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test            # plan only; read it
npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test --apply    # gate G2 (D7)
```

Spend: one `m6g.large` instance and one 20 GiB gp3 volume. The run waits up to 20 minutes for the worker and up to 60 minutes for the probes. The runner then stays up: it is the runner the demo rounds run on, until it is retired.

Expected result:

- All 14 probes have their expected outcomes. That is the 11 M1.3 probes plus three new ones:
  - `web-agent-scripted-v1`: PASS (exactly one download, `csv` passes, receipts equal the report);
  - `web-agent-wrong-action-v1`: EXPECTED_FAILURE, UNKNOWN `agent-no-download`;
  - `web-agent-app-isolation-v1`: PASS.
- The registration prints both rows `PROFILE#linux-arm64-web-api-v1#web` and `#api` as `READY`, on a new revision, and the web descriptor lists `agent` with `modelChannel: "rovara-e2e-model-channel/v1"`.
- The qualification calls no model: its policy uses `rovara-scripted/v1`. Bedrock usage for the account does not move.

Then retire the previous runner, with the commands in the M1.1 section above (`aws ec2 terminate-instances`, then `aws ec2 delete-volume` once the instance is gone). Take its instance and volume IDs from the last requalification entry in `status.md`.

Run `--check` again. It must exit with no findings other than the `model-route-not-approved` warning.

Record: run UUID, new instance ID and private IP, volume ID, role unique ID and the `e2e-runtime/<role unique ID>:<instance ID>/` prefix, challenge ID, `proposalSha256`, both row revisions and their expiry (7 days), the retired runner's IDs and when it was ended. Never paste `challenge.json`.

### 3. Model check: the driving test of the demo model (Task 4.10) — gate G1

The single-call canary of Task 4.9 is replaced by the **driving test**: one call, then a small real navigation of the built-in fixture app, run on the qualified runner under the model the installation chose. No route of any provider is approvable until its driving test has passed for that exact route (`E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>` with `test: "driving/v1"`).

Before anything is spent, look at what the account can use (no model call):

```sh
agentx --env agentxlivetest123 project model-check discover
```

It prints the tiers (Recommended, Works on your account, Not usable with the reason, Can be tested with the worst-case cost of one driving test) and the exact `config set models.e2eAgent <id>` and `model-check test --model <id>` lines. On TEST, with quota `L-47520EB7` at 0, Haiku 5.5 is Not usable (limit 0; US-only `L-47520EB7` 0, Global `L-F26CA8D1` 0) and `us.anthropic.claude-haiku-4-5-20251001-v1:0` is the recommendation. If discovery is denied, it says so and the driving test confirms the model instead; discovery never blocks.

Choose the model, then run the test (gate G1: the owner's explicit OK first; the command shows the worst-case cost and asks):

```sh
npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only e2e-agent-model --e2e-model us.anthropic.claude-haiku-4-5-20251001-v1:0 --apply
agentx --env agentxlivetest123 project model-check test --model us.anthropic.claude-haiku-4-5-20251001-v1:0
```

The same checks can be asked with the operator's AWS profile where the CLI has no admin sign-in (plan only without `--apply`):

```sh
npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID from step 2> --model <id>            # plan only; no AWS call
npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID from step 2> --model <id> --apply    # gate G1
npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID from step 2> --discover --apply      # lists the models; no model call
# optional: --timeout-minutes <1-30> (default 10), --region <region> (default us-east-1)
```

How it works: the control plane (`POST /v1/admin/e2e/model-checks`) or the script puts `e2e-runtime/<role unique ID>:<instance ID>/canary-request.json`: a v2 request that names the check (a new id), its kind and, for a driving test, the route's id and definition digest. The runner's boot hook starts a bounded server in the worker container (`e2e-model-canary-cli.js`): it polls every 20 seconds for two hours and every 120 seconds after, serves each check id once, at most 12 checks per runner and at least 60 seconds apart, and stops when the registration expires (7 days) or it is stopped. Its fixed `model-check:` lines go to the runner's journal (`agentx-e2e-qualification: model-check: ...`). The test makes one call of a fixed prompt (with ONE retry in the minimal request shape if the provider rejects the request as malformed; no other failure is retried), then runs the fixture's CSV-export goal through the real executor and the governed model channel, with at most 3 actions. The whole test is held to one budget by the worker: at most 6 model calls, 36,000 input tokens in all and 512 output tokens per call. It passes only when the deterministic oracle says so: one download, the CSV check passes, and the worker's receipts equal the executor's report; a model never judges it. The broker validates the result (route, tested definition, receipts, budget, verdict, report) and writes the rows only for a validated pass: the gating row, the request shape that worked and the model's test row. A failed test writes its test row only and tells the failure in the owner's sentence; a failed test needs no new runner. Exit codes of the script: 0 recorded and passed, 1 not passed, not trusted or no result, 2 refused arguments. The test does not go through any project's day budget (no project is involved); its worst case for Haiku 4.5 on Bedrock is $0.0565 (expected about $0.0074).

The runner that serves checks is recorded by `scripts/test-qualify-runtime.ts` after the registration (`E2E_MODEL_ROUTES / E2E_MODEL_CHECK_RUNNER#linux-arm64-web-api-v1`, bound to the registration's transport correlation), so a check is only sent to the runner that was qualified. A runtime registered before this change needs `test-qualify-runtime --apply` again.

Before the test: show the owner the driving-test rows of `m1-4-cost-estimate.md` (section 9 of the 4.10 plan) and get an explicit OK.

Expected result: `The driving test passed with ...: it clicked through the built-in fixture, downloaded one file and the checks agreed.`, with the request shape (standard, or minimal if the first call was rejected and the one retry decided) and the counts. A failure prints the approved sentence of its class (limit, key, not found, unreachable, request rejected, provider outage, unreadable secret, unknown model, unknown). Setup approval then shows `driving test passed <date>` and approves the exact route that was tested.

If model access is refused (AccessDenied, or the agreement is not available) or the runner's subnet cannot reach `bedrock-runtime`: stop. That is gate G4.

Record: the check ID, the receipts (all fields), the shape, the token counts and the latency. This gives the first measured input-token figure for the cost estimate.

### 4. Publish the fixture baseline and approve setup again (Task 4.9 step 6)

```sh
npx tsx scripts/fixtures/publish-web-fixture.ts --repo abhishek255/rovara-orders-web-fixture --variant m14 --dry-run   # show the owner the file list (G3)
npx tsx scripts/fixtures/publish-web-fixture.ts --repo abhishek255/rovara-orders-web-fixture --variant m14
```

The publisher first backs up `main` as `backup/pre-m14-<UTC timestamp>`, and stops without touching `main` if it cannot. Close the M1.3 demo PR unmerged and keep its link (D6). TODO: no script closes it; close it on GitHub by hand, with the owner's OK.

Then approve the setup of `rovara-web-fixture` again, so that the registry writes the route at revision 1 and sets `policy.modelRouteRevision`:

```sh
agentx --env agentxlivetest123 project setup-approve --project-name rovara-web-fixture [--region us-east-1]
```

`project add` does not do this: for a registered project it changes nothing and asks nothing. `project setup-approve` (run from the machine that registered the project, which holds its project file) proposes the setup again from the registered repository and default branch through `/v1/admin/projects/setup-proposals`, shows the same single confirmation as `project add` (with the AI navigation sentence, D5), records the decision through `/v1/admin/projects/setup-approvals`, and on approve registers the next project revision with the approved policy (so `policy.modelRouteRevision` is set). A decline is recorded and registers nothing.

Expected result: the setup prompt shows the AI navigation line naming Bedrock and `us.anthropic.claude-haiku-5-5`, the approval is recorded (`decision: "approve"`), and the page shows the route ID and revision 1. Run `--check`: exit 0.

Record: the fixture's new `main` commit SHA and the backup branch, the closed M1.3 PR link, `proposalRef` and `proposalSha256`, the route ID and revision, and the `--check` output.

### 5. Live demo (Task 4.9 step 7)

Post the request in `#rovara-web-fixture`, exactly as written in `m1-4-plan.md` ("M1.4 live acceptance"). Approve the plan when it matches the expected plan there: four scenarios, one of them (`owner-export-ai`) with an `agent` step with `maxActions: 5`, and the route shown as "AI navigation: Bedrock `<model>`; checks decide".

Expected result, in order:

- **Baseline round** on the unchanged code: `owner-export-ai` is skipped and makes no model call (Ruling CX). `owner-toolbar-button` is FAILED (`expected visible, was hidden`).
- **Candidate round**: broker-verified PASS for every required scenario. The page shows "AI-navigated: the model clicked 'Download orders'; the CSV check decided". `owner-export-ai` has at most 9 receipts (5 + 4), every one `ok`, and their route equals the admission. The candidate's DOM has no `export-csv`.
- If a candidate fails a check, record it. The send-back loop then runs as usual, and each new candidate round can make up to 9 more calls.
- The draft PR in the fixture repo has green CI.

Record: the task ID, the plan approval, every round ID with its candidate SHA and verdict, and the operator S3 keys of `agent-actions.json`, the receipts and the redacted transcripts. Also record the total model calls and input/output tokens, against the D2 caps (2,000,000 input tokens and 400 calls per project per UTC day), and the draft PR link. Run a byte scan of the stored transcripts for the seeded credentials; it must find nothing.

### 6. Audit replay (Task 4.9 step 7)

```sh
npx tsx scripts/e2e-replay-round.ts --env agentxlivetest123 --task <task id> --round <verified candidate round id> --profile agentx-test
# optional: --region <region>, --poll-seconds <1-300> (default 15), --timeout-minutes <1-120> (default 40), --no-wait (start and print the attempt only)
# read it later: agentx --env agentxlivetest123 admin task e2e-replay show --task <task id> --round <round id>
```

It needs the admin sign-in (`agentx --env agentxlivetest123 login --admin`) and a built CLI (`npm run build`). Exit 0 when the replay was recorded (reproduced or not), 1 when it could not be run or did not finish in time, 2 when refused.

Expected result: `replay: { status, reproduced: true, downloadSha256Match: true }`, the same download digest as the verified round, zero receipts, and no model socket in the executor arguments (check the runner's host journal). Publication, `qualifiedRound` and `failedRound` are unchanged. The replay uses one runner round and no model.

Record: the replay ID, `reproduced`, the download digest, and the journal line that shows the executor arguments.

### 7. Optional outage drill

The owner decided on 2026-10-21 (D8) that the live outage drill is skipped, and is covered in CI only (journey `agent-model-outage`). Run it live only if the owner asks again:

```sh
# TODO: no command approves a route revision with a different model ID; route revisions are written only at setup
# approval (D5). Needs a design before the drill can run live.
```

Expected result, if run: UNKNOWN `model-unavailable`, publication blocked, a retry offered, no PASS. Then restore the route and approve setup again.

### 8. Finish

- Run `--check` once more (the "after" output). Confirm that no `rovara.run` resources and no `model.sock` remain on the runner.
- Add one Log entry to `status.md` with everything recorded above, and set M1.4 to done.
- **Gate G5:** the owner reads the evidence and approves the merge of PR E into mainline. There is no production release (D10).
