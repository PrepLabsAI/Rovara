# Slack experience live evidence

## Phase 14a

Released by CI from `mainline` 1992d5e (PR #51) on 2026-09-25. The control plane finished updating at 10:09 UTC. Checked in `#agentx-connectors` (C0C487WPJ9K), which is bound to the `connectors-check` project.

**Parameters.** `aws cloudformation describe-stacks --stack-name AgentXControlPlane` shows `SlackAppPostedMessages = accept` and `SlackThreadTurnsPerMinute = 6`.

**Mention posted by another app.** The mention was posted through Claude Code's Slack access. It uses the operator's user token and carries the bot name "Claude MCP Abhishek".

| Check | Thread ts | Result |
|---|---|---|
| New thread, 10:12:01 | 1790331121.751499 | Accepted ("Got it") and attributed to U0BSPTAFNG2, then refused by the per-member workspace limit (3 of 3). Before 14a the same post was ignored. The limit is the problem that phase 14b fixes. |
| Existing thread, 10:12:14 | 1790312954.766639 | Accepted, ran, and answered from Linear in 10 seconds. The `users.info` person check passed, so `users:read` is present on the bot token. |

**Turn limit.** At 10:13:48, 8 mentions were posted within about 1 second to thread 1790313106.839039:
- 6 were accepted ("Got it", then "queued behind 1" to "queued behind 5").
- One pause notice was posted at 10:13:50.
- 2 mentions got nothing.
- All 6 accepted turns answered. Slack delivered the mentions out of posting order, so the answers came in the order 1, 5, 6, 8, 2, 3 and the refused ones were 4 and 7.
- None of AgentX's roughly 20 replies in that thread started a turn.

**Reply formatting.** At 10:15:34, "show me the details of CHA-5, including its link" got a reply with:
- real line breaks and `-` bullets;
- no `**`;
- one Slack link `<https://linear.app/charterarc/issue/CHA-5/agentx-live-check>`.

For comparison, the same thread's pre-14a reply at 05:12:51 (thread 1790313106.839039) had literal `\n`, `**bold**` and `[<url>](<url>)` links.

**Not run:**
- *Mention posted with the AgentX bot token.* The operator has no bot token locally. AgentX's own replies in the turn-limit thread are the practical evidence that bot-authored messages don't start turns.
- *Matching `slack-ingress` log lines.* The operator's IAM user lacks `logs:FilterLogEvents`.

**Finding.** Each request posts two acknowledgements back to back: "Got it. I'm on it…" from the ingress, and "Working on it now…" from the Slack service less than a second later. Only one is needed when nothing is queued ahead. Resolved by FR-026 in phase 14b PR B.

## Phase 14c part 2

Production live check on 2026-09-25, 19:34 to 19:58 UTC, in `#agentx-connectors`. The Slack service's `service.started` line showed `classifierModel` `amazon.nova-lite-v1:0` as available.

| # | Request | What happened |
|---|---|---|
| 1 | "mark CHA-7 Done" | Asked: destructive (it sets a state). The requester pressed **Approve**; the buttons were replaced with "Approved by …". One `confirmation` / `allow` decision was recorded, and CHA-7 moved to Done. |
| 2 | "close KAN-5" | The orchestrator model (`amazon.nova-pro-v1:0`) built a `createJiraIssue` call with `additional_fields.status`. The gate asked (destructive). The requester pressed **Cancel**: "Cancelled. Nothing was run." |
| 3 | "rename CHA-8" | A change. The classifier allowed it in 437 ms at $0.000029, and it ran without asking. |
| 4 | "yes to all" | Granted. |
| 5 | "mark CHA-8 Done" (after 4) | Still asked: "yes to all" does not cover destructive actions. The requester typed cancel. |

**Findings fixed in this PR:**
- After a confirmation, the model also posted its own reply restating the pending action in the third person. That was redundant. The confirmation is now the reply when nothing else ran, and the model is told not to mention it.
- A message that was only a confirmation answer ("yes", "cancel", …) also got the ingress's "Got it", which was redundant. The ingress now skips it, unless the answer is queued behind earlier requests.

**Open finding:** Nova Pro misread "close" as "create" in check 2. The gate caught it: the call asked and was cancelled.
