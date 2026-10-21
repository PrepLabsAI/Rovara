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
