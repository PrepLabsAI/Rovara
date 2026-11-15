# Eval in the final check

The broker's `eval_hint` adds an optional CHECKS request. Delivery drops it, with a fixed log event, for workers without `task.evalRound.v1`. A request carries the pass number and prior task usage. No request preserves the existing CHECKS path.

After ordinary checks, evidence capture and test proof, the worker calls `runFinalCheckEval`. Its guards are ordered: connected ports, trusted fresh round kind, verified tests, readable trusted plan, then a matching confirmed customer grant. Company, project, selection and the eval-input digest must match. A project with no configured eval takes the existing no-eval notice path before reading approval. A baseline already being measured returns immediately.

`openMeteredStage` reserves the whole next stage and counts its own dispatched calls and returned costs. Runner-reported usage is not authoritative. A refused hold maps to the fixed budget refusal. Reservations close after pending calls join, including errors and cancellation. A cold baseline and comparison share the remaining task budget, including prior attempts; the same validated grant is reused. Unknown cost prevents further spend. This module neither builds a meter nor chooses a payer.

The eval shares the original CHECKS deadline and abort signal. The existing bounded abort/join guard marks the workspace unsafe if stopping cannot be confirmed. No candidate reread follows an unsafe stop. A completed Worse result survives cancellation of a later stage or a failed reservation close; unknown cost prevents further spend. A failed model call cannot supply comparison facts. After a safe return, the candidate is reread so eval-created drift is visible to the broker.

## Evidence and downstream consumers

`eval-round.json` is bound to the pre-check candidate digest. It stores actual comparison pass bits, bounded differing answers, usage, fixed notice codes and bounded feedback. Private evidence contains only pass/fail or a fixed refusal, with the binding envelope. The strict writer and tolerant reader live in contracts. `evalResultFromArtifact` is the only downstream verdict function; stored labels, summaries and feedback never determine the verdict.

The broker reads at most ten task operations, 1,000 listing entries and one MiB total under the existing proof-read timeout. Object keys must belong to the owner, workspace and operation. Parse or accounting faults refuse the whole read. Prior failed attempts consume budget too. Truncated history, an orphan completed second pass, or a requested attempt without a saved artifact cannot authorize more spending. Ordinary operations without an eval request or artifact consume no eval budget.

The PR-evidence lane should use `loadEvalRound` and `evalResultFromArtifact`; the first-task-during-setup lane should feed that same result to its not-tested entry. This lane does not render PR text, change draft/Proven policy, or drive the single fix round. The artifact carries `feedback` and `fixRequested` for that later driver.

## Host composition (plan v3.2 row 20.2)

`createEvalFinalCheckPorts(capabilities)` (worker, `verification/eval-host.ts`) composes the ports from one injected, trusted capability set and binds nothing when any capability is missing or not a function (the request then reads `not_connected`, zero calls). `main.ts` still does not call it: the two production capabilities below are not deployable yet.

- `modelAccess: EvalModelAccess` (`eval-model-access.ts`). `hold({grant, calls, costMicros})` holds the WHOLE stage estimate and returns an egress, an opaque scope and a `release`. `createEvalMeter` turns it into the `MonthlyMeter` the eval consumes: a call beyond the held count or cost is refused before the egress; each call is one attempt, never retried; a thrown fault, a malformed or over-long answer (10 MiB) or a deadline (2 minutes) is `provider_error` with an unknown cost, so the stage stops and the spend is retained; an overrun settle stops the stage; `close` joins every call and releases only known unspent spend. A rate limit, quota, overload, refused key, gateway cap or provider error keeps its own Not run reason and is never a pass or Worse. Production: the gateway's product route, reached with the task token Code mints (`/v1/internal/model-access`). Tests: a script.
- `exec: EvalSandboxExec` (`eval-runner.ts`). Runs the confirmed eval command for one side in the check sandbox and receives only an egress (every call is the stage's metered `call`), an opaque scope, the ids, the run count and the signal; never the reservation, grant or a key. Its result is runtime-checked; its own accounting is ignored; a plain object is not an attestation; the new side carries none. Production: the F1-c model bridge and a sandbox exec (not wired into `run-task`; `TE-F1C-RUNTASK-NOT-WIRED`).

A finished comparison also records its basis in `eval-round.json` (`basis`: eval-set hash, judge pin, model, model version, three old runs), and `evalProofBasis(artifact)` (contracts) re-derives the proof row from the bits: cases passed (old and new), the slices (ordinary, safety, refusal), the baseline, the judge and the bar (`EVAL_PROOF_BAR`). A stored label never decides any of it; a private-set round has no row.

## Host binding contract

Only trusted worker wiring may supply `EvalFinalCheckPorts`; `main.ts` does not bind it yet. The host must:

- derive the plan, round kind and public question inventory from trusted confirmed setup and the actual check sandbox (this plan does not mount a private set);
- supply company-scoped approval, cache and reservation capabilities, with a single authority for reserve/call/close;
- run old code with a valid Rovara baseline attestation and produce complete bounded per-question reports;
- charge every model call through the supplied call function, honor abort, impose provider deadlines, and join the sandbox and all calls before returning or rejecting;
- preserve workspace safety errors and never resolve while a writer remains active.

Until this binding exists, requests produce `not_connected` and spend zero. A working or unknown sandbox produces `needs_fresh_sandbox`. The laptop adapter and the move of laptop final checks into a fresh CHECKS round are separate work. Cloud binding waits for the company/project meter and fresh check round. The real-model-test lane can reuse the metered stage and append its own independent final-check step. Integration follows the eval approval/health stack and the 0.5.18 re-pin.
