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
| 4. Small change | Card: "This looks like a small, clear change, so I'll do it as a quick change: plan → code → checks → draft PR." Start is the primary button; `full` and `answer` are one reply away. | (same call) |
| 5. Large change | Card: suggests Full with a fixed reason (a feature, several parts, or decisions first). | (same call) |
| 6. Unclear or failed | The three-choice card, now with a recommendation: *Just answer*, because it changes no code. This is also the fallback whenever the classifier fails. | (same call) |

`unclear` is now reserved for "may want a code change but cannot tell whether or what", and the instruction says to
prefer `question` when in doubt, because an answer changes nothing.

## Safety and cost

- The message is untrusted. Small talk is only matched against a fixed vocabulary and is never echoed back; any other
  word makes it a request ("hi, fix the README" goes to the classifier). The classifier still sees the message only
  inside `<message>` tags it cannot close, and its own reason is never shown: every card reason is fixed copy.
- Nothing that changes code starts without the requester's click. No new worker power, no new permission.
- Small talk costs nothing. The classifier call is unchanged: same model, same deadline (at most 4 seconds), and in a
  deployment with a spending plug-in it goes through the same model access and admission path as before.

## Where it lives

- `packages/contracts/src/request-intake.ts`: `smallTalkOf` and `smallTalkReply`. Channel-neutral (plain text in,
  plain text out), so any channel adapter's intake can call it.
- `packages/contracts/src/slack-routing.ts`: the classifier's instruction and the card copy.
- `packages/slack-service/src/request-routing.ts`: calls the small-talk step before the classifier.

Follow-up: when the channel-adapter intake (spec 062) gains plain-request routing, it calls the same two functions
before its own classifier step.

## Open questions for the owner

- Should Quick start on its own for a clear small change (with a stop button), or keep waiting for Start?
- Should a project be able to force one path (always Quick, always Full, or always ask)? No such setting exists today.
- Should small talk inside a task thread (for example "thanks") also get the fixed reply instead of a task answer?
