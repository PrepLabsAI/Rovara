# Question-level eval evidence

The worker's `runEvalRound` / `planEvalRound` / `completeEvalRound` seam now uses
question results. The former aggregate noise-band rule is retired; aggregate-only
v1 measures and cache records still parse but cannot produce an eval verdict.

A `questionPlan` supplies the trusted question inventory (identity, base/head
content hashes and ordinary/safety/refusal category), a pinned judge/scoring hash,
customer-provider binding, task spend to date, and the runner. The runner must use
F1 ModelEgress with the customer's product-provider capability and F3 pacing, run
in the final check sandbox, and resolve only after its calls have joined. Its
old-code reports must also carry the branded checkout attestation for the requested
base commit. Its fresh reports are read through A4's contained, bounded measures reader. A report
can add `questions: [{id, samples: [{pass, answer}]}]` to the existing v1 measures
shape; grades other than boolean pass/fail are not supported yet.

The saved cache record carries three samples per question. Setup and background
refresh own this measurement; a missing or old aggregate-only record gives a
neutral Not run notice. F3d supplies the baseline and later re-keys it to eval
inputs. Until then the company/project, exact model version, base commit, eval
hash, hidden-set hash and command key remain. When questions change, the worker
uses the trusted old-set hash for cache/old reports and the head hash for new
reports, while excluding each added, removed or edited question from the comparison.
The untouched intersection is scored; only an empty intersection is too few to judge.
Exclusions are named and counted. Subset-capable runners skip excluded questions;
whole-set-only runners still execute the head inventory and discard excluded answers. The settings fingerprint uses the
question-rule version, image, route and judge pin, not a user-chosen seed or noise
setting. The worker never writes a task's new-code answers into the baseline.

The first new run covers every untouched question (the full head set when the
runner cannot select a subset). At most ten downward suspects and ten
upward suspects get three fresh old and three fresh new answers. Only those
fresh answers enter the targeted exact test. The whole-set test conditions on
each question's total passes and convolves its hypergeometric distribution;
there is no variance estimate or normal approximation. Each direction uses
p < .01. If the first whole-set p is in [.01, .2), two additional new runs provide
one second look. Edited questions never enter either comparison, and each is
listed separately. Suspects beyond the re-ask limit are listed as such but still
participate in the whole-set check.

One 3/3-old, 0/3-new question is shown as broke. It requests a fix but alone has
p=.05 and does not set Worse. A confirmed safety/refusal break does set Worse.
Worse takes precedence over Improved. The worker allows two passes and one fix
request. The disposition is always a normal PR: failure for Worse, success for a
completed no-drop/improvement check, neutral with Retry for Not run. The lane's
own development PR is a draft for review; that is separate from this product rule.

The explicit per-project `questionPlan.limits` input carries the approved
health-check budget when available; absent dimensions use the eval-only default of 400 calls and $4 (DEC 203),
inside the monthly provider cap. General task pacing remains 200 calls and $2.
Before the first run, reserve N question-runs using measured upper call/cost
bounds (including judge calls). Once suspects are known, reserve six runs per
selected suspect before either side is re-asked. Reserve 2N only if a whole-set
second look is needed. Reservations include prior passes and actual spend. After each invocation,
actual spend is checked; an overrun stops further calls. A stage that cannot fit starts no calls
and returns Not run/cap unless Worse has already been established. Public results
include the estimated calls and cost for every attempted stage, including refused
stages; private results reveal none. The saved baseline costs no task calls.

Public PR summary text contains fixed words and counts only. Signed-in evidence
and public-question agent feedback contain bounded inert text for changed, broken
and flaky questions only; unchanged questions are summarised as a count. No-drop
text explains repeated breaks and strict categories without inventing measured
power; project-specific detection power awaits the F3d health-check producer.
Private sets retain the sealed-only mount guard; feedback is a single fixed
pass/fail and the result carries no question identities, positions or counts.
No private set is derived from repository questions.

PR #570 is not in this stack. `tierRequestsEval` accepts its `eval_hint` reason
objects (`{code, path?}`), without adding a tier kind or another prompt filename classifier.

When discovery explicitly supplies `evalConfigured: false` and the tier has `eval_hint`, evidence includes: "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below." The round is neutral/Not run and spends nothing; the notice stands alone with no Retry. An absent question plan alone does not establish that no eval exists. Side-by-side answers are a separate lane, absent from this base; this adapter emits only the notice.
