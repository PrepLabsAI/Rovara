# Experiment Specification: The Final Campaign — SWE-bench, SEC-bench and Cost per Solved Task Across Models

**Feature Branch**: `docs/046-model-cost-comparison`  
**Created**: 2026-10-01  
**Status**: Draft; the last step before launch, run once the build work below is done  
**Input**: The first production SEC-bench run (spec 045 SC-003) cost $7.23 on Sonnet 4.6, and we asked whether
GLM, Kimi or DeepSeek would be cheaper for the same results

## Why

We do not know which model gives the AgentX coding agent the best results for the money, and we cannot tell from
price lists. Three things from 2026-10-01 show why:

- **Token prices mislead.** Re-pricing the SEC-bench run's exact token mix (16.9M cached reads, 101k output, 167k
  cache writes) at today's OpenRouter list prices gives: Kimi K3 $12.35 (no cache discount), Sonnet 4.6 $7.23,
  GLM 5.3 $3.38, Kimi K2.6 $1.49, DeepSeek V4 Pro $0.37. But a model that takes more turns uses more tokens.
- **Behaviour differs.** In the SWE-bench pilot, GLM 5.3 used 2.35M tokens and 30 minutes on `sphinx-doc__sphinx-7590`
  against Sonnet's 0.31M and 2 minutes, so it cost 3.6x more ($0.98 vs $0.27). Neither solved it.
- **Published numbers are thin and mostly second-hand.** On DeepSWE (secondary sources, unverified), Sonnet 4.6
  costs $5.52 per task at 30%, GLM 5.2 $3.92 at 44%, and Kimi K2.7 Code $2.82 at 31%. SEC-bench's paper publishes no
  agent costs.

So we measure it ourselves, on our agent, with the harness we already have.

## Role: the one paid campaign before launch

Decision (2026-10-01): before launch, no model money goes on regression checks. Everything is built first: the Pi
0.99 upgrade (050), agent verification (051), per-model thinking levels (053), and batch runs (052). Then this
campaign runs once, on the finished agent, and produces the three results that matter:

1. **SWE-bench results** for the AgentX coding agent.
2. **SEC-bench results.**
3. **The model comparison on both:** resolve rate and cost per solved task.

It also validates spec 051. The rate at which the agent's claim disagrees with AgentX's check or the grader is
reported per model.

## The question

For each candidate model, on the same tasks, under the same agent and limits: **what share of tasks does it solve,
and what does each solved task cost?**

The result informs two decisions, which this experiment does not make by itself:

1. The default model for eval runs.
2. Whether a cheaper model is worth trialling for production coding tasks. That needs its own evaluation on
   production-like work, because a benchmark is not the product.

## Dependencies

- **D-0: The build work comes first.** Specs 050 (Pi 0.99), 051 (verification) and 053's per-model thinking level must be
  released before the campaign, and the runner image is then frozen for it.
- **D-A: Batch runs (spec 052, not yet written).** Today the runner allows one run per deployment, started by hand from
  Slack. This experiment needs a batch of (task, model, repeat) runs, with several running at once, each recorded
  with its result. The batch spec (052) is a separate piece of work, and the SWE-bench learnings session recommended it.
  This experiment is written against what that spec must provide (Requirements, R-1 to R-4).
- **D-B: Agent verification fix (spec 051, recommended first).** In the pilot, the agent claimed success it did not have in
  3 of 5 failed runs. Comparing models before fixing that compares how well each model can talk itself into a false
  success. Run this experiment on the agent customers will get.
- **D-C: Model access.** Each model must be approved for the eval project, and its cost must be measurable: an
  OpenRouter model without pricing stops after its first turn (spec 043 FR-003).

## Design

### Tasks

- **SEC-bench (patch task, spec 045):** as below.
- **SWE-bench:** the dataset and slice are open (Q-4). The recommendation is a SWE-Bench Pro slice, harder and newer,
  with a small Verified slice so the results can be compared with public numbers. It uses the same models,
  controls and analysis as SEC-bench, with its own budget line (Q-5).
- **SEC-bench task selection:**
- **Phase 1 (screen):** 8 instances. **Phase 2 (confirm):** more tasks and repeats for the one or two models Phase 1
  picks out, budgeted separately.
- **Selection:** stratified across projects (no more than 2 per project) and sanitizer types, drawn once with a
  fixed seed from the 300 `eval` IDs, and committed as `specs/046-model-cost-comparison/tasks.txt` before any run.
  Include `njs.cve-2022-32414` as a known-solvable control.

### Models (confirmed 2026-10-01)

| Model | Route | Why it is in |
|---|---|---|
| Claude Sonnet 4.6 | Bedrock | current default; the baseline |
| GLM 5.3 | OpenRouter, one pinned provider | strongest open-weight candidate in the published data |
| DeepSeek V4 Pro | OpenRouter, one pinned provider | about 20x cheaper per token; the price outlier |
| Kimi K2.6 | OpenRouter, one pinned provider | cached-read pricing (K3 has none listed) |
| Qwen3 Coder Plus | OpenRouter, one pinned provider | a coding-tuned open-weight model; priced at about a third of Sonnet |
| MiniMax M3 | OpenRouter, one pinned provider | low price with cached reads; about a sixth of Sonnet |

Opus 5 is out until its Bedrock agreement is accepted.

### Shakedown, then freeze

Before the full campaign, run a **shakedown slice**: 1 SEC-bench task and 1 SWE-bench task on all six models, about
$20, cheapest models first. Fix what it shows, then **freeze the runner image** by digest. Any fix after the freeze
means the runs it affects are run again, so every model is compared on the same agent.

### Controls (identical for every run)

- The same runner image, pinned by digest for the whole experiment.
- The same prompt and limits: 60 minutes, 200 tool calls, `--network none`.
- The same cost ceiling: $20 per run.
- Thinking level set **explicitly per model** and recorded. The pilot's comparison was confounded by GLM at "high"
  and Sonnet at "medium". Use each model's recommended agentic setting, and record it.
- OpenRouter provider pinned per model. The pilot's GLM runs were spread over 4 providers, with gaps of up to 396 s.
- **Repeats (Phase 1, to fit a $200 cap):** one run per (task, model) for all six models, plus a second run on the
  three cheapest (DeepSeek V4 Pro, MiniMax M3, Kimi K2.6), where a repeat costs a few dollars. Runs are not
  deterministic, so a single run can be luck either way. Phase 1 therefore only screens; Phase 2 confirms.

### Measures (per run, from `result.json` and the run record)

- Resolved (`medium`); also `strict` and `generous`.
- Failed step, if any.
- Stop reason.
- Agent time.
- Tool calls.
- Tokens by kind, and cached-read share.
- Cost in USD.
- The model's provider.

### Analysis

- **Resolve rate** per model, with a 95% Wilson interval.
- **Cost per solved task** per model: total spend divided by tasks solved. This is the headline number.
- **Paired comparison.** Per task, compare each model against Sonnet on the share of repeats solved. Report where
  models disagree, not only the totals.
- **Honesty about power.** With 8 tasks and one or two runs per model, only large differences will show (for
  example 6 of 8 solved against 2 of 8). Phase 1 answers "which models are clearly worse, and which are close enough
  to Sonnet to test properly", not "which is best". Smaller gaps are reported as "not distinguishable", not as wins.
- **Failure review.** Read the transcripts of every failed run for one task per model. Classify each failure as
  wrong fix, false claim of success, ran out of time or calls, or tool trouble.

## Requirements (what the batch feature, spec 052, must provide)

- **R-1:** Start a batch of (task, model, repeat) runs from one command or file, with a total cost ceiling for the
  batch that stops starting new runs once reached.
- **R-2:** Run several at once (at least 4), within the account's EC2 and Bedrock limits.
- **R-3:** Record every run's measures in one place that can be exported as CSV.
- **R-4:** A failed or cancelled run is recorded as such and never counted as unresolved.

## Budget

**Phase 1 is capped at $200**, enforced by the batch's cost ceiling (R-1): no new run starts once spend reaches it.
Estimated at the measured SEC-bench token mix ($ per run): Sonnet 4.6 7.23, GLM 5.3 3.38, Qwen3 Coder Plus 2.67,
Kimi K2.6 1.49, MiniMax M3 1.19, DeepSeek V4 Pro 0.37.

| Phase 1 part | Runs | Estimate |
|---|---|---|
| 8 tasks x 6 models x 1 run | 48 | about $131 (Sonnet $58 of it) |
| Second run on DeepSeek, MiniMax, Kimi | 24 | about $24 |
| **Total** | **72** | **about $155, cap $200** (headroom for turn-count differences) |
| EC2 (m7i.xlarge, about 0.5 h per run) | | about $8 |

The pilot showed one model can take several times another's turns on the same task, which can double its cost. The
cap absorbs that; runs are ordered cheapest model first, so if the cap is hit, the missing runs are Sonnet's, whose
baseline matters least to re-measure. Phase 2 is planned and budgeted after Phase 1, for the models it picks out.

## Out of Scope

- Changing the production default model.
- SWE-bench Pro and Verified. The same design applies, and they can follow once SEC-bench results exist.
- PoC-generation tasks.
- Leaderboard submission.
- Published claims. Any public number needs the "sanitizer-verified, no regression tests" note and the sample size.

## Open Questions

- **Q-1** (answered 2026-10-01): six models, including Qwen3 Coder Plus and MiniMax M3.
- **Q-2** (answered 2026-10-01): Phase 1 capped at $200.
- **Q-3** (answered 2026-10-01): after the verification fix, as part of the final campaign.
- **Q-4:** Which SWE-bench: a Pro slice plus a small Verified slice (recommended), Verified only, or Pro only? And how
  many tasks?
- **Q-5:** The total campaign budget. SEC-bench Phase 1 is capped at $200. Adding a similar-sized SWE-bench part
  brings the total to roughly $300-450.

## Success Criteria

- **SC-001:** `tasks.txt` and the model, thinking-level and provider settings are committed before the first run.
- **SC-002:** All 72 Phase 1 runs (or every run started before the cap) are recorded, and failed or cancelled runs are listed separately.
- **SC-003:** A short report goes in this folder, with the resolve rate and interval, cost per solved task, the
  paired comparison and the failure review per model, and a recommendation for the two decisions above that says
  how confident it is.
