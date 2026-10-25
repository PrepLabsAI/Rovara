# M1.4 cost estimate (Task 4.9, TEST `agentxlivetest123`)

Prepared 2026-10-22 for the owner, before the first real model call (gate G1 in `m1-live-acceptance.md`, "M1.4: AI navigation"). All prices are AWS on-demand list prices in `us-east-1`, in USD, before tax and credits.

## Summary

- **Model spend is negligible.**
  - The canary (one call) costs **under half a cent**, about $0.0014 if the prompt is near the plan's 8k-token figure, and at most $0.0041.
  - One live demo round makes at most 9 model calls. That is **about $0.002 expected**, at most $0.013 at the plan's 8k tokens per call, and at most **$0.037** at the hard 32k-token bound.
  - The replay costs **$0** in model spend.
  - A full TEST day at the D2 caps (2,000,000 input tokens, 400 calls) costs at most **$0.45** per project.
- **The runner costs more than the model.** The qualification runner is an `m6g.large` with a 20 GiB gp3 volume, at about **$0.079 an hour** together.
  - Requalification takes at most about 80 minutes (about $0.11).
  - The runner then keeps running so the demo rounds can use it. Each demo, baseline or replay round adds about $0.02 to $0.04 of runner time.
  - Left up for the 7 days its registration lasts, the runner costs about **$13.30**. Retiring it after the demo is the biggest saving available.
- Not included here: the coding agent's own model calls during the demo (they use the installation's coding model, not the e2e route), S3 evidence storage, CloudWatch logs, data transfer, and the instance's root volume (its size is set by the launch template; TODO: read it).

## Prices used

| Item | Price | Source (retrieved 2026-10-22) |
|---|---|---|
| Claude Haiku 5.5 on Bedrock, `us-east-1`, input, standard (geographic `us.` profile), prompts up to the long-context threshold | $0.11 per 1M tokens | AWS Price List API, offer `AmazonBedrockFoundationModels`, `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json` (publication 2026-10-12T08:40:08Z), usage type `USE1-MP:USE1_input_tokens_standard-Units`, "Million Input Tokens Standard" |
| Same, output | $0.55 per 1M tokens | same offer, `USE1-MP:USE1_output_tokens_standard-Units`, "Million Response Tokens Standard" |
| Same, long context (not reached: every prompt is at most 32k tokens) | $0.55 in / $2.75 out | same offer, `..._input_tokens_long_ctx_standard`, `..._output_tokens_long_ctx_standard` |
| For comparison: global profile | $0.10 in / $0.50 out | same offer, `..._global_standard` |
| `m6g.large` Linux, on-demand | $0.077 per hour | AWS Price List API, offer `AmazonEC2`, `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv` (publication 2026-10-22T03:29:39Z), SKU `RSV572JURZ29ZMTS`, "$0.077 per On Demand Linux m6g.large Instance Hour" |
| gp3 storage | $0.08 per GB-month (20 GiB is about $0.0022 per hour at 730 h a month) | same offer, SKU `JG3KUJMBRGHV3N8G` |

The public page `https://aws.amazon.com/bedrock/pricing/` could not be fetched from this environment (the proxy refused it). The Price List API above is AWS's machine-readable source for the same prices.

These figures agree with the seam's earlier estimate (Ruling M4-Q, $0.11 / $0.55, which was marked "unverified, inferred") and with third-party listings: [pi.dev](https://pi.dev/models/amazon-bedrock/us-anthropic-claude-haiku-5-5?name=pi) gives $0.11 / $0.55 up to 100k tokens, and [llmreference](https://www.llmreference.com/model/claude-haiku-5-5/aws-bedrock) gives the base $0.10 / $0.50. The Bedrock price is now confirmed from AWS's own price list. Nothing is cached: every call sends `cacheRetention: "none"`, so no cache-write premium applies.

## Inputs to the math

| Input | Value | Where it comes from |
|---|---|---|
| Agent steps in the demo | 1 (`owner-export-ai`, `maxActions: 5`); the other three scenarios have no agent step | `m1-4-plan.md`, "M1.4 live acceptance", expected plan |
| Calls per agent step, at most | `maxActions + 4` = 9 (the plan's cap is 8 + 4 = 12 for any step) | plan, Global Constraints (D2) |
| Calls on the baseline round | 0: a baseline skips AI navigation steps (Ruling CX) | plan, pass criterion 2 |
| Output per call, at most | 1,024 tokens | D2 |
| Input per call, hard bound | 32,000 tokens (the route refuses a prompt whose bytes + 1,024 could pass it, about 30,976 bytes) | D2; seam "Token bounds" |
| Input per call, plan figure | about 8,000 tokens for a full 31 KB prompt | the plan's bound, roughly 4 bytes a token |
| Measured requests on the m14 fixture | turn 1: 5,736 bytes; turn 2: 7,120 bytes (2 calls end the step) | seam, "Measured on the m14 fixture" (Task 4.3b) |
| Measured requests in tokens | not measured yet. The estimate is bytes ÷ 3 (about 1,900 and 2,400 tokens), which allows for Haiku 5.5 counting about 30 % more tokens than 4 bytes a token. The canary receipt gives the first real count. | estimate |
| Group cap | 3 agent steps, 40 calls, 400,000 input tokens | D2 |
| Day cap, per project, TEST | 2,000,000 input tokens and 400 calls | D2 |

## The math

Cost = input tokens × $0.11 / 1M + output tokens × $0.55 / 1M.

| Case | Calls | Input tokens | Output tokens | Input $ | Output $ | Total |
|---|---|---|---|---|---|---|
| (a) Canary, plan figure | 1 | 8,000 | 1,024 | 0.00088 | 0.00056 | **$0.0014** |
| (a) Canary, hard bound | 1 | 32,000 | 1,024 | 0.00352 | 0.00056 | $0.0041 |
| (b) Demo round, expected (2 calls as measured, output at its cap) | 2 | 4,285 | 2,048 | 0.00047 | 0.00113 | **$0.0016** |
| (b) Demo round, worst case at the plan figure (9 × 8,000) | 9 | 72,000 | 9,216 | 0.00792 | 0.00507 | $0.0130 |
| (b) Demo round, worst case at the hard bound (9 × 32,000) | 9 | 288,000 | 9,216 | 0.03168 | 0.00507 | **$0.0367** |
| Baseline round | 0 | 0 | 0 | 0 | 0 | $0 |
| (c) Replay (no model socket) | 0 | 0 | 0 | 0 | 0 | **$0** |
| One group at its cap (for reference) | 40 | 400,000 | 40,960 | 0.04400 | 0.02253 | $0.0665 |
| (d) Full TEST day at the caps | 400 | 2,000,000 | 409,600 | 0.22000 | 0.22528 | **$0.4453** |

How to read (b): every send-back adds one candidate round, so three candidate rounds (as in the M1.2 demo) cost at most 3 × $0.0367 = $0.11 at the hard bound. The day cap stops all calls at $0.45 per project per UTC day whatever happens: hitting it gives UNKNOWN `model-route-budget-exhausted`, not more spend. A call that fails is still counted against the budget (the seam's charging rules), so failed calls cannot push spend past the cap.

## (e) Runner time on EC2

The runner is one `m6g.large` (`INSTANCE_TYPE` in `scripts/test-qualify-runtime.ts`; `AGENTX_PRODUCTION_INSTANCE_TYPE` in `infra/lib/production-foundation.ts` is the same type) with one 20 GiB gp3 volume (`VOLUME_SIZE_GIB`). Together they cost $0.077 + $0.0022 = **$0.0792 an hour**. The demo, baseline and replay rounds run on this qualified runner (the catalog row points at its `http://<ip>:8080`), so a round adds runner time, not a new instance.

| Item | Hours | Cost |
|---|---|---|
| Requalification, worst case (20 min to ready + 60 min for the probes) | 1.33 | $0.11 |
| Overlap with the old runner until it is retired (assume 1 hour) | 1 | $0.08 |
| One demo, baseline or replay round (no round time is recorded in the repo; assume 15 to 30 minutes) | 0.25–0.5 | $0.02–$0.04 |
| The live acceptance: baseline + candidate + one send-back + replay, at 30 minutes each | 2 | $0.16 |
| Runner left up for a day | 24 | $1.90 |
| Runner left up for its 7-day registration | 168 | $13.30 |
| D7 ceiling: 3 launches, each kept 7 days | 504 | $39.91 |

TODO: measure one round's runner time in the demo and replace the 15-to-30-minute assumption.

## Total for Task 4.9 (one requalification, the canary, the demo with one send-back, the replay)

| Part | Expected | Worst case |
|---|---|---|
| Model: canary + 2 candidate rounds + replay | about $0.005 | $0.08 (hard bound on every call) |
| Runner: requalification + overlap + 4 rounds | about $0.35 | $0.35, plus $1.90 for each day the runner is left up |
| **Total, runner retired the same day** | **about $0.36** | **about $2.33** |


---

## Task 4.10: the driving test and discovery (Task 4.10C)

Prices are from the pinned pi catalog (per MTok, input/output; the AWS Price List API was not read for this change, so re-read `AmazonBedrockFoundationModels` (us-east-1) before quoting them to a customer). The test makes at most 6 model calls, 36,000 input tokens in all and 512 output tokens per call (3,072 in all); it is not charged to any project's day budget.

| Case (Bedrock Haiku 4.5 `us.`, $1.10 / $5.50) | Calls | Input | Output | Total |
|---|---|---|---|---|
| Driving test, expected | 3 | about 4,700 | about 400 | **$0.0074** |
| Driving test, worst (budget) | 6 | 36,000 | 3,072 | **$0.0565** |
| Discovery | 0 | none | none | $0 |

Worst case of one driving test with each provider's recommended default: Bedrock Haiku 5.5 US-only $0.0057, Bedrock Haiku 5.5 Global $0.0051, Anthropic $0.0051, OpenAI `gpt-5.4-mini` $0.0408, OpenRouter $0.0051 plus its credit fee. `agentx project model-check test` prints the worst case of the model about to be tested and asks first; `discover` lists each model that can be tested with its worst case.

Remaining Task 4.9 work (at most 2 driving tests, 2 candidate rounds, the replay): model about $0.05 expected, $0.85 worst (2 x $0.0565 + 2 x $0.3675); runner $0.35; **about $3.10 worst with the runner retired the same day**, within the approved $3.11. A third driving test needs the owner's word.
