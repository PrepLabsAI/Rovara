# SWE-bench runs from Slack

Spec 043. A member of an enabled channel scores the AgentX coding agent on one SWE-bench task:

```
@agentx eval swebench verified django__django-11099
@agentx eval swebench lite astropy__astropy-12907 model Fast
```

AgentX replies that the run started, and later posts whether the task was resolved, the hidden tests'
counts, why the agent stopped, how long it took, what it cost and where its artifacts are. `stop` in
the thread cancels the run. One run is active per deployment at a time.

A run measures the coding agent: the worker's Pi session, tools, prompts and model. It does not use a
project workspace, devcontainer or pull request, and does not measure the Slack orchestrator.

## How a run works

```mermaid
flowchart LR
  Slack[Slack thread] --> Service[Slack service]
  Service -->|POST /v1/service/evals/swebench| Broker
  Broker -->|run record, lock| State[(DynamoDB)]
  Broker -->|evals/run/launch.json| Bucket[(Artifact bucket)]
  Broker -->|StartExecution| Machine[Eval state machine]
  Machine -->|RunInstances, poll, terminate| Instance[x86 eval instance]
  Instance -->|reads launch.json, writes artifacts| Bucket
  Instance -->|started, result| Broker
  Service -->|polls the run| Broker
  Service -->|result| Slack
```

1. The Slack service recognizes the command before the orchestrator, resolves `model <name>` against
   the project's approved models, and asks the broker to start the run. The request ID comes from the
   Slack event, so a redelivered event finds the same run.
2. The broker checks that the eval stack and runner image are installed and the channel is enabled,
   takes the deployment's single-run lock with the run record, writes `evals/<run>/launch.json` (the
   run's configuration and its callback capability), and starts the eval state machine.
3. The state machine launches an `m7i.xlarge` from the eval launch template, tagged with the run ID.
   The boot script reads the launch file by that tag, pulls the runner image (the worker image built
   for `linux/amd64`) and runs its SWE-bench mode once.
4. The runner loads the instance's row from Hugging Face (`SWE-bench/SWE-bench_Verified` and siblings,
   which name each task's image), pulls the task image, copies its `/testbed` out, removes every ref,
   remote, tag and unreachable object, and starts the task container with no network and the copy
   mounted back at `/testbed`. The agent works through `docker exec` in the task's conda environment.
5. The agent stops when it finishes, after 60 minutes, at the channel's cost ceiling, when its cost
   cannot be measured, or at the tool-loop guard. Its diff against the image's HEAD is graded by the
   official harness (`swebench` 5.0.2, installed with uv) in a fresh task container.
6. The runner stores the patch, transcript and harness logs under `evals/<run>/`, reports the result,
   and the instance shuts down. The state machine terminates it in every case, and marks a run that
   was cancelled, exceeded two hours, or lost its instance.

## Installing

Every step writes to the AWS account; an administrator runs them.

1. **Release the control plane** with this change (`npm run release:prod`). The broker gains the eval
   routes, SSM read access to the eval settings and worker model, and permission to start the eval
   state machine. Until the eval stack exists, runs are refused as not installed.
2. **Deploy the eval stack.** It is outside the release and the foundation:

   ```bash
   npm run build --workspace @agentx/infra
   npx cdk deploy AgentXEval -c agentxEval=enabled --app 'node infra/dist/bin/agentx.js' \
     --parameters VpcId=<AgentXProductionFoundation VpcId> \
     --parameters PrivateSubnetIds=<AgentXProductionFoundation PrivateSubnetIds> \
     --parameters ControlPlaneUrl=<AgentXControlPlane ApiEndpoint> \
     --parameters ArtifactBucketName=<AgentXControlPlane ArtifactBucketName> \
     --parameters StateTableName=<AgentXControlPlane StateTableName>
   ```

   Add `--parameters OpenRouterSecretArn=<arn>` when the worker model is served through OpenRouter.
   A named environment adds `-c agentxEnv=<name>`, and its stack is `agentx-<name>-eval`.
3. **Build the runner image**: `npm run swebench:runner-image` (add `--env <name>` for a named
   environment). It builds the worker image for `linux/amd64`, pushes it with a `swebench-` tag (never
   `release-`, which the repository keeps only twenty of), and writes `<settings prefix>eval/runner-image`.
   Run it again to ship a runner change; the broker reads the parameter per run.
4. **Enable a channel**: `agentx admin eval enable --team <T…> --channel <C…> [--max-cost-usd 10]`.
   The channel must already be bound to a project. `agentx admin eval show` and `disable` read and
   remove the setting.

## Costs and limits

- **Tokens:** most tasks cost 1 to 3 USD. The channel's ceiling (10 USD by default, 1 to 100) stops
  a run that goes past it; the run is still graded.
- **Compute:** an `m7i.xlarge` for the run's duration, usually 15 to 60 minutes, and a 150 GiB gp3
  root volume that is deleted with the instance.
- **Time:** the agent has 60 minutes; the instance lives at most two hours.
- **One run at a time** per deployment. A batch of instances is a follow-up.

## Artifacts

`s3://<artifact bucket>/evals/<run>/`:

| File | Contents |
|---|---|
| `launch.json` | The run's configuration, written by the broker (includes the callback capability) |
| `patch.diff` | The agent's change: the prediction the harness graded |
| `transcript.jsonl` | The Pi session |
| `harness/report.json`, `harness/test_output.txt`, `harness/run_instance.log` | The official harness's report and logs |
| `result.json` | What the runner reported, with the list of saved artifacts |

The runner's own log is in the `…/swebench` log group, in a stream named `<run>/<instance>`.
