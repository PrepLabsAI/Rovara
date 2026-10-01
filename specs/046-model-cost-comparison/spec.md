# Experiment Specification: Cost per Solved Task Across Models

**Feature Branch**: `docs/046-model-cost-comparison`  
**Created**: 2026-10-01  
**Status**: Draft; blocked on batch runs (see Dependencies)  
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

## The question

For each candidate model, on the same tasks, under the same agent and limits: **what share of tasks does it solve,
and what does each solved task cost?**

The result informs two decisions, which this experiment does not make by itself:

1. The default model for eval runs.
2. Whether a cheaper model is worth trialling for production coding tasks. That needs its own evaluation on
   production-like work, because a benchmark is not the product.

## Dependencies

- **D-A: Batch runs (not yet specified).** Today the runner allows one run per deployment, started by hand from
  Slack. This experiment needs a batch of (task, model, repeat) runs, with several running at once, each recorded
  with its result. The batch spec is a separate piece of work, and the SWE-bench learnings session recommended it.
  This experiment is written against what that spec must provide (Requirements, R-1 to R-4).
- **D-B: Agent verification fix (recommended first).** In the pilot, the agent claimed success it did not have in
  3 of 5 failed runs. Comparing models before fixing that compares how well each model can talk itself into a false
  success. Run this experiment on the agent customers will get.
- **D-C: Model access.** Each model must be approved for the eval project, and its cost must be measurable: an
  OpenRouter model without pricing stops after its first turn (spec 043 FR-003).

## Design

### Tasks

- **Benchmark:** SEC-bench patch task (spec 045). One family, so the grader is the same for every run.
- **Phase 1:** 10 instances. **Phase 2:** 20 more, only if Phase 1 shows a difference worth confirming.
- **Selection:** stratified across projects (no more than 2 per project) and sanitizer types, drawn once with a
  fixed seed from the 300 `eval` IDs, and committed as `specs/046-model-cost-comparison/tasks.txt` before any run.
  Include `njs.cve-2022-32414` as a known-solvable control.

### Models (proposed, for Abhishek to confirm)

| Model | Route | Why it is in |
|---|---|---|
| Claude Sonnet 4.6 | Bedrock | current default; the baseline |
| GLM 5.3 | OpenRouter, one pinned provider | strongest open-weight candidate in the published data |
| DeepSeek V4 Pro | OpenRouter, one pinned provider | about 20x cheaper per token; the price outlier |
| Kimi K2.6 | OpenRouter, one pinned provider | cached-read pricing (K3 has none listed) |

Opus 5 is out until its Bedrock agreement is accepted.

### Controls (identical for every run)

- The same runner image, pinned by digest for the whole experiment.
- The same prompt and limits: 60 minutes, 200 tool calls, `--network none`.
- The same cost ceiling: $20 per run.
- Thinking level set **explicitly per model** and recorded. The pilot's comparison was confounded by GLM at "high"
  and Sonnet at "medium". Use each model's recommended agentic setting, and record it.
- OpenRouter provider pinned per model. The pilot's GLM runs were spread over 4 providers, with gaps of up to 396 s.
- **Repeats:** 3 per (task, model) in Phase 1. Runs are not deterministic, and a single run per cell cannot separate
  luck from ability.

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
- **Honesty about power.** With 10 tasks x 3 repeats, only large differences (roughly 25 points or more in resolve
  rate) will be clear. Smaller gaps are reported as "not distinguishable", not as wins.
- **Failure review.** Read the transcripts of every failed run for one task per model. Classify each failure as
  wrong fix, false claim of success, ran out of time or calls, or tool trouble.

## Requirements (what the batch feature must provide)

- **R-1:** Start a batch of (task, model, repeat) runs from one command or file, with a total cost ceiling for the
  batch that stops starting new runs once reached.
- **R-2:** Run several at once (at least 4), within the account's EC2 and Bedrock limits.
- **R-3:** Record every run's measures in one place that can be exported as CSV.
- **R-4:** A failed or cancelled run is recorded as such and never counted as unresolved.

## Budget

Estimated from the measured SEC-bench run and the pilot. Real costs depend on turns.

| Phase | Runs | Model spend (estimate) | EC2 (m7i.xlarge) |
|---|---|---|---|
| 1: 10 tasks x 4 models x 3 repeats | 120 | about $250-450 (Sonnet about $220 of it) | about $15 |
| 2: 20 more tasks | 240 | about $500-900 | about $30 |

Stop rule: if Phase 1 spend passes $500, stop and review before continuing.

## Out of Scope

- Changing the production default model.
- SWE-bench Pro and Verified. The same design applies, and they can follow once SEC-bench results exist.
- PoC-generation tasks.
- Leaderboard submission.
- Published claims. Any public number needs the "sanitizer-verified, no regression tests" note and the sample size.

## Open Questions

- **Q-1:** Confirm the model list, and whether to add Qwen3 Coder Plus or MiniMax M3.
- **Q-2:** Confirm the Phase 1 budget and the $500 stop rule.
- **Q-3:** Run before or after the agent verification fix (D-B)? Recommended: after.

## Success Criteria

- **SC-001:** `tasks.txt` and the model, thinking-level and provider settings are committed before the first run.
- **SC-002:** All 120 Phase 1 runs are recorded, and failed or cancelled runs are listed separately.
- **SC-003:** A short report goes in this folder, with the resolve rate and interval, cost per solved task, the
  paired comparison and the failure review per model, and a recommendation for the two decisions above that says
  how confident it is.
