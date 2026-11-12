# Smart intake for plain chat requests

A plain top-level mention (no `chat:`, `quick:` or `full:` prefix) is sorted before anything else happens. The aim:
ask how to handle a request only when it truly cannot be told.

## The problem it fixes

"@bot hello" was answered with the three-choice card ("How should I handle this? Just answer / Quick / Full"). Two
causes, both in the routing step:

1. The classifier's instruction had no place for small talk. `question` meant "information, an explanation, a status
   or advice", so a greeting fit none of the kinds and the model answered `unclear`.
2. Every classifier failure (no model, timeout, unusable answer) is also `unclear`, and `unclear` always shows the
   three-choice card. A greeting during a classifier outage got the card too.

## The decision, in order

| Step | What happens | Model call |
| --- | --- | --- |
| 1. Prefix | `chat:`, `quick:`, `full:` (and `workflow ...:`) choose for the person, as before. | none |
| 2. Small talk | The whole message is a greeting, thanks or "what can you do?" (fixed vocabulary, at most 80 characters). A fixed friendly reply says what the assistant can do. No card, nothing queued, nothing started. | none |
| 3. Classifier | `question` (now also greetings, thanks, small talk, reviews, summaries) goes to the chat agent. | one small call |
| 4. Small change | Clear and low risk: Quick starts on its own (owner decision 134) and the thread hears "I started it as a quick change: plan → code → checks → draft PR", with a Stop button. Otherwise the card with Start as the primary button; `full` and `answer` are one reply away. | (same call) |
| 5. Large change | Card: suggests Full with a fixed reason (a feature, several parts, or decisions first). | (same call) |
| 6. Unclear or failed | The three-choice card, now with a recommendation: *Just answer*, because it changes no code. This is also the fallback whenever the classifier fails. | (same call) |

`unclear` is now reserved for "may want a code change but cannot tell whether or what", and the instruction says to
prefer `question` when in doubt, because an answer changes nothing.

## Starting a clear small change on its own (decision 134)

Only a usable `small_change` answer is tried. The Slack service asks the broker (`POST /v1/service/workflows/quick-start`,
the Slack service's existing signed route family, acting for the thread and requester), and the broker decides:

- Only a new request's own thread (no task there yet).
- Its own deterministic check of the text (`packages/broker/src/core/intake/quick-auto-start.ts`): at most 280
  characters and 3 lines; no markup or text that talks to the assistant ("ignore", "rules", "system prompt", braces,
  tags); nothing the path rules call high risk, by word (auth, login, payments, migrations, infra, CI, secrets, delete,
  deploy, ...) or by a path named in the text (`isSensitivePath`). So text that steers the classifier still cannot
  start a task.
- The start itself is the requester's Start press: same member checks, project, limits, admission and spend, and
  Quick's plan step comes first with its approval per risk level. Nothing downstream changes.

Anything else (`unusual_text`, `high_risk`, `too_long`, `thread_busy`, `start_refused`, or the call failing) posts the
card with Start, as before. Unclear, large, and every classifier failure never auto-start.

**Stop.** The started message has a Stop button (requester only; a teammate's press is refused). One press is enough
and a second changes nothing. The press is remembered on the task (`stopRequest`), then:

- setup still running: the first instructions are taken back (as a cancel before they run does), so finished setup
  queues no planning step; when setup finishes the task closes and the thread hears "Stopped as you asked";
- a step running (planning, say): it is cancelled first, and the task closes once it has stopped;
- nothing running (a plan waiting for approval): the task closes at once.

The close discards whatever the task planned or wrote; no pull request opens.

**Small talk in a task's thread.** "thanks", "great", "ok" (and other bare acknowledgements) in a Slack-started task's
thread get the fixed reply ("I didn't add that to the task"), with no model call, and are not saved as task notes. A
mention is answered in the thread; a plain reply only privately. "thanks, but also fix X" is not small talk and is
saved for the task as before.

## Safety and cost

- The message is untrusted. Small talk is only matched against a fixed vocabulary and is never echoed back; any other
  word makes it a request ("hi, fix the README" goes to the classifier). The classifier still sees the message only
  inside `<message>` tags it cannot close, and its own reason is never shown: every card reason is fixed copy.
- Decision 134 replaces "nothing starts without a click" for one case only: a clear, low-risk small change starts Quick,
  whose plan still comes first. No new worker power and no new IAM permission: the start goes through the Slack
  service's existing `/v1/service` route as the requester, and the broker re-checks the text itself.
- Small talk costs nothing. The classifier call is unchanged: same model, same deadline (at most 4 seconds), and in a
  deployment with a spending plug-in it goes through the same model access and admission path as before.

## Where it lives

- `packages/contracts/src/request-intake.ts`: `smallTalkOf` and `smallTalkReply`. Channel-neutral (plain text in,
  plain text out), so any channel adapter's intake can call it.
- `packages/contracts/src/slack-routing.ts`: the classifier's instruction and the card copy.
- `packages/slack-service/src/request-routing.ts`: calls the small-talk step before the classifier.

Follow-up: when the channel-adapter intake (spec 062) gains plain-request routing, it calls the same two functions
before its own classifier step.

## Owner decisions (decision 134)

- A clear small change starts Quick on its own, with a visible Stop button.
- Small talk in a task's thread gets the fixed reply and is never saved as a task note; a plain (non-mention) "ok"
  gets it privately.
- The high-risk word list stays strict.
- A Stop pressed during setup is remembered: one press is enough.
- The unclear picker recommends Just answer.
- No per-project forced path.
