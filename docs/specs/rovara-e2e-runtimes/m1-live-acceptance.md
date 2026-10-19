# M1 live acceptance

What the owner and the controller run in TEST to accept each M1 sub-milestone, and how the evidence is recorded in `status.md`. Every command here targets the one allowlisted TEST installation (`agentxlivetest123`, `scripts/test-deploy.allowlist.json`) and never production.

## M1.1: the TEST runner qualifies `linux-arm64-web-api-v1`

M1.1 is accepted when the TEST worker has run the six web/API probes with the expected outcomes and both catalog rows are registered. Two commands do it, each plan-first.

### Preconditions

- The commit to deploy is committed on the branch (both scripts refuse a dirty tree, so the bytes that run are the bytes recorded) and `npm run build` has been run.
- The owner has signed in to AWS: `aws login --profile agentx-test`.
- The owner has signed in to Rovara TEST as an administrator: `agentx --env agentxlivetest123 login --admin`. `test-qualify-runtime` checks this before it creates anything, with a read-only `admin workspace list`.
- The ECR repository for the executor image exists beside the worker's (the worker's repository name with `worker` replaced by `executor`, for example `.../worker` becomes `.../executor`). `test-deploy` never creates a repository: a missing one stops the run, and creating one is a Tier 3 item (`test-fast-lane.md`).
- The standing qualification transport (Task 0.1) is deployed. The first deploy below does it.

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

What `--apply` does, in order: checks the admin sign-in; reads the live stacks, settings, signing key and launch template (refusing unless the executor image and the qualification transport are deployed and the template is the reviewed shape); creates one volume; launches exactly one instance from the environment's launch template (client token = the run's UUID, `MinCount=MaxCount=1`) with the worker's normal boot plus the three qualification settings of `boot.sh`'s opt-in hook; attaches the volume; reads the instance's private IP; issues a `linux-arm64-web-api-v1` challenge for `http://<ip>:8080`; uploads `challenge.json` to `e2e-runtime/<uuid>/` in the control artifacts bucket; polls `status.json` for up to 60 minutes (the challenge's lifetime); and only on `SUCCEEDED` downloads `proposal.json` and registers it. The challenge is issued after the launch, not before, because it names the instance's private endpoint; the hook waits for `challenge.json` for up to 30 minutes.

On the instance the hook waits for the worker to answer `/ping`, copies the challenge into the evidence directory, runs the qualifier with `docker exec --user node agentx-worker ... install-qualification-cli.js --profile linux-arm64-web-api-v1`, and uploads `proposal.json` and then `status.json` (`{state, reason, finishedAt}`). On any failure it uploads a `FAILED` status with a fixed reason code (`worker-not-healthy`, `challenge-unavailable`, `qualification-failed-exit-<n>`, `proposal-too-large`, ...) and stops; it never touches the worker.

On any failure the script leaves the instance running for diagnosis and prints its ID, the volume's ID, and the commands that end them:

```sh
aws ec2 terminate-instances --instance-ids <id> --profile agentx-test --region us-east-1
aws ec2 delete-volume --volume-id <vol> --profile agentx-test --region us-east-1     # after the instance is gone
```

The script never terminates or deletes anything itself. Read the instance's console output and the hook's journal (`agentx-e2e-qualification.service`) before ending it.

### Expected result

- Both stacks are `UPDATE_COMPLETE` with the `CodeSha256` values matching (step 1).
- The registration prints two catalog rows, both `READY`:
  - `E2E_FEATURE_VERIFIER#<featureCatalogId> / PROFILE#linux-arm64-web-api-v1#web revision <n>`
  - `E2E_FEATURE_VERIFIER#<featureCatalogId> / PROFILE#linux-arm64-web-api-v1#api revision <n>`
- All six probes had their expected outcomes (CSV and API state positives passed; the CSV defect, web egress, API egress and build IMDS probes failed for their stated reasons). The registrar re-derives each from the retained evidence; a proposal that does not hold is refused with its reason (for example `negative-probe-passed:web-csv-negative-v1`).

### Recording the evidence in `status.md`

Add one entry to the Log and set M1.1 to done, with: the deployed commit SHA; both stack names with `UPDATE_COMPLETE` and the Lambda `CodeSha256` values; the worker and executor image digests; the run's UUID and the `e2e-runtime/<uuid>/` prefix; the challenge ID and the proposal's sha256 (the registration answer's `proposalSha256`); the two catalog rows with their revisions; the instance ID and when it was ended. Never paste the challenge file (it holds a one-use secret) or any token.
