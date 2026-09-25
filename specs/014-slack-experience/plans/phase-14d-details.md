# Phase 14d: The Private Details View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply that follows tool calls carries a **Details** button; clicking it opens a Slack
modal, for the clicking member only, built from that turn's record, and nothing is posted to the
thread.

**Architecture:** The Slack service adds the button to the last chunk of the reply. The button's
value names the turn by `receivedAt#eventId`, which is the record's sort key without the `TURN#`
prefix. The click arrives on 14c part 2's signed interactivity endpoint (`POST
/v1/slack/interactions` on the ingress Lambda). A new `SlackActionHandler` takes the thread from
the clicked message, never from the value, and does one `GetItem` on the `TurnRecords` table. It
asks only for the attributes the view shows, then opens the modal with `views.open` and the click's
`trigger_id`. A new, least-privilege IAM grant lets the ingress Lambda `GetItem` those attributes
and nothing else: never the request or response text. The Slack service stays PutItem-only, and
the broker stays Query-only.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest, Zod 4.6, AWS SDK v3
(`@aws-sdk/lib-dynamodb`), AWS CDK, Slack Block Kit (`actions`, `section`, `context`) and
`views.open`.

**Spec:** [../spec.md](../spec.md): User Story 4 (acceptance scenarios 3 and 4), FR-024, FR-025,
and the decision "The details view is a private modal". Owner decisions:
`.superpowers/sdd/014-decisions.md` (D2: "The interactivity endpoint is built in 14c and reused by
the Details view (14d)"; the phase order ruling). The endpoint this plan reuses:
[phase-14c2-gate-on.md](phase-14c2-gate-on.md), Task 7 and ruling R15. Turn records: spec 013
phase 4 on mainline (`packages/contracts/src/turns.ts`, `packages/slack-service/src/turn-records.ts`,
`infra/lib/control-plane.ts`).

**Order and branch:** 14a, 14b PR A, 14c part 1, 14b PR B, 14c part 2, then **this phase**. Branch
`feat/014d-details`, cut from mainline once 14c part 2 has merged. This plan is written against
mainline `af67c2c` plus those five. Its code has not been compiled against that base yet. Task 1,
Step 1 checks every anchor the later tasks edit, before any change.

## Global Constraints

- **No regressions.** Every existing test passes. Exactly one existing assertion changes, on
  purpose, and it is the owner-visible scope change of this phase. In
  `tests/contract/turn-records-infrastructure.test.ts`, "gives no other role access to turn
  records" admits a third role, the ingress Lambda, and needs at least three roles instead of two.
  A new appended test pins that role's grant exactly. No other test line is removed or loosened.
  Existing test files only gain appended tests and the imports those tests need.
- **Golden files are append-only.** No snapshot under `tests/contract/__snapshots__` changes. The
  system prompt, manifest and tool descriptions are not edited.
- **Pratik's flows are characterized first (Task 1).** Reply posting and turn recording in
  `packages/slack-service/src/processor.ts` are pinned before Task 6 changes the reply loop.
  `turn-records.ts`, `turn-recorder.ts` and `packages/broker/src/aws/turns.ts` are not edited.
- **The Slack service stays PutItem-only on `TurnRecords`, and the broker stays Query-only.** The
  existing assertion "lets the Slack service only put turn records and the broker only read them"
  is unchanged.
- **FR-025 is met by 14c part 2 and reused as is.** There is no new route, signing code or Lambda.
  The Details handler is one more entry in `createAwsSlackInteractivityHandler`'s `handlers` list.
  The only other edit to `slack-interactivity.ts` is exporting its `slackApi` helper.
- **Nothing is posted to the thread.** The Details handler has no posting dependency. It opens a
  modal, or answers through `response_url` with an ephemeral message when the modal cannot open.
- **Never fail silently.** Every outcome the member can meet is said in the modal: no record yet,
  never saved, expired, unreadable, or unreachable. When the modal cannot open, the member gets a
  private message. Each outcome also has a log line that holds IDs and categories, never record text.
- **Release order:** runtime, then control plane (Details handler, grant, environment), then Slack
  service (buttons).
- **Slack app settings: no change** beyond 14c part 2's Interactivity. `views.open` needs no scope.
- **Node and build.** Node `>=22.19.0 <23`. Run `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Commits.** `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never use `git stash`.
- **Docs style.** Plain, short sentences. No em-dashes. Written for any administrator of a
  self-hosted AgentX.
- **Fix before the PR.** Fix cheap review findings, and anything that fails silently, before the PR.

## Review Focus

1. **Another member opens someone's Details.** Expected: allowed (ruling R1). The modal opens for
   that member only. It shows no request or response text, and the ingress cannot read that text
   because IAM refuses those attributes. The log records who looked (`viewer: "member"`). Test:
   Task 4, "lets another member who can see the reply open it ...".
2. **A forged or edited button value.** Expected: a malformed value is refused without a read. A
   well-formed value is looked up only in the thread of the clicked message, so a value naming
   another thread's turn finds nothing. A stored record that disagrees with its key is refused. Every
   case shows the same neutral message. Tests: Task 2, "refuses a value that is not exactly one
   turn reference"; Task 4, "reads only from the thread of the clicked message ..." and "refuses a
   malformed value without reading ...".
3. **An expired record.** Expected: 30 days after `receivedAt`, the modal says details are kept for
   30 days, without a read. A record DynamoDB has not deleted yet (TTL runs up to 48 hours late)
   but whose `expiresAt` has passed gets the same answer. Test: Task 4, "says the details are no
   longer kept after 30 days ...".
4. **An oversized record.** Expected: 50 calls, each with 2,048 characters of arguments made of
   `<`, `&` and backticks, still open within Slack's limits: at most 100 blocks, at most 3,000
   characters per section, and under 100,000 characters in total. Every call is listed, and cut
   arguments end with `… [cut to fit]`. Test: Task 3, "fits the largest record there can be into
   one modal ...".
5. **A click long after the turn, or right after it.** Expected: any day within 30 days opens the
   record, because each click brings a fresh `trigger_id`. A click in the first minute after the
   reply, before the record is written, says "still being saved". A click after that with no
   record says it was not saved. A modal that cannot open in time, such as after an
   `expired_trigger_id`, gets a private message instead. Tests: Task 4, "... opens them the day
   before", "asks a member who clicks before the record is saved ...", "answers privately through
   response_url ...".
6. **Slack refuses the reply's blocks.** Expected: the reply is posted as plain text and logged
   `reply.details_failed`, so the member never loses the answer. Test: Task 6, "posts the reply as
   text when Slack refuses the blocks ...".

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/slack-details.ts` (new) | Details action ID, button value format and parser, record key, expiry, reply blocks, the attributes the view may read, `TurnDetailsSchema` |
| `packages/contracts/src/index.ts` | Export `slack-details.js` |
| `packages/broker/src/aws/slack-details-view.ts` (new) | Pure modal builder: summary, calls, gate lines, Slack limits, escaping, truncation |
| `packages/broker/src/aws/slack-details.ts` (new) | `detailsActionHandler` (parse, read, check, open, fall back) and `dynamoTurnDetailsReader` |
| `packages/broker/src/aws/slack-interactivity.ts` | Export `slackApi`; register the Details handler in `createAwsSlackInteractivityHandler` |
| `infra/lib/control-plane.ts` | `TURN_DETAILS_READ_ATTRIBUTES`; the ingress `GetItem` grant with attribute conditions; `TURN_RECORDS_TABLE_NAME` on the ingress |
| `packages/slack-service/src/processor.ts` | `ProcessorDependencies.postWithBlocks?`; the Details button on the last reply chunk; text fallback |
| `packages/slack-service/src/main.ts` | Wires `postWithBlocks` to 14c part 2's `postToSlack(..., blocks)` |
| `README.md` | The Details button, who can open it, what it shows, the messages it can give |
| `tests/contract/slack-reply-characterization.test.ts` (new) | Pins reply posting and recording before Task 6 |
| `tests/contract/slack-details-contract.test.ts` (new) | Contract tests for Task 2 |
| `tests/contract/slack-details-view.test.ts` (new) | Modal builder tests, including Slack's limits |
| `tests/contract/slack-details.test.ts` (new) | Handler tests through the signed interactivity endpoint |
| `tests/contract/turn-records-infrastructure.test.ts` | One amended assertion; one appended `describe` |
| `tests/integration/slack-details-button.test.ts` (new) | The button through `processSlackRequest` |

## Pre-decided Rulings

- **R1. Who may open Details: any member who can see the reply, in the thread's own Slack team.**
  - Slack delivers a click only from someone who can see the message. In a private channel, that
    means its members.
  - The handler builds the record key from the clicked message's thread, including its team. It
    also checks that `record.requestedBy.teamId` equals the click's team.
  - Why not only the requester and admins:
    1. The spec asks for a view "visible only to the person who clicks", not only to the requester.
       Details matter "when something looks wrong", and a teammate is often the one who notices.
    2. Every channel member already sees the request and the reply in the thread. The channel's
       project connectors answer any member, so any member could have made the same calls.
    3. The modal never shows the request or response text, and IAM stops the ingress from reading
       them (R3). What it adds is tool names, redacted arguments (spec 013 FR-026), outcomes, gate
       decisions and usage.
    4. Slack has no notion of an AgentX administrator: admin rights come from OIDC claims on the
       CLI. So "admins" cannot be checked on a Slack click.
  - Accepted residual risk: a member who joins the channel later can open Details for older
    replies, just as they can scroll the thread. Each opening logs `interaction.details_opened`
    with the viewer's Slack user ID and `viewer: "requester" | "member"`, so an administrator can
    audit who looked.
  - If the owner prefers requester-only, the change is one comparison in `detailsActionHandler` and
    one message. See Open Questions.
- **R2. The button names its turn by `receivedAt#eventId`; the thread comes from the signed click.**
  - The value is exactly `turnRecordKeys(...).exportSk`, for example
    `2026-09-24T10:00:00.000Z#EvTURN00001`.
  - `parseDetailsButtonValue` accepts only that shape: at most 128 characters, a `receivedAt` that
    survives a `toISOString` round trip, and a Slack event ID.
  - The handler sets `pk = THREAD#<subject of the clicked message's thread>` and
    `sk = TURN#<value>`. A value can therefore only point inside the thread the member is looking
    at, whatever it says. After the read, the handler checks that the record's `subject`,
    `eventId`, `receivedAt` and team match. Any disagreement is refused with the same message as a
    missing record.
  - There is no HMAC on the value. Slack signs the whole request (14c part 2 refuses anything
    else), and only AgentX's app can post buttons that reach AgentX's endpoint. Anyone holding the
    signing secret could also forge an HMAC made from the same secret.
- **R3. The ingress Lambda reads the record, with one least-privilege `GetItem`.**
  - `views.open` must use the `trigger_id` within 3 seconds, and only the interactivity request
    has it. The Slack service is a queue consumer that is seconds away, and it must stay PutItem-only.
    Sending the read through the broker would need a new service caller, a second Lambda hop and a
    change to broker authorization.
  - So the ingress role gets exactly one statement on `TurnRecords`:
    - `dynamodb:GetItem` on the table ARN only, never an index. There is no Query or Scan, so it
      cannot list a thread's turns.
    - `ForAllValues:StringLike` `dynamodb:LeadingKeys` `THREAD#*`.
    - `ForAllValues:StringEquals` `dynamodb:Attributes` = `TURN_DETAILS_READ_ATTRIBUTES`, which is
      the table and index keys plus the 17 attributes in `TURN_DETAILS_ATTRIBUTES`.
    - `StringEqualsIfExists` `dynamodb:Select` `SPECIFIC_ATTRIBUTES`.
  - `requestText`, `responseText`, `textTruncated`, `workspaceId`, `conversationId`,
    `settingsRevision`, `manifestHash`, `workerOperations`, `startedAt`, `finishedAt` and
    `stopReason` are unreadable to it.
  - The reader always sends a `ProjectionExpression` of exactly `TURN_DETAILS_ATTRIBUTES`, with
    `ConsistentRead: true` and a 1-second timeout.
  - A contract test keeps the infra list, which is a literal because `infra` does not depend on
    `@agentx/contracts`, equal to the contracts list.
- **R4. The button goes on the last chunk of a reply that followed at least one tool call, only
  when the turn's record will be written.** That means a `turnRecords` sink and a recorder exist.
  Replies that fail (`disposition: "failed"`) carry it too, because that is when details help most.
  Progress messages, confirmations, limit and workspace messages never carry it. Slack renders
  blocks instead of `text`, so the chunk is carried in `section` blocks of at most 3,000
  characters, and `text` stays as the notification fallback. If Slack refuses the blocks, the chunk
  is posted as plain text and `reply.details_failed` is logged.
- **R5. What the modal shows:**
  - who asked (a mention, which never notifies inside a modal);
  - when, as a Slack date token;
  - the disposition and duration, and the model;
  - how many tools were offered, how many calls were made, and token usage and cost;
  - notes for a failed turn, an empty answer, omitted arguments, recording errors, or calls
    dropped past 50;
  - for each call: tool, connector, outcome, duration, validation, reason, the gate decision if
    recorded, and the redacted arguments in a code block.
  - It never shows request or response text, and it contains no links. Every piece of
    record-derived text has `&`, `<` and `>` escaped, and every text object sets `verbatim: true`,
    so nothing in a record becomes a link, mention or channel alert.
- **R6. Gate decisions are shown when the record has them.** 14c part 2 names "gate decisions in
  turn records" as a follow-up: `TurnCall.gate = { outcome, source, kind?, rule?, reason }`, with
  `reason` of at most 200 characters. `TurnDetailsSchema` reads `calls[].gate` as unknown, and the
  view parses it with its own lenient `DetailsGateSchema`. A matching decision is shown as one
  line. A differently shaped one says "a decision was recorded in a form this view cannot show",
  and the view still opens. With no `gate` field, the line is left out.
- **R7. Slack limits, with named constants and a test:**
  - title: at most 24 characters ("Turn details");
  - blocks: at most 100 per modal;
  - section text: at most 3,000 characters;
  - per-call arguments: `clamp(30,000 / calls, 200, 2,000)` characters after escaping;
  - total text: under 100,000 characters.
  - Cuts never split an escape or a surrogate pair, and they end with `… [cut to fit]`. Backticks
    in arguments get a zero-width space after them, so a record cannot close the code block early.
- **R8. Messages the modal can show instead of details.** These are constants in `slack-details.ts`:

  | Case | Message |
  |---|---|
  | Malformed value, or a record that disagrees with its key | `DETAILS_NOT_FOUND` |
  | Past 30 days, or past `expiresAt` | `detailsExpiredText` |
  | No record within 60 seconds of the reply | `DETAILS_SAVING` |
  | No record after that | `DETAILS_NOT_SAVED` |
  | Record fails its schema | `DETAILS_UNREADABLE` |
  | Read error or timeout | `DETAILS_UNAVAILABLE` |
  | `views.open` fails | `DETAILS_OPEN_FAILED`, through `response_url` |

  The 60 seconds are measured from the clicked message's own Slack timestamp, not from
  `receivedAt`, because a long turn posts its reply minutes after it was received.

## Slack App Settings and Rollout

1. **Runtime (`AgentXProductionRuntime`).** No behaviour change. The image is rebuilt only because
   `@agentx/contracts` changed.
2. **Control plane (`AgentXControlPlane`).** The ingress Lambda gains the Details handler, the
   `GetItem` grant and `TURN_RECORDS_TABLE_NAME`. It stays dormant, because no message has a
   Details button yet. Check the grant with the IAM policy simulator. It must allow the Details
   attributes and refuse `requestText`:

   ```bash
   ROLE=$(aws lambda get-function-configuration --function-name <SlackIngress function name> --query Role --output text)
   TABLE=$(aws dynamodb describe-table --table-name <TurnRecordsTableName output> --query Table.TableArn --output text)
   aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
     --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
       "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,eventId,calls,ContextKeyType=stringList" \
     --query 'EvaluationResults[0].EvalDecision'    # "allowed"
   aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
     --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
       "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,requestText,ContextKeyType=stringList" \
     --query 'EvaluationResults[0].EvalDecision'    # "implicitDeny"
   ```

3. **Slack app.** No change. 14c part 2 already turned Interactivity on, with the Request URL set
   to `SlackInteractivityUrl`. `views.open` needs no OAuth scope.
4. **Slack service (`AgentXSlackOrchestrator`).** From here, replies that follow tool calls carry
   **Details**. Smoke test: in a bound channel, ask "what's open in Linear?". Click **Details** as
   yourself and as a second member. Both see the modal, and nothing new appears in the thread.
5. **Rollback.** Roll back the Slack service first: new replies lose the button, and buttons
   already posted keep working. Do not roll the control plane back below 14d while replies with
   buttons are less than 30 days old. 14c part 2's endpoint only logs an unknown action
   (`interaction.ignored`), so a click would show the member nothing (see Open Questions).

---

### Task 1: Characterize reply posting and turn recording

Pins, on the code before this phase, how the processor posts a reply and what it records. It
passes before any code changes. Later tasks never pass the new `postWithBlocks` dependency to
these tests, so they keep passing unchanged: without that dependency, nothing changes.

**Files:**
- Create: `tests/contract/slack-reply-characterization.test.ts`

**Interfaces:**
- Consumes: `processSlackRequest`, `ProcessorDependencies`, `TurnInput` (processor after 14a to
  14c part 2), `slackReplyText` (14a), `DynamoTurnRecordWriter`, `FakeDynamoDb`,
  `splitSlackMessage`.
- Produces: nothing new.

- [ ] **Step 1: Confirm the base has every anchor this plan edits**

Run:
```bash
git log --oneline -1 && \
grep -c "for (const chunk of splitSlackMessage(slackReplyText(response))) await post(chunk);" packages/slack-service/src/processor.ts && \
grep -c "^async function slackApi" packages/broker/src/aws/slack-interactivity.ts && \
grep -c "respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text)," packages/broker/src/aws/slack-interactivity.ts && \
grep -c "postConfirmation: (thread, confirmation, text) => postToSlack(" packages/slack-service/src/main.ts && \
grep -c "slackSecret.grantRead(slackIngress);" infra/lib/control-plane.ts && \
grep -c 'role.startsWith("SlackOrchestratorTaskRole") || role.startsWith("BrokerServiceRole")' tests/contract/turn-records-infrastructure.test.ts
```
Expected: the merge commit of 14c part 2, then `1` six times. If any count is not `1`, stop and
report which anchor moved; do not guess a new one.

- [ ] **Step 2: Write the characterization test**

```ts
// tests/contract/slack-reply-characterization.test.ts
// Pins how the Slack processor posts a turn's reply and what it records, before spec 014 phase 14d
// adds the Details button. The harness never passes postWithBlocks, so these hold afterwards too.
import { describe, expect, it, vi } from "vitest";
import { splitSlackMessage, type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";
import { DynamoTurnRecordWriter } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const message: SlackRequestMessage = {
  version: 1, eventId: "EvCHAR000001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
  text: "list open items",
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding.",
};
const longReply = Array.from({ length: 3 }, (_, index) => `Part ${index}: ${"word ".repeat(700)}`).join("\n");

function turnWithCall(response: string | Error) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.offer({ manifest: "m", tools: [{ name: "tracker__list_items", description: "d" }], connectorOf: new Map([["tracker__list_items", "tracker"]]), model: { provider: "p", modelId: "m" } });
    input.recorder?.toolStarted({ toolCallId: "c1", toolName: "tracker__list_items", args: { state: "OPEN" } });
    input.recorder?.toolEnded({ toolCallId: "c1", toolName: "tracker__list_items", isError: false,
      result: { content: [{ type: "text", text: JSON.stringify({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }) }] } });
    if (response instanceof Error) throw response;
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function turnWithoutCalls(response: string) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function harness(runTurn: (input: TurnInput) => Promise<string>) {
  const db = new FakeDynamoDb();
  const posts: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => workspace,
      startClose: async () => ({ outcome: "NOT_FOUND" }),
      completeClose: vi.fn(), waitForOperation: vi.fn(),
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({ workspaceId, conversationId }),
      saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
    },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
    turnRecords: new DynamoTurnRecordWriter(db as never, "turns"),
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  return { dependencies, posts, stored };
}

describe("reply posting and recording before the Details button (spec 014 phase 14d)", () => {
  it("posts each chunk of a long reply as text, in order, as the last messages of the turn", async () => {
    const { dependencies, posts } = harness(turnWithCall(longReply));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    const chunks = splitSlackMessage(slackReplyText(longReply));
    expect(chunks.length).toBeGreaterThan(1);
    expect(posts.slice(-chunks.length)).toEqual(chunks);
  });

  it("posts the same messages whether or not the turn called tools", async () => {
    const withCall = harness(turnWithCall("Nothing is open."));
    const withoutCalls = harness(turnWithoutCalls("Nothing is open."));
    await processSlackRequest(message, withCall.dependencies, { finalAttempt: false });
    await processSlackRequest(message, withoutCalls.dependencies, { finalAttempt: false });
    expect(withCall.posts).toEqual(withoutCalls.posts);
    expect(withCall.posts.at(-1)).toBe("Nothing is open.");
  });

  it("records the reply under the key a Details button will name", async () => {
    const { dependencies, stored } = harness(turnWithCall("Nothing is open."));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({
      pk: "THREAD#T0123456789/C0123456789/1695500000.000001",
      sk: "TURN#2026-09-24T10:00:00.000Z#EvCHAR000001",
      responseText: "Nothing is open.",
      calls: [expect.objectContaining({ name: "tracker__list_items", outcome: "SUCCEEDED" })],
    });
  });

  it("posts and records a turn that fails after a tool call", async () => {
    const { dependencies, posts, stored } = harness(turnWithCall(new Error("model down")));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("AgentX could not complete the request: model down");
    expect(stored()[0]).toMatchObject({ disposition: "failed", calls: [expect.objectContaining({ name: "tracker__list_items" })] });
  });
});
```

- [ ] **Step 3: Run it and watch it pass on the unchanged code**

Run: `npm run build && npx vitest run tests/contract/slack-reply-characterization.test.ts`
Expected: PASS, 4 tests. If one fails, the base differs from what this plan assumes; stop and
report the failing assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/contract/slack-reply-characterization.test.ts
git commit -m "test(slack): characterize reply posting and turn recording before the Details button

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The Details contract

**Files:**
- Create: `packages/contracts/src/slack-details.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contract/slack-details-contract.test.ts`

**Interfaces:**
- Consumes: `TurnCallSchema`, `TurnRecordSchema`, `TURN_CALL_LIMIT`, `TURN_RETENTION_DAYS`,
  `turnRecordKeys` (`turns.ts`).
- Produces (all exported from `@agentx/contracts`):
  - `DETAILS_ACTION = "agentx_details"`, `DETAILS_BLOCK_ID = "agentx_details"`,
    `SLACK_SECTION_TEXT_LIMIT = 3_000`
  - `interface DetailsReference { receivedAt: string; eventId: string }`
  - `detailsButtonValue(reference: DetailsReference): string | undefined`
  - `parseDetailsButtonValue(value: string): DetailsReference | undefined`
  - `turnDetailsKey(subject: string, reference: DetailsReference): { pk: string; sk: string }`
  - `detailsExpireAt(reference: DetailsReference): number` (epoch milliseconds)
  - `splitSectionText(text: string, limit?: number): string[]`
  - `detailsReplyBlocks(text: string, value: string): unknown[]`
  - `TURN_DETAILS_ATTRIBUTES: readonly string[]` (17 names)
  - `DetailsGateSchema`, `type DetailsGate`
  - `TurnDetailsCallSchema`, `type TurnDetailsCall`, `TurnDetailsSchema`, `type TurnDetails`
  - `turnDetailsFromItem(item: Record<string, unknown>): { ok: true; details: TurnDetails } | { ok: false; fields: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/slack-details-contract.test.ts
import { describe, expect, it } from "vitest";
import {
  DETAILS_ACTION,
  SLACK_SECTION_TEXT_LIMIT,
  TURN_DETAILS_ATTRIBUTES,
  TurnDetailsSchema,
  TurnRecordSchema,
  detailsButtonValue,
  detailsExpireAt,
  detailsReplyBlocks,
  parseDetailsButtonValue,
  splitSectionText,
  turnDetailsFromItem,
  turnDetailsKey,
  turnRecordKeys,
} from "../../packages/contracts/src/index.js";

const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const reference = { receivedAt: "2026-09-24T10:00:00.000Z", eventId: "EvTURN00001" };
const record = TurnRecordSchema.parse({
  ...reference, subject, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0123456789" },
  disposition: "answered", startedAt: reference.receivedAt, finishedAt: "2026-09-24T10:00:12.300Z", durationMs: 12_300,
  requestText: "close TRK-9", responseText: "Closed TRK-9.", offeredTools: [],
  calls: [{ name: "tracker__close_item", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 800 }],
  emptyResponse: false, workerOperations: [],
});

describe("the Details contract (spec 014 FR-024)", () => {
  it("names a turn by its receive time and event ID, which is the record's key without the thread", () => {
    const value = detailsButtonValue(reference);
    expect(value).toBe("2026-09-24T10:00:00.000Z#EvTURN00001");
    expect(value).toBe(turnRecordKeys(record).exportSk);
    expect(parseDetailsButtonValue(value!)).toEqual(reference);
  });

  it("refuses a value that is not exactly one turn reference", () => {
    for (const value of [
      "", "EvTURN00001", "2026-09-24T10:00:00.000Z", "2026-09-24T10:00:00Z#EvTURN00001",
      "2026-09-24T10:00:00.000+01:00#EvTURN00001", "2026-02-31T10:00:00.000Z#EvTURN00001",
      "2026-09-24T10:00:00.000Z#EvTURN00001#TURN#x", "2026-09-24T10:00:00.000Z#Ev!!", `2026-09-24T10:00:00.000Z#Ev${"a".repeat(65)}`,
      "THREAD#T0BSHLLUGBD/C0999999999/1695500000.000009", "x".repeat(2_000),
    ]) expect(parseDetailsButtonValue(value), value).toBeUndefined();
    expect(detailsButtonValue({ receivedAt: "yesterday", eventId: "EvTURN00001" })).toBeUndefined();
  });

  it("builds the record key from the clicked thread and the value, the key the Slack service writes", () => {
    const keys = turnRecordKeys(record);
    expect(turnDetailsKey(subject, reference)).toEqual({ pk: keys.pk, sk: keys.sk });
    expect(detailsExpireAt(reference)).toBe(keys.expiresAt * 1_000);
  });

  it("carries a reply in sections of at most 3,000 characters with one Details button after them", () => {
    expect(detailsReplyBlocks("Closed TRK-9.", "2026-09-24T10:00:00.000Z#EvTURN00001")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Closed TRK-9." } },
      { type: "actions", block_id: "agentx_details", elements: [
        { type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value: "2026-09-24T10:00:00.000Z#EvTURN00001" },
      ] },
    ]);
    const long = `${"a".repeat(2_000)}\n${"b".repeat(1_400)}`;
    expect(splitSectionText(long)).toEqual(["a".repeat(2_000), "b".repeat(1_400)]);
    const solid = "😀".repeat(1_750);
    const parts = splitSectionText(solid);
    expect(parts.join("")).toBe(solid);
    expect(parts.every((part) => part.length <= SLACK_SECTION_TEXT_LIMIT && !/[\ud800-\udbff]$/.test(part))).toBe(true);
    expect(splitSectionText("")).toEqual([" "]);
  });

  it("lets the view read only what it shows: never request or response text, the workspace or worker operations", () => {
    expect([...TURN_DETAILS_ATTRIBUTES].sort()).toEqual([...Object.keys(TurnDetailsSchema.shape), "expiresAt"].sort());
    for (const name of TURN_DETAILS_ATTRIBUTES) {
      if (name !== "expiresAt") expect(Object.keys(TurnRecordSchema.shape), name).toContain(name);
    }
    for (const name of ["requestText", "responseText", "textTruncated", "workspaceId", "conversationId", "settingsRevision", "manifestHash", "workerOperations", "project"]) {
      expect(TURN_DETAILS_ATTRIBUTES).not.toContain(name);
    }
  });

  it("parses a stored record without its storage keys, keeps a gate decision as data, and names only top-level fields when it cannot", () => {
    const item = { ...turnRecordKeys(record), ...record, calls: [{ ...record.calls[0], gate: { outcome: "ask", source: "rule", reason: "closing always asks" } }] };
    const parsed = turnDetailsFromItem(item);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.details.calls[0]?.gate).toEqual({ outcome: "ask", source: "rule", reason: "closing always asks" });
    expect(parsed.details).not.toHaveProperty("requestText");
    expect(parsed.details).not.toHaveProperty("expiresAt");
    expect(turnDetailsFromItem({ ...item, calls: "not a list", eventId: "the secret plan" })).toEqual({ ok: false, fields: ["eventId", "calls"] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/contract/slack-details-contract.test.ts`
Expected: FAIL; `detailsButtonValue` and the other exports do not exist.

- [ ] **Step 3: Create `packages/contracts/src/slack-details.ts`**

```ts
import { z } from "zod";
import { TURN_CALL_LIMIT, TURN_RETENTION_DAYS, TurnCallSchema, TurnRecordSchema, turnRecordKeys } from "./turns.js";

/** The Details button's action ID (spec 014 FR-024), routed by the signed interactivity endpoint. */
export const DETAILS_ACTION = "agentx_details";
export const DETAILS_BLOCK_ID = "agentx_details";
/** Slack caps a section block's text at 3,000 characters. */
export const SLACK_SECTION_TEXT_LIMIT = 3_000;

const DETAILS_VALUE_LIMIT = 128;
const DETAILS_VALUE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(Ev[A-Za-z0-9]{4,64})$/;

/** Which turn a Details button names. The thread is never part of it: it comes from the clicked message. */
export interface DetailsReference {
  receivedAt: string;
  eventId: string;
}

/** The button's value: the record's sort key without `TURN#`, or undefined when the reference cannot be carried. */
export function detailsButtonValue(reference: DetailsReference): string | undefined {
  const value = `${reference.receivedAt}#${reference.eventId}`;
  return parseDetailsButtonValue(value) === undefined ? undefined : value;
}

/**
 * Reads a button value back, refusing anything but exactly one turn reference. `receivedAt` must be
 * the form toISOString writes, which is how the ingress stamps it; an impossible date such as
 * February 31 does not survive that round trip.
 */
export function parseDetailsButtonValue(value: string): DetailsReference | undefined {
  if (value.length > DETAILS_VALUE_LIMIT) return undefined;
  const match = DETAILS_VALUE.exec(value);
  if (!match) return undefined;
  const receivedAt = match[1] ?? "";
  const eventId = match[2] ?? "";
  const time = Date.parse(receivedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== receivedAt) return undefined;
  return { receivedAt, eventId };
}

/** The record's primary key: the clicked message's thread plus the button's reference. */
export function turnDetailsKey(subject: string, reference: DetailsReference): { pk: string; sk: string } {
  const keys = turnRecordKeys({ subject, ...reference });
  return { pk: keys.pk, sk: keys.sk };
}

/** When the record's TTL falls due, in epoch milliseconds: receivedAt plus TURN_RETENTION_DAYS. */
export function detailsExpireAt(reference: DetailsReference): number {
  return (Math.floor(Date.parse(reference.receivedAt) / 1_000) + TURN_RETENTION_DAYS * 86_400) * 1_000;
}

/** Splits text into section-sized parts, at a line break or space when one is near, never inside a surrogate pair. */
export function splitSectionText(text: string, limit = SLACK_SECTION_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let remaining = text.length > 0 ? text : " ";
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    let end = newline > limit / 2 ? newline : space > limit / 2 ? space : limit;
    const code = remaining.charCodeAt(end - 1);
    if (end === limit && code >= 0xd800 && code <= 0xdbff) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^[\n ]/, "");
  }
  parts.push(remaining);
  return parts;
}

/**
 * A reply chunk with a Details button under it. Slack shows blocks instead of `text` (which stays
 * the notification fallback), so the chunk is carried in sections.
 */
export function detailsReplyBlocks(text: string, value: string): unknown[] {
  return [
    ...splitSectionText(text).map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } })),
    { type: "actions", block_id: DETAILS_BLOCK_ID, elements: [
      { type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value },
    ] },
  ];
}

/**
 * The turn record attributes the Details view may read: what it shows or checks, never the request
 * or response text, the workspace or the worker operations. The ingress Lambda's IAM grant allows
 * exactly these plus the table and index keys (TURN_DETAILS_READ_ATTRIBUTES in
 * infra/lib/control-plane.ts; a contract test compares the two).
 */
export const TURN_DETAILS_ATTRIBUTES = [
  "eventId", "subject", "receivedAt", "requestedBy", "disposition", "durationMs", "model", "offeredTools", "calls",
  "callsTruncated", "emptyResponse", "usage", "usageError", "recordingErrors", "argumentsOmitted", "error", "expiresAt",
] as const;

/** A gate decision as the Details view shows it (spec 014 FR-021, recorded by 14c part 2's follow-up). Lenient on purpose. */
export const DetailsGateSchema = z.object({
  outcome: z.string().min(1).max(16),
  source: z.string().min(1).max(32),
  kind: z.string().max(32).optional(),
  rule: z.string().max(128).optional(),
  reason: z.string().max(200),
});

/** A recorded call; `gate` is read as data so a record with any gate shape still opens. */
export const TurnDetailsCallSchema = z.object({ ...TurnCallSchema.shape, gate: z.unknown().optional() });

const record = TurnRecordSchema.shape;

/** The part of a turn record the Details view reads, validated with the record's own field schemas. */
export const TurnDetailsSchema = z.object({
  eventId: record.eventId,
  subject: record.subject,
  receivedAt: record.receivedAt,
  requestedBy: record.requestedBy,
  disposition: record.disposition,
  durationMs: record.durationMs,
  model: record.model,
  offeredTools: record.offeredTools,
  calls: z.array(TurnDetailsCallSchema).max(TURN_CALL_LIMIT),
  callsTruncated: record.callsTruncated,
  emptyResponse: record.emptyResponse,
  usage: record.usage,
  usageError: record.usageError,
  recordingErrors: record.recordingErrors,
  argumentsOmitted: record.argumentsOmitted,
  error: record.error,
});

export type DetailsGate = z.infer<typeof DetailsGateSchema>;
export type TurnDetailsCall = z.infer<typeof TurnDetailsCallSchema>;
export type TurnDetails = z.infer<typeof TurnDetailsSchema>;

const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt"]);
const LOGGED_FIELD_LIMIT = 10;

/**
 * Parses a stored item for the Details view. When it cannot, it names top-level field names only:
 * issue messages and nested paths can quote stored values.
 */
export function turnDetailsFromItem(item: Record<string, unknown>): { ok: true; details: TurnDetails } | { ok: false; fields: string[] } {
  const parsed = TurnDetailsSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
  if (parsed.success) return { ok: true, details: parsed.data };
  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (fields.size >= LOGGED_FIELD_LIMIT) break;
    const field = issue.path[0];
    fields.add(typeof field === "string" && field in TurnDetailsSchema.shape ? field : "(root)");
  }
  return { ok: false, fields: [...fields] };
}
```

- [ ] **Step 4: Export it**

In `packages/contracts/src/index.ts`, directly after the line `export * from "./slack.js";`, add:

```ts
export * from "./slack-details.js";
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run build && npx vitest run tests/contract/slack-details-contract.test.ts tests/contract/turn-record-contract.test.ts && npx eslint packages/contracts/src tests/contract/slack-details-contract.test.ts`
Expected: PASS; no lint output. If the order of `fields` in the last assertion differs, check
that Zod reports issues in shape order (`eventId` before `calls`), and fix the implementation,
never the expected value.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/slack-details.ts packages/contracts/src/index.ts tests/contract/slack-details-contract.test.ts
git commit -m "feat(contracts): Details button value, record key and the turn fields the view may read

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The modal, within Slack's limits

**Files:**
- Create: `packages/broker/src/aws/slack-details-view.ts`
- Test: `tests/contract/slack-details-view.test.ts`

**Interfaces:**
- Consumes: `DetailsGateSchema`, `TurnDetails`, `TurnDetailsCall` (Task 2).
- Produces:
  - `interface SlackModalView { type: "modal"; title: PlainText; close: PlainText; blocks: DetailsBlock[] }`
  - `type DetailsBlock = { type: "section"; text: MrkdwnText } | { type: "context"; elements: MrkdwnText[] } | { type: "divider" }`
  - `turnDetailsView(details: TurnDetails): SlackModalView`
  - `detailsMessageView(text: string): SlackModalView`
  - `escapeSlack(text: string): string`, `fitEscaped(raw: string, limit: number): string`
  - constants `DETAILS_TITLE`, `MODAL_BLOCK_LIMIT = 100`, `SECTION_TEXT_LIMIT = 3_000`,
    `DETAILS_TEXT_CEILING = 100_000`, `CUT_MARKER = "… [cut to fit]"`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/slack-details-view.test.ts
import { describe, expect, it } from "vitest";
import { TurnDetailsSchema, type TurnDetails } from "../../packages/contracts/src/index.js";
import {
  CUT_MARKER,
  DETAILS_TEXT_CEILING,
  MODAL_BLOCK_LIMIT,
  SECTION_TEXT_LIMIT,
  detailsMessageView,
  turnDetailsView,
  type SlackModalView,
} from "../../packages/broker/src/aws/slack-details-view.js";

function call(overrides: Record<string, unknown> = {}) {
  return {
    name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32),
    validation: "ok", outcome: "SUCCEEDED", durationMs: 800, ...overrides,
  };
}

const base = {
  eventId: "EvTURN00001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
  requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0123456789" }, disposition: "answered", durationMs: 12_300,
  model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
  offeredTools: [{ name: "tracker__list_items", descriptionHash: "a".repeat(64) }, { name: "tracker__close_item", descriptionHash: "c".repeat(64) }],
  calls: [call()], emptyResponse: false,
  usage: {
    schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", cacheRetention: "short",
    tokens: { input: 12_345, output: 678, cacheRead: 1_000, cacheWrite: 0, total: 14_023 }, cacheReadRatio: 0.07, costUsd: 0.0123,
  },
};

function details(overrides: Record<string, unknown> = {}): TurnDetails {
  return TurnDetailsSchema.parse({ ...base, ...overrides });
}

function texts(view: SlackModalView): string[] {
  return view.blocks.flatMap((block) => block.type === "section" ? [block.text.text] : block.type === "context" ? block.elements.map((element) => element.text) : []);
}

function expectWithinSlackLimits(view: SlackModalView): void {
  expect(view.title.text.length).toBeLessThanOrEqual(24);
  expect(view.close.text.length).toBeLessThanOrEqual(24);
  expect(view.blocks.length).toBeLessThanOrEqual(MODAL_BLOCK_LIMIT);
  for (const block of view.blocks) {
    if (block.type === "section") expect(block.text.text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
    if (block.type === "context") expect(block.elements.length).toBeLessThanOrEqual(10);
  }
  for (const text of texts(view)) expect(text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
  expect(texts(view).join("").length).toBeLessThan(DETAILS_TEXT_CEILING);
}

describe("the Details modal (spec 014 FR-024)", () => {
  it("summarizes who asked, when, the result, the model, the tools offered and usage", () => {
    const view = turnDetailsView(details());
    expectWithinSlackLimits(view);
    expect(view.title.text).toBe("Turn details");
    const all = texts(view).join("\n");
    expect(all).toContain("*Requested by* <@U0123456789>");
    expect(all).toContain("*Received* <!date^1790244000^{date_short_pretty} at {time}|2026-09-24T10:00:00.000Z>");
    expect(all).toContain("*Result* answered, in 12.3 s");
    expect(all).toContain("*Model* amazon-bedrock / amazon.nova-pro-v1:0");
    expect(all).toContain("*Tools offered* 2");
    expect(all).toContain("*Tool calls* 1");
    expect(all).toContain("*Usage* 12,345 input, 678 output, 1,000 cache-read tokens; $0.0123");
  });

  it("lists each call with its tool, connector, outcome, duration, validation, reason and redacted arguments", () => {
    const view = turnDetailsView(details({ calls: [call(), call({ name: "tracker__save_item", validation: "schema_error", outcome: "FAILED", reason: "schema_changed", durationMs: 100 })] }));
    const all = texts(view).join("\n");
    expect(all).toContain("*1.* `tracker__close_item` · tracker\nsucceeded in 0.8 s\n```{\"id\":\"TRK-9\"}```");
    expect(all).toContain("*2.* `tracker__save_item` · tracker\nfailed in 0.1 s · validation schema_error · reason schema_changed");
  });

  it("shows a gate decision when the record has one, and says so when it cannot", () => {
    const shown = texts(turnDetailsView(details({ calls: [call({ gate: { outcome: "ask", source: "rule", kind: "destructive", reason: "closing always asks" } })] }))).join("\n");
    expect(shown).toContain("Gate: ask (rule, destructive): closing always asks");
    const odd = texts(turnDetailsView(details({ calls: [call({ gate: { decided: true } })] }))).join("\n");
    expect(odd).toContain("Gate: a decision was recorded in a form this view cannot show.");
    expect(texts(turnDetailsView(details())).join("\n")).not.toContain("Gate:");
  });

  it("escapes record text so nothing in it links, mentions or notifies, and keeps each code block closed", () => {
    const hostile = JSON.stringify({ body: "<!channel> see <https://evil.example|here> & ```rm -rf```" });
    const view = turnDetailsView(details({ calls: [call({ arguments: hostile, reason: "<@U0999999999>" })] }));
    const section = texts(view).find((text) => text.includes("tracker__close_item"))!;
    expect(section).not.toContain("<!channel>");
    expect(section).not.toContain("<https://evil");
    expect(section).not.toContain("<@U0999999999>");
    expect(section).toContain("&lt;!channel&gt;");
    expect(section).toContain("&amp;");
    expect(section.split("```").length - 1).toBe(2);
    for (const block of view.blocks) {
      if (block.type === "section") expect(block.text.verbatim).toBe(true);
      if (block.type === "context") expect(block.elements.every((element) => element.verbatim)).toBe(true);
    }
  });

  it("fits the largest record there can be into one modal, lists every call, and marks what it cut", () => {
    const calls = Array.from({ length: 50 }, (_, index) => call({
      name: `${"x".repeat(120)}_${index}`, connector: "c".repeat(20), arguments: "<&`".repeat(682), reason: "r".repeat(64),
      validation: "schema_error", outcome: "FAILED", gate: { outcome: "ask", source: "classifier", reason: "<".repeat(200) },
    }));
    const view = turnDetailsView(details({
      calls, callsTruncated: true, argumentsOmitted: false, recordingErrors: Array.from({ length: 8 }, () => "<".repeat(64)),
      error: { name: "<".repeat(128), code: "&".repeat(64) },
    }));
    expectWithinSlackLimits(view);
    const all = texts(view).join("\n");
    expect(all).toContain(CUT_MARKER);
    for (let number = 1; number <= 50; number += 1) expect(all).toContain(`*${number}.*`);
  });

  it("says when calls were dropped, arguments omitted, recording failed, the turn failed or usage is missing", () => {
    const all = texts(turnDetailsView(details({
      callsTruncated: true, argumentsOmitted: true, calls: [call({ arguments: "[omitted]" })], emptyResponse: true,
      recordingErrors: ["handler_failed:tool_execution_end"], error: { name: "AgentXError", code: "RUNTIME_UNAVAILABLE" },
      usage: undefined, usageError: "stats unavailable",
    }))).join("\n");
    expect(all).toContain("*Tool calls* 1 (the turn made more; only the first 1 were kept)");
    expect(all).toContain("The turn failed: AgentXError (RUNTIME_UNAVAILABLE).");
    expect(all).toContain("The model returned no text.");
    expect(all).toContain("Every call's arguments were left out to fit the record's storage limit.");
    expect(all).toContain("Part of this turn could not be recorded: handler_failed:tool_execution_end.");
    expect(all).toContain("_Arguments left out to fit storage._");
    expect(all).toContain("*Usage* could not be read");
    expect(texts(turnDetailsView(details({ usage: undefined }))).join("\n")).toContain("*Usage* not recorded");
  });

  it("says when the turn made no tool calls, and shows a message on its own", () => {
    expect(texts(turnDetailsView(details({ calls: [] }))).join("\n")).toContain("This turn made no tool calls.");
    const view = detailsMessageView("AgentX couldn't find the details for this reply.");
    expectWithinSlackLimits(view);
    expect(view.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "AgentX couldn't find the details for this reply.", verbatim: true } }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/contract/slack-details-view.test.ts`
Expected: FAIL; the module does not exist.

- [ ] **Step 3: Create `packages/broker/src/aws/slack-details-view.ts`**

```ts
import { DetailsGateSchema, type TurnDetails, type TurnDetailsCall } from "@agentx/contracts";

export interface PlainText { type: "plain_text"; text: string }
/** verbatim: Slack does not turn bare URLs, channel names or mentions in record text into links. */
export interface MrkdwnText { type: "mrkdwn"; text: string; verbatim: true }
export type DetailsBlock =
  | { type: "section"; text: MrkdwnText }
  | { type: "context"; elements: MrkdwnText[] }
  | { type: "divider" };
export interface SlackModalView { type: "modal"; title: PlainText; close: PlainText; blocks: DetailsBlock[] }

export const DETAILS_TITLE = "Turn details";
/** Slack's limits for a modal: 100 blocks, 3,000 characters in a section's text. */
export const MODAL_BLOCK_LIMIT = 100;
export const SECTION_TEXT_LIMIT = 3_000;
/** Escaped argument characters shared by all calls, so 50 long calls still make a modest view. */
export const DETAILS_ARGUMENT_BUDGET = 30_000;
export const DETAILS_ARGUMENT_MIN = 200;
export const DETAILS_ARGUMENT_MAX = 2_000;
/** This view's own ceiling on all its text, well under anything Slack refuses. */
export const DETAILS_TEXT_CEILING = 100_000;
export const CUT_MARKER = "… [cut to fit]";
const NOTES_LIMIT = 2_000;
const OMITTED_ARGUMENTS = "[omitted]";

const DISPOSITIONS: Record<TurnDetails["disposition"], string> = {
  answered: "answered",
  failed: "failed",
  abandoned: "abandoned after retries",
  workspace_close: "workspace close",
  workspace_limit: "workspace limit reached",
  workspace_closed: "workspace already closed",
  workspace_unavailable: "workspace unavailable",
};

/** Slack's three control characters; after this, record text cannot form a link, mention or alert. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes, then fits `limit` characters, never cutting inside an escape or a surrogate pair; marks a cut. */
export function fitEscaped(raw: string, limit: number): string {
  const escaped = escapeSlack(raw);
  if (escaped.length <= limit) return escaped;
  const room = limit - CUT_MARKER.length;
  let fitted = "";
  for (const character of raw) {
    const piece = escapeSlack(character);
    if (fitted.length + piece.length > room) break;
    fitted += piece;
  }
  return `${fitted}${CUT_MARKER}`;
}

/** The turn's details as a modal (spec 014 FR-024). Pure: every string from the record is escaped here. */
export function turnDetailsView(details: TurnDetails): SlackModalView {
  const head: DetailsBlock[] = [section(summary(details)), section(stats(details))];
  const notes = noteLines(details);
  if (notes.length > 0) head.push(context(fitEscaped(notes.join("\n"), NOTES_LIMIT)));
  head.push({ type: "divider" });
  const room = MODAL_BLOCK_LIMIT - head.length - 1;
  const shown = details.calls.slice(0, room);
  const budget = Math.min(DETAILS_ARGUMENT_MAX, Math.max(DETAILS_ARGUMENT_MIN, Math.floor(DETAILS_ARGUMENT_BUDGET / Math.max(1, shown.length))));
  const blocks: DetailsBlock[] = [...head, ...shown.map((call, index) => section(callText(call, index + 1, budget)))];
  if (details.calls.length === 0) blocks.push(context("This turn made no tool calls."));
  else if (shown.length < details.calls.length) blocks.push(context(`${details.calls.length - shown.length} more calls are not shown.`));
  return modal(blocks);
}

/** A modal holding one message, for every case where there are no details to show. */
export function detailsMessageView(text: string): SlackModalView {
  return modal([section(text)]);
}

function modal(blocks: DetailsBlock[]): SlackModalView {
  return { type: "modal", title: { type: "plain_text", text: DETAILS_TITLE }, close: { type: "plain_text", text: "Close" }, blocks };
}

function section(text: string): DetailsBlock {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

function context(text: string): DetailsBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] };
}

function summary(details: TurnDetails): string {
  // userId and receivedAt passed their schemas (Slack ID, ISO time), so they cannot carry markup.
  const seconds = Math.floor(Date.parse(details.receivedAt) / 1_000);
  const lines = [
    `*Requested by* <@${details.requestedBy.userId}>`,
    `*Received* <!date^${seconds}^{date_short_pretty} at {time}|${details.receivedAt}>`,
    `*Result* ${DISPOSITIONS[details.disposition]}, in ${formatSeconds(details.durationMs)}`,
  ];
  if (details.model !== undefined) lines.push(`*Model* ${fitEscaped(`${details.model.provider} / ${details.model.modelId}`, 400)}`);
  return lines.join("\n");
}

function stats(details: TurnDetails): string {
  const calls = details.callsTruncated
    ? `${details.calls.length} (the turn made more; only the first ${details.calls.length} were kept)`
    : String(details.calls.length);
  return [`*Tools offered* ${details.offeredTools.length}`, `*Tool calls* ${calls}`, `*Usage* ${usage(details)}`].join("\n");
}

function usage(details: TurnDetails): string {
  if (details.usage !== undefined) {
    const tokens = details.usage.tokens;
    return `${count(tokens.input)} input, ${count(tokens.output)} output, ${count(tokens.cacheRead)} cache-read tokens; $${details.usage.costUsd.toFixed(4)}`;
  }
  return details.usageError === undefined ? "not recorded" : "could not be read";
}

/** Raw lines; the caller escapes and fits them together. */
function noteLines(details: TurnDetails): string[] {
  const lines: string[] = [];
  if (details.error !== undefined) lines.push(`The turn failed: ${details.error.name}${details.error.code === undefined ? "" : ` (${details.error.code})`}.`);
  if (details.emptyResponse) lines.push("The model returned no text.");
  if (details.argumentsOmitted) lines.push("Every call's arguments were left out to fit the record's storage limit.");
  if (details.recordingErrors !== undefined && details.recordingErrors.length > 0) {
    lines.push(`Part of this turn could not be recorded: ${details.recordingErrors.join(", ")}.`);
  }
  return lines;
}

function callText(call: TurnDetailsCall, number: number, budget: number): string {
  const name = fitEscaped(call.name.replace(/`/g, "'"), 200);
  const lines = [`*${number}.* \`${name}\`${call.connector === undefined ? "" : ` · ${fitEscaped(call.connector, 60)}`}`];
  const facts = [`${call.outcome.toLowerCase().replace("_", " ")} in ${formatSeconds(call.durationMs)}`];
  if (call.validation !== "ok") facts.push(`validation ${call.validation}`);
  if (call.reason !== undefined) facts.push(`reason ${fitEscaped(call.reason, 100)}`);
  lines.push(facts.join(" · "));
  const gate = gateLine(call.gate);
  if (gate !== undefined) lines.push(gate);
  lines.push(call.arguments === OMITTED_ARGUMENTS
    ? "_Arguments left out to fit storage._"
    : `\`\`\`${fitEscaped(call.arguments.replace(/`/g, "`​"), budget)}\`\`\``);
  return lines.join("\n");
}

function gateLine(gate: unknown): string | undefined {
  if (gate === undefined) return undefined;
  const parsed = DetailsGateSchema.safeParse(gate);
  if (!parsed.success) return "Gate: a decision was recorded in a form this view cannot show.";
  const { outcome, source, kind, rule, reason } = parsed.data;
  const by = [source, kind, rule === undefined ? undefined : `rule ${rule}`].filter((part): part is string => part !== undefined).join(", ");
  return `Gate: ${fitEscaped(`${outcome} (${by}): ${reason}`, 300)}`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run build && npx vitest run tests/contract/slack-details-view.test.ts && npx eslint packages/broker/src/aws/slack-details-view.ts tests/contract/slack-details-view.test.ts`
Expected: PASS, 7 tests; no lint output.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/slack-details-view.ts tests/contract/slack-details-view.test.ts
git commit -m "feat(broker): Details modal built from a turn record within Slack's limits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Details handler on the interactivity endpoint

**Files:**
- Create: `packages/broker/src/aws/slack-details.ts`
- Modify: `packages/broker/src/aws/slack-interactivity.ts` (export `slackApi`; register the handler)
- Test: `tests/contract/slack-details.test.ts`

**Interfaces:**
- Consumes: from 14c part 2, `SlackActionHandler`, `SlackBlockAction`,
  `createSlackInteractivityHandler`, `respondEphemeral`, `slackApi` (now exported), and
  `createAwsSlackInteractivityHandler`'s `documentClient`, `secrets` and `log`; `SlackIngressLog`
  from `slack-ingress.ts`; Task 2 contracts; Task 3 `turnDetailsView`, `detailsMessageView` and
  `SlackModalView`.
- Produces:
  - `detailsActionHandler(dependencies: DetailsClickDependencies): SlackActionHandler`
  - `interface DetailsClickDependencies { readDetails(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>; openView(triggerId: string, view: SlackModalView): Promise<void>; respondEphemeral(responseUrl: string, text: string): Promise<void>; now?: () => number; log?: SlackIngressLog }`
  - `dynamoTurnDetailsReader(client, tableName, timeoutMs?)`
  - constants `DETAILS_READ_TIMEOUT_MS = 1_000`, `DETAILS_SAVE_GRACE_MS = 60_000`,
    `DETAILS_NOT_FOUND`, `DETAILS_SAVING`, `DETAILS_NOT_SAVED`, `DETAILS_UNREADABLE`,
    `DETAILS_UNAVAILABLE`, `DETAILS_OPEN_FAILED`, and `detailsExpiredText(receivedAt)`
  - the environment variable `TURN_RECORDS_TABLE_NAME` on the ingress Lambda (set in Task 5)

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/slack-details.test.ts
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DETAILS_ACTION,
  TURN_DETAILS_ATTRIBUTES,
  TurnRecordSchema,
  turnRecordKeys,
  type TurnRecord,
} from "../../packages/contracts/src/index.js";
import {
  DETAILS_NOT_FOUND,
  DETAILS_NOT_SAVED,
  DETAILS_OPEN_FAILED,
  DETAILS_SAVING,
  DETAILS_UNAVAILABLE,
  DETAILS_UNREADABLE,
  detailsActionHandler,
  detailsExpiredText,
  dynamoTurnDetailsReader,
} from "../../packages/broker/src/aws/slack-details.js";
import type { SlackModalView } from "../../packages/broker/src/aws/slack-details-view.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const requester = "U0123456789";
const other = "U0456789012";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = `${thread.teamId}/${thread.channelId}/${thread.threadTs}`;
const receivedAt = "2026-09-24T10:00:00.000Z";
const value = `${receivedAt}#EvTURN00001`;
const replyTs = "1790244060.000200"; // the reply, posted at 10:01:00Z
const repliedAt = 1_790_244_060_000;
const day = 86_400_000;

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return TurnRecordSchema.parse({
    eventId: "EvTURN00001", subject, receivedAt, requestedBy: { teamId: thread.teamId, userId: requester },
    disposition: "answered", startedAt: receivedAt, finishedAt: "2026-09-24T10:00:12.300Z", durationMs: 12_300,
    requestText: "close TRK-9, the secret plan", responseText: "Closed TRK-9, private answer",
    model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
    offeredTools: [{ name: "tracker__close_item", descriptionHash: "a".repeat(64) }],
    calls: [{ name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 800 }],
    emptyResponse: false, workerOperations: [], workspaceId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  });
}

function stored(record: TurnRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...turnRecordKeys(record), ...record, ...extra };
}

function payload(options: { user?: string; value?: string } = {}) {
  return {
    type: "block_actions",
    team: { id: thread.teamId },
    user: { id: options.user ?? requester, team_id: thread.teamId },
    container: { type: "message", message_ts: replyTs, channel_id: thread.channelId, thread_ts: thread.threadTs },
    message: { ts: replyTs, thread_ts: thread.threadTs, text: "Closed TRK-9." },
    response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc",
    trigger_id: "1.2.3",
    actions: [{ action_id: DETAILS_ACTION, value: options.value ?? value, block_id: "agentx_details" }],
  };
}

function signed(body: unknown, nowMs: number, signature?: string) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(body))}`;
  const timestamp = String(Math.floor(nowMs / 1_000));
  return {
    rawPath: "/v1/slack/interactions",
    body: raw,
    headers: {
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature ?? `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  };
}

/** A table that answers GetItem as DynamoDB does: only the projected attributes come back. */
function table(items: Array<Record<string, unknown>>, fail?: Error) {
  const commands: Array<Record<string, unknown>> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commands.push(command.input);
      if (fail) throw fail;
      const key = command.input.Key as { pk: string; sk: string };
      const item = items.find((entry) => entry.pk === key.pk && entry.sk === key.sk);
      if (item === undefined) return {};
      const names = command.input.ExpressionAttributeNames as Record<string, string>;
      const wanted = new Set(String(command.input.ProjectionExpression).split(", ").map((alias) => names[alias]));
      return { Item: Object.fromEntries(Object.entries(item).filter(([name]) => wanted.has(name))) };
    },
  };
  return { reader: dynamoTurnDetailsReader(client as never, "turns"), commands };
}

function harness(options: { items?: Array<Record<string, unknown>>; now?: number; failRead?: Error; failOpen?: Error } = {}) {
  const now = options.now ?? repliedAt + 3_600_000;
  const views: Array<{ triggerId: string; view: SlackModalView }> = [];
  const ephemeral: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); };
  const { reader, commands } = table(options.items ?? [stored(turn())], options.failRead);
  const handler = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    now: () => now,
    log,
    handlers: [detailsActionHandler({
      readDetails: reader,
      openView: async (triggerId, view) => { if (options.failOpen) throw options.failOpen; views.push({ triggerId, view }); },
      respondEphemeral: async (_url, text) => { ephemeral.push(text); },
      now: () => now,
      log,
    })],
  });
  const click = (body: unknown = payload()) => handler(signed(body, now));
  return { handler, click, views, ephemeral, logs, commands, now };
}

const shown = (view: SlackModalView | undefined) => JSON.stringify(view ?? {});

describe("the Details view (spec 014 FR-024, FR-025)", () => {
  it("refuses a Details click whose Slack signature does not verify, before reading anything", async () => {
    const { handler, commands, views, now } = harness();
    expect((await handler(signed(payload(), now, "v0=bad"))).statusCode).toBe(401);
    expect(commands).toHaveLength(0);
    expect(views).toHaveLength(0);
  });

  it("opens the turn's details for the requester who clicked, and posts nothing to the thread", async () => {
    const { click, views, ephemeral, logs } = harness();
    expect((await click()).statusCode).toBe(200);
    expect(views).toHaveLength(1);
    expect(views[0]!.triggerId).toBe("1.2.3");
    expect(views[0]!.view.title.text).toBe("Turn details");
    expect(shown(views[0]!.view)).toContain("tracker__close_item");
    expect(shown(views[0]!.view)).toContain("TRK-9");
    expect(ephemeral).toEqual([]);
    expect(logs).toContainEqual({ event: "interaction.details_opened", fields: { eventId: "EvTURN00001", viewerId: requester, viewer: "requester" } });
  });

  it("lets another member who can see the reply open it, never shows the request or response text, and logs who looked", async () => {
    const { click, views, logs, commands } = harness();
    await click(payload({ user: other }));
    expect(views).toHaveLength(1);
    expect(shown(views[0]!.view)).not.toContain("secret plan");
    expect(shown(views[0]!.view)).not.toContain("private answer");
    const names = Object.values(commands[0]!.ExpressionAttributeNames as Record<string, string>);
    expect(names).not.toContain("requestText");
    expect(names).not.toContain("responseText");
    expect(logs).toContainEqual({ event: "interaction.details_opened", fields: { eventId: "EvTURN00001", viewerId: other, viewer: "member" } });
  });

  it("reads only from the thread of the clicked message, so a forged value cannot reach another thread's turn", async () => {
    const elsewhere = turn({ eventId: "EvOTHER0001", subject: "T0BSHLLUGBD/C0999999999/1695500000.000009", requestText: "other thread secret" });
    const { click, views, commands } = harness({ items: [stored(turn()), stored(elsewhere)] });
    await click(payload({ value: `${receivedAt}#EvOTHER0001` }));
    expect(commands[0]!.Key).toEqual({ pk: `THREAD#${subject}`, sk: `TURN#${receivedAt}#EvOTHER0001` });
    expect(shown(views[0]!.view)).toContain(DETAILS_NOT_SAVED);
    expect(shown(views[0]!.view)).not.toContain("other thread secret");
  });

  it("refuses a malformed value without reading, and a record that disagrees with its key, with the same answer", async () => {
    for (const forged of ["", "THREAD#T0BSHLLUGBD/C0999999999/1695500000.000009", `${value}#TURN#x`, "x".repeat(2_000)]) {
      const { click, views, commands, logs } = harness();
      await click(payload({ value: forged }));
      expect(commands).toHaveLength(0);
      expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
      expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "malformed_value" } });
    }
    const tampered = { ...stored(turn()), subject: "T0BSHLLUGBD/C0999999999/1695500000.000009" };
    const { click, views, logs } = harness({ items: [tampered] });
    await click();
    expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "mismatch" } });
  });

  it("says the details are no longer kept after 30 days without reading, also before DynamoDB deletes the record, and opens them the day before", async () => {
    const late = harness({ now: Date.parse(receivedAt) + 30 * day });
    await late.click();
    expect(late.commands).toHaveLength(0);
    expect(shown(late.views[0]!.view)).toContain(detailsExpiredText(receivedAt));
    const lagging = harness({ items: [stored(turn(), { expiresAt: Math.floor((repliedAt + day) / 1_000) - 1 })], now: repliedAt + day });
    await lagging.click();
    expect(shown(lagging.views[0]!.view)).toContain(detailsExpiredText(receivedAt));
    const dayBefore = harness({ now: Date.parse(receivedAt) + 29 * day });
    await dayBefore.click();
    expect(shown(dayBefore.views[0]!.view)).toContain("tracker__close_item");
  });

  it("asks a member who clicks before the record is saved to try again, and says when it was never saved", async () => {
    const early = harness({ items: [], now: repliedAt + 10_000 });
    await early.click();
    expect(shown(early.views[0]!.view)).toContain(DETAILS_SAVING);
    expect(early.logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "not_saved_yet" } });
    const lost = harness({ items: [], now: repliedAt + 10 * 60_000 });
    await lost.click();
    expect(shown(lost.views[0]!.view)).toContain(DETAILS_NOT_SAVED);
    expect(lost.logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "not_found" } });
  });

  it("says so when the record cannot be read or parsed, and logs field names only", async () => {
    const down = harness({ failRead: Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" }) });
    await down.click();
    expect(shown(down.views[0]!.view)).toContain(DETAILS_UNAVAILABLE);
    expect(down.logs).toContainEqual({ event: "interaction.details_read_failed", fields: { errorName: "ProvisionedThroughputExceededException" } });
    const broken = harness({ items: [stored(turn(), { calls: "not a list", usageError: "the secret plan" })] });
    await broken.click();
    expect(shown(broken.views[0]!.view)).toContain(DETAILS_UNREADABLE);
    expect(broken.logs).toContainEqual({ event: "interaction.details_invalid", fields: { eventId: "EvTURN00001", fields: "calls" } });
    expect(JSON.stringify(broken.logs)).not.toContain("secret plan");
  });

  it("answers privately through response_url when the modal cannot open, such as after Slack's 3-second trigger window", async () => {
    const { click, ephemeral, logs } = harness({ failOpen: new Error("Slack views.open failed: expired_trigger_id") });
    await click();
    expect(ephemeral).toEqual([DETAILS_OPEN_FAILED]);
    expect(logs).toContainEqual({ event: "interaction.details_open_failed", fields: { errorName: "Error", slackError: "expired_trigger_id" } });
  });

  it("reads one record by its key, consistently, asking only for the attributes the view shows", async () => {
    const { click, commands } = harness();
    await click();
    expect(commands).toEqual([expect.objectContaining({
      TableName: "turns", Key: { pk: `THREAD#${subject}`, sk: `TURN#${value}` }, ConsistentRead: true,
    })]);
    const names = commands[0]!.ExpressionAttributeNames as Record<string, string>;
    expect(String(commands[0]!.ProjectionExpression).split(", ").map((alias) => names[alias])).toEqual([...TURN_DETAILS_ATTRIBUTES]);
  });

  it("is registered on the ingress Lambda's interactivity endpoint with the turn record table and views.open", () => {
    const source = readFileSync("packages/broker/src/aws/slack-interactivity.ts", "utf8");
    expect(source).toContain("detailsActionHandler({");
    expect(source).toContain('requiredEnvironment("TURN_RECORDS_TABLE_NAME")');
    expect(source).toContain('"views.open"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/contract/slack-details.test.ts`
Expected: FAIL; `slack-details.js` does not exist.

- [ ] **Step 3: Create `packages/broker/src/aws/slack-details.ts`**

```ts
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DETAILS_ACTION,
  TURN_DETAILS_ATTRIBUTES,
  TURN_RETENTION_DAYS,
  detailsExpireAt,
  parseDetailsButtonValue,
  slackThreadSubject,
  turnDetailsFromItem,
  turnDetailsKey,
} from "@agentx/contracts";
import { detailsMessageView, turnDetailsView, type SlackModalView } from "./slack-details-view.js";
import type { SlackIngressLog } from "./slack-ingress.js";
import type { SlackActionHandler, SlackBlockAction } from "./slack-interactivity.js";

/** A record read gives up after this long, so the modal still opens inside Slack's 3-second trigger window. */
export const DETAILS_READ_TIMEOUT_MS = 1_000;
/** The Slack service writes the record just after it posts the reply; a click this soon may beat the write. */
export const DETAILS_SAVE_GRACE_MS = 60_000;

export const DETAILS_NOT_FOUND = "AgentX couldn't find the details for this reply.";
export const DETAILS_SAVING = "The details for this reply are still being saved. Close this and press Details again in a moment.";
export const DETAILS_NOT_SAVED = "AgentX has no saved details for this reply. Saving them may have failed; an administrator can look for turn_record.write_failed in the Slack service logs.";
export const DETAILS_UNREADABLE = "The saved details for this reply could not be read. An administrator can export the turn with `agentx admin turns export`.";
export const DETAILS_UNAVAILABLE = "AgentX couldn't load the details right now. Close this and press Details again.";
export const DETAILS_OPEN_FAILED = "I couldn't open the details in time. Press Details again.";

export function detailsExpiredText(receivedAt: string): string {
  const seconds = Math.floor(Date.parse(receivedAt) / 1_000);
  return `AgentX keeps turn details for ${TURN_RETENTION_DAYS} days. The details for this reply, from <!date^${seconds}^{date_short}|${receivedAt.slice(0, 10)}>, are no longer kept.`;
}

export interface DetailsClickDependencies {
  /** One record by key, projected to TURN_DETAILS_ATTRIBUTES; undefined when there is none. */
  readDetails: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;
  openView: (triggerId: string, view: SlackModalView) => Promise<void>;
  respondEphemeral: (responseUrl: string, text: string) => Promise<void>;
  now?: () => number;
  log?: SlackIngressLog;
}

/**
 * The Details button (spec 014 FR-024). It opens a modal, for the member who clicked only, built
 * from the turn record of the reply the button is on. Any member who can see the reply may open it
 * (the plan's ruling R1). The record is looked up in the thread of the clicked message, never a
 * thread the button names, and nothing is posted to the thread. Every outcome the member can meet is
 * said in the modal, or privately through response_url when the modal cannot open. Log lines carry
 * IDs and categories, never record text.
 */
export function detailsActionHandler(dependencies: DetailsClickDependencies): SlackActionHandler {
  const now = dependencies.now ?? Date.now;
  const log: SlackIngressLog = dependencies.log ?? (() => undefined);

  const open = async (action: SlackBlockAction, view: SlackModalView): Promise<void> => {
    try {
      await dependencies.openView(action.triggerId, view);
    } catch (error) {
      log("interaction.details_open_failed", { errorName: errorName(error), slackError: slackError(error) });
      await dependencies.respondEphemeral(action.responseUrl, DETAILS_OPEN_FAILED);
    }
  };

  const refuse = async (action: SlackBlockAction, reason: string, text: string): Promise<void> => {
    log("interaction.details_refused", { reason, viewerId: action.userId });
    await open(action, detailsMessageView(text));
  };

  return {
    matches: (actionId) => actionId === DETAILS_ACTION,
    async handle(action) {
      const reference = parseDetailsButtonValue(action.value);
      if (reference === undefined) {
        await refuse(action, "malformed_value", DETAILS_NOT_FOUND);
        return;
      }
      if (now() >= detailsExpireAt(reference)) {
        await refuse(action, "expired", detailsExpiredText(reference.receivedAt));
        return;
      }
      const subject = slackThreadSubject(action.thread);
      let item: Record<string, unknown> | undefined;
      try {
        item = await dependencies.readDetails(turnDetailsKey(subject, reference));
      } catch (error) {
        log("interaction.details_read_failed", { errorName: errorName(error) });
        await open(action, detailsMessageView(DETAILS_UNAVAILABLE));
        return;
      }
      if (item === undefined) {
        // Measured from the reply itself: a long turn posts its reply minutes after receivedAt.
        const repliedAt = Number(action.messageTs) * 1_000;
        if (now() - repliedAt < DETAILS_SAVE_GRACE_MS) await refuse(action, "not_saved_yet", DETAILS_SAVING);
        else await refuse(action, "not_found", DETAILS_NOT_SAVED);
        return;
      }
      // DynamoDB deletes expired items up to 48 hours late; never show one.
      if (typeof item.expiresAt === "number" && item.expiresAt <= Math.floor(now() / 1_000)) {
        await refuse(action, "expired", detailsExpiredText(reference.receivedAt));
        return;
      }
      const parsed = turnDetailsFromItem(item);
      if (!parsed.ok) {
        log("interaction.details_invalid", { eventId: reference.eventId, fields: parsed.fields.join(",") });
        await open(action, detailsMessageView(DETAILS_UNREADABLE));
        return;
      }
      const details = parsed.details;
      // The key already binds thread and event; a record that disagrees with it is refused, never shown.
      if (details.subject !== subject || details.eventId !== reference.eventId || details.receivedAt !== reference.receivedAt
        || details.requestedBy.teamId !== action.thread.teamId) {
        await refuse(action, "mismatch", DETAILS_NOT_FOUND);
        return;
      }
      log("interaction.details_opened", {
        eventId: details.eventId, viewerId: action.userId, viewer: action.userId === details.requestedBy.userId ? "requester" : "member",
      });
      await open(action, turnDetailsView(details));
    },
  };
}

/**
 * Reads one turn record by key for the Details view: consistently, with a short deadline, and only
 * the attributes the view shows. The ingress's IAM grant allows exactly these (dynamodb:Attributes),
 * so asking for more is refused.
 */
export function dynamoTurnDetailsReader(client: Pick<DynamoDBDocumentClient, "send">, tableName: string, timeoutMs = DETAILS_READ_TIMEOUT_MS) {
  const names = Object.fromEntries(TURN_DETAILS_ATTRIBUTES.map((name, index) => [`#a${index}`, name]));
  const projection = Object.keys(names).join(", ");
  return async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> => {
    const response = await client.send(new GetCommand({
      TableName: tableName,
      Key: key,
      ConsistentRead: true,
      ProjectionExpression: projection,
      ExpressionAttributeNames: names,
    }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return response.Item as Record<string, unknown> | undefined;
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 128) : "unknown";
}

/** Slack's error code from slackApi's message ("Slack views.open failed: expired_trigger_id"); codes carry no user text. */
function slackError(error: unknown): string {
  const match = error instanceof Error ? /failed: ([a-z_]{1,64})$/.exec(error.message) : null;
  return match?.[1] ?? "none";
}
```

- [ ] **Step 4: Register it in `packages/broker/src/aws/slack-interactivity.ts`**

Export the Slack Web API helper. Replace:

```ts
async function slackApi(token: string, method: string, body: unknown, fetchImplementation: typeof fetch = fetch): Promise<void> {
```

with:

```ts
/** Calls one Slack Web API method with the bot token; throws "Slack <method> failed: <error>" on refusal. */
export async function slackApi(token: string, method: string, body: unknown, fetchImplementation: typeof fetch = fetch): Promise<void> {
```

After the `import { parseSlackSecrets, validSignature, ... } from "./slack-ingress.js";` line, add:

```ts
import { detailsActionHandler, dynamoTurnDetailsReader } from "./slack-details.js";
```

In `createAwsSlackInteractivityHandler`, after `const secretArn = requiredEnvironment("SLACK_SECRET_ARN");`, add:

```ts
  const turnRecordsTableName = requiredEnvironment("TURN_RECORDS_TABLE_NAME");
```

and replace the end of the `handlers` list:

```ts
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    })],
```

with:

```ts
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    }), detailsActionHandler({
      // Spec 014 FR-024: the Details view reads one turn record's non-text fields and opens a modal.
      readDetails: dynamoTurnDetailsReader(documentClient, turnRecordsTableName),
      openView: async (triggerId, view) => slackApi((await secrets()).botToken, "views.open", { trigger_id: triggerId, view }),
      respondEphemeral: (responseUrl, text) => respondEphemeral(responseUrl, text),
      log,
    })],
```

The two modules import each other: `slack-details.ts` imports only types from
`slack-interactivity.ts`, so the bundled Lambda has no runtime cycle.

- [ ] **Step 5: Run it and watch it pass, with 14c part 2's tests unchanged**

Run: `npm run build && npx vitest run tests/contract/slack-details.test.ts tests/contract/slack-interactivity.test.ts tests/contract/slack-ingress.test.ts && npx eslint packages/broker/src/aws tests/contract/slack-details.test.ts`
Expected: PASS; no lint output.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/aws/slack-details.ts packages/broker/src/aws/slack-interactivity.ts tests/contract/slack-details.test.ts
git commit -m "feat(broker): open a turn's Details modal from the signed interactivity endpoint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The ingress Lambda's least-privilege read

**Files:**
- Modify: `infra/lib/control-plane.ts` (a constant; the `TurnRecords` comment; one grant and one
  environment variable after `slackSecret.grantRead(slackIngress);`)
- Modify: `tests/contract/turn-records-infrastructure.test.ts` (imports; one amended assertion; one
  appended `describe`)

**Interfaces:**
- Consumes: `TURN_DETAILS_ATTRIBUTES` (Task 2); `turnRecords` and `slackIngress` in
  `ControlPlaneStack`.
- Produces: `export const TURN_DETAILS_READ_ATTRIBUTES: string[]` from `infra/lib/control-plane.ts`;
  the ingress role's `GetItem` statement; `TURN_RECORDS_TABLE_NAME` on the ingress Lambda (read by
  Task 4's registration).

- [ ] **Step 1: Write the failing tests**

In `tests/contract/turn-records-infrastructure.test.ts`, add these imports after the existing
`SlackOrchestratorStack` import:

```ts
import { TURN_DETAILS_READ_ATTRIBUTES } from "../../infra/lib/control-plane.js";
import { TURN_DETAILS_ATTRIBUTES } from "../../packages/contracts/src/index.js";
```

(If the linter asks, merge the first into the existing `ControlPlaneStack` import instead.)

In the test "gives no other role access to turn records", replace exactly these two lines:

```ts
    expect(roles.every((role) => role.startsWith("SlackOrchestratorTaskRole") || role.startsWith("BrokerServiceRole"))).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(2);
```

with:

```ts
    // Spec 014 FR-024 admits exactly one more role: the ingress Lambda, for one record's Details fields (pinned below).
    expect(roles.every((role) => role.startsWith("SlackOrchestratorTaskRole") || role.startsWith("BrokerServiceRole") || role.startsWith("SlackIngressServiceRole"))).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(3);
```

This is the one sanctioned assertion change of the phase (Global Constraints). The allowlist names
a new role, and the minimum count rises.

Append at the end of the file:

```ts
describe("Details view access to turn records (spec 014 FR-024)", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "TurnDetailsControlPlane"));

  it("lets the ingress Lambda get one turn record by key, with only the attributes the Details view shows", () => {
    const statements = statementsForRole(template, "SlackIngressServiceRole").filter(onTurnRecords);
    expect(statements).toHaveLength(1);
    expect([statements[0]!.Action].flat()).toEqual(["dynamodb:GetItem"]);
    expect(JSON.stringify(statements[0]!.Resource)).not.toContain("index");
    expect(statements[0]).toMatchObject({
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": TURN_DETAILS_READ_ATTRIBUTES },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
  });

  it("keeps the IAM attribute list equal to the keys plus what the Details reader asks for, never the request or response text", () => {
    expect([...TURN_DETAILS_READ_ATTRIBUTES].sort()).toEqual(["pk", "sk", "exportPk", "exportSk", ...TURN_DETAILS_ATTRIBUTES].sort());
    for (const name of ["requestText", "responseText", "textTruncated", "workspaceId", "conversationId", "workerOperations", "manifestHash"]) {
      expect(TURN_DETAILS_READ_ATTRIBUTES).not.toContain(name);
    }
  });

  it("passes the turn record table name to the ingress Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({
        SLACK_REQUEST_QUEUE_URL: Match.anyValue(),
        TURN_RECORDS_TABLE_NAME: { Ref: Match.stringLikeRegexp("^TurnRecords") },
      }) },
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run build && npx vitest run tests/contract/turn-records-infrastructure.test.ts`
Expected: FAIL. `TURN_DETAILS_READ_ATTRIBUTES` is not exported. After it exists, "gives no other role
access" still fails until the grant exists, because there are only two roles.

- [ ] **Step 3: Add the grant in `infra/lib/control-plane.ts`**

After `export const SLACK_MAX_RECEIVE_COUNT = 5;`:

```ts
// What the ingress Lambda may read of a turn record for the Details view (spec 014 FR-024): the
// table and index keys plus TURN_DETAILS_ATTRIBUTES in packages/contracts/src/slack-details.ts.
// A contract test keeps the two equal; infra does not depend on @agentx/contracts.
export const TURN_DETAILS_READ_ATTRIBUTES = [
  "pk", "sk", "exportPk", "exportSk",
  "eventId", "subject", "receivedAt", "requestedBy", "disposition", "durationMs", "model", "offeredTools", "calls",
  "callsTruncated", "emptyResponse", "usage", "usageError", "recordingErrors", "argumentsOmitted", "error", "expiresAt",
];
```

Replace the comment above `const turnRecords = new dynamodb.Table(this, "TurnRecords", {`:

```ts
    // One record per Slack event, kept 30 days for diagnosis and evaluation cases (feature 013 FR-025).
    // Admin-only: the broker reads it for the admin export and nothing else can.
```

with:

```ts
    // One record per Slack event, kept 30 days for diagnosis and evaluation cases (feature 013 FR-025).
    // The broker reads it for the admin export. The ingress Lambda reads one record's non-text fields
    // for the Details view (spec 014), granted below. Nothing else can read it.
```

After `slackSecret.grantRead(slackIngress);`:

```ts
    // The Details view (spec 014 FR-024): Slack's interactivity request runs on this Lambda and must
    // open the modal within 3 seconds, so it reads the one turn record the clicked button names, by
    // key. It may read only the attributes the view shows: never the request or response text, the
    // workspace or the worker operations. No Query or Scan, and no index.
    slackIngress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [turnRecords.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": TURN_DETAILS_READ_ATTRIBUTES },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    }));
    slackIngress.addEnvironment("TURN_RECORDS_TABLE_NAME", turnRecords.tableName);
```

- [ ] **Step 4: Run them and watch them pass, with every other infrastructure test unchanged**

Run: `npm run build && npx vitest run tests/contract/turn-records-infrastructure.test.ts tests/contract/infrastructure.test.ts && npx eslint infra/lib tests/contract/turn-records-infrastructure.test.ts`
Expected: PASS. In particular, "lets the Slack service only put turn records and the broker only
read them" and "limits the ingress Lambda to reading channel bindings from the state table" pass
unchanged. The Lambda count stays 4.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/control-plane.ts tests/contract/turn-records-infrastructure.test.ts
git commit -m "feat(infra): let the Slack ingress read one turn record's Details fields, and nothing else

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Details button on the reply

**Files:**
- Modify: `packages/slack-service/src/processor.ts`, `packages/slack-service/src/main.ts`
- Test: `tests/integration/slack-details-button.test.ts`

**Interfaces:**
- Consumes: `detailsButtonValue`, `detailsReplyBlocks`, `DETAILS_ACTION` (Task 2); 14a's
  `slackReplyText`; 14c part 2's `postToSlack(channel, threadTs, text, blocks?)`; `TurnRecorder`.
- Produces: `ProcessorDependencies.postWithBlocks?: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>`;
  the log event `reply.details_failed`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/slack-details-button.test.ts
import { describe, expect, it, vi } from "vitest";
import { DETAILS_ACTION, splitSlackMessage, type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";
import { DynamoTurnRecordWriter } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const message: SlackRequestMessage = {
  version: 1, eventId: "EvDETAILS001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
  text: "list open items",
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding.",
};
const value = "2026-09-24T10:00:00.000Z#EvDETAILS001";

interface Posted { text: string; blocks?: unknown[] }

function turnWithCall(response: string | Error) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.offer({ manifest: "m", tools: [{ name: "tracker__list_items", description: "d" }], connectorOf: new Map([["tracker__list_items", "tracker"]]), model: { provider: "p", modelId: "m" } });
    input.recorder?.toolStarted({ toolCallId: "c1", toolName: "tracker__list_items", args: { state: "OPEN" } });
    input.recorder?.toolEnded({ toolCallId: "c1", toolName: "tracker__list_items", isError: false,
      result: { content: [{ type: "text", text: JSON.stringify({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }) }] } });
    if (response instanceof Error) throw response;
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function turnWithoutCalls(response: string) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function harness(runTurn: (input: TurnInput) => Promise<string>, options: { records?: boolean; postWithBlocks?: ProcessorDependencies["postWithBlocks"] } = {}) {
  const db = new FakeDynamoDb();
  const posts: Posted[] = [];
  const logs: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => workspace,
      startClose: async () => ({ outcome: "NOT_FOUND" }),
      completeClose: vi.fn(), waitForOperation: vi.fn(),
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({ workspaceId, conversationId }),
      saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
    },
    runTurn,
    post: async (_thread, text) => { posts.push({ text }); },
    postWithBlocks: options.postWithBlocks ?? (async (_thread, text, blocks) => { posts.push({ text, blocks }); }),
    log: (event, fields) => { logs.push(JSON.stringify({ event, ...fields })); },
    ...(options.records === false ? {} : { turnRecords: new DynamoTurnRecordWriter(db as never, "turns") }),
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  return { dependencies, posts, logs, stored };
}

function button(post: Posted | undefined) {
  const actions = post?.blocks?.at(-1) as { type?: string; elements?: Array<{ action_id: string; value: string }> } | undefined;
  return actions?.type === "actions" ? actions.elements?.[0] : undefined;
}

describe("the Details button on replies (spec 014 FR-024)", () => {
  it("puts a Details button naming the turn's record under a reply that followed tool calls", async () => {
    const { dependencies, posts, stored } = harness(turnWithCall("Nothing is open."));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toEqual({ text: "Nothing is open.", blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Nothing is open." } },
      { type: "actions", block_id: "agentx_details", elements: [{ type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value }] },
    ] });
    expect(posts.slice(0, -1).every((post) => post.blocks === undefined)).toBe(true);
    expect(stored()[0]).toMatchObject({ sk: `TURN#${value}`, responseText: "Nothing is open." });
  });

  it("carries the button on the last chunk of a long reply only, in sections Slack accepts", async () => {
    const reply = Array.from({ length: 3 }, (_, index) => `Part ${index}: ${"word ".repeat(700)}`).join("\n");
    const { dependencies, posts } = harness(turnWithCall(reply));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    const chunks = splitSlackMessage(slackReplyText(reply));
    expect(posts.slice(-chunks.length).map((post) => post.text)).toEqual(chunks);
    expect(posts.slice(-chunks.length, -1).every((post) => post.blocks === undefined)).toBe(true);
    expect(button(posts.at(-1))?.value).toBe(value);
    for (const block of posts.at(-1)!.blocks! as Array<{ type: string; text?: { text: string } }>) {
      if (block.type === "section") expect(block.text!.text.length).toBeLessThanOrEqual(3_000);
    }
  });

  it("adds no button when the turn called no tools, or when no record will be written", async () => {
    const quiet = harness(turnWithoutCalls("Hello."));
    await processSlackRequest(message, quiet.dependencies, { finalAttempt: false });
    expect(quiet.posts.every((post) => post.blocks === undefined)).toBe(true);
    const unrecorded = harness(turnWithCall("Nothing is open."), { records: false });
    await processSlackRequest(message, unrecorded.dependencies, { finalAttempt: false });
    expect(unrecorded.posts.every((post) => post.blocks === undefined)).toBe(true);
  });

  it("posts the reply as text when Slack refuses the blocks, and says so in the log", async () => {
    const { dependencies, posts, logs, stored } = harness(turnWithCall("Nothing is open."), {
      postWithBlocks: async () => { throw new Error("Slack chat.postMessage failed: invalid_blocks"); },
    });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toEqual({ text: "Nothing is open." });
    expect(logs).toContain(JSON.stringify({ event: "reply.details_failed", eventId: "EvDETAILS001", errorName: "Error" }));
    expect(stored()[0]).toMatchObject({ responseText: "Nothing is open." });
    expect(logs.join("\n")).not.toContain("Nothing is open.");
  });

  it("adds the button to a failed turn's reply after a tool call, so the member can see what went wrong", async () => {
    const { dependencies, posts } = harness(turnWithCall(new Error("model down")));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)?.text).toBe("AgentX could not complete the request: model down");
    expect(button(posts.at(-1))?.value).toBe(value);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/integration/slack-details-button.test.ts`
Expected: FAIL. TypeScript reports that `postWithBlocks` is not a known property; at runtime no
post has blocks.

- [ ] **Step 3: Change `packages/slack-service/src/processor.ts`**

Add `detailsButtonValue` and `detailsReplyBlocks` to the value imports from `@agentx/contracts`,
next to `splitSlackMessage`.

In `ProcessorDependencies`, directly after `turnRecords?: TurnRecordSink;`:

```ts
  /**
   * Posts a message with Block Kit blocks. The reply's Details button needs it (spec 014 FR-024);
   * without it, replies are text only, exactly as before.
   */
  postWithBlocks?: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>;
```

After the `ProcessorDependencies` interface, add:

```ts
/** Where a reply's Details button points, and how to post it. */
interface ReplyDetails {
  value: string;
  postWithBlocks: (thread: SlackThread, text: string, blocks: unknown[]) => Promise<void>;
}
```

In `processSlackRequest`, directly after the `post` helper (the `const post = async (text: string) => { ... };` block):

```ts
  // Spec 014 FR-024: the last chunk of a reply that followed tool calls carries a Details button. A
  // Slack refusal of the blocks never costs the member the reply: the text is posted on its own.
  const postWithDetails = async (details: ReplyDetails, text: string) => {
    try {
      await details.postWithBlocks(message.thread, text, detailsReplyBlocks(text, details.value));
      lastPosted = text;
    } catch (error) {
      log("reply.details_failed", { eventId: message.eventId, errorName: errorName(error) });
      await post(text);
    }
  };
```

Replace 14a's reply loop:

```ts
    for (const chunk of splitSlackMessage(slackReplyText(response))) await post(chunk);
```

with:

```ts
    const chunks = splitSlackMessage(slackReplyText(response));
    const details = replyDetails(dependencies, recorder, message);
    for (const [index, chunk] of chunks.entries()) {
      if (details !== undefined && index === chunks.length - 1) await postWithDetails(details, chunk);
      else await post(chunk);
    }
```

After the `processSlackRequest` function, add:

```ts
/**
 * The Details button's target, when the reply should carry one: the turn called at least one tool,
 * and its record will be written (a sink and a recorder exist), so the button always names a record
 * the service tries to save. The value derives from the Slack event, as the record's key does.
 */
function replyDetails(dependencies: ProcessorDependencies, recorder: TurnRecorder | undefined, message: SlackRequestMessage): ReplyDetails | undefined {
  const postWithBlocks = dependencies.postWithBlocks;
  if (postWithBlocks === undefined || dependencies.turnRecords === undefined || recorder === undefined) return undefined;
  let calls: number;
  try {
    calls = recorder.observation().calls.length;
  } catch {
    // The record's own write reports a broken recorder; the reply just goes without a button.
    return undefined;
  }
  if (calls === 0) return undefined;
  const value = detailsButtonValue(message);
  return value === undefined ? undefined : { value, postWithBlocks };
}
```

- [ ] **Step 4: Wire it in `packages/slack-service/src/main.ts`**

In the `processSlackRequest` dependencies, directly after 14c part 2's line
`postConfirmation: (thread, confirmation, text) => postToSlack(thread.channelId, thread.threadTs, text, confirmationBlocks(text, confirmation.confirmationId)),`, add:

```ts
  postWithBlocks: (thread, text, blocks) => postToSlack(thread.channelId, thread.threadTs, text, blocks),
```

- [ ] **Step 5: Run it and watch it pass, with every existing Slack test unchanged**

Run: `npm run build && npx vitest run tests/integration/slack-details-button.test.ts tests/contract/slack-reply-characterization.test.ts tests/integration/slack-service.test.ts tests/integration/turn-records.test.ts tests/integration/turn-recording.test.ts tests/integration/slack-action-gate.test.ts tests/integration/hosted-slack-linear.test.ts tests/integration/hosted-slack-mcp.test.ts && npx eslint packages/slack-service/src tests/integration/slack-details-button.test.ts`
Expected: PASS; no lint output. Task 1's characterization passes unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/slack-service/src/processor.ts packages/slack-service/src/main.ts tests/integration/slack-details-button.test.ts
git commit -m "feat(slack): put a Details button on replies that followed tool calls

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documents, and a whole-branch check

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces: nothing new.

- [ ] **Step 1: Document the Details button**

In `README.md`, directly after the paragraph that ends
"`turn_record.duplicate` means SQS redelivered a request that was already recorded.", add this
paragraph:

```markdown
A reply that follows tool calls carries a **Details** button. It opens a Slack view that only the
member who clicked can see. The view is built from that turn's record: who asked and when, the
outcome, the model, how many tools were offered, each call's tool, redacted arguments, outcome and
reason, any action gate decision, and token usage. Any member who can see the reply can open it,
and each opening is logged as `interaction.details_opened` with the viewer's Slack user ID. The
view never shows the request or response text, which are already in the thread. The ingress
Lambda's IAM grant cannot read them: it may `GetItem` one record by key, and only the attributes
the view shows. Nothing is posted to the thread. If the record is more than 30 days old, was never
saved, is still being saved, or cannot be read, the view says so. If the view cannot open in time,
AgentX tells the member privately. Long arguments are cut to fit Slack's limits and end with
`… [cut to fit]`; `agentx admin turns export` has the full record. The button needs Slack
Interactivity, which the action gate's confirmation buttons already turned on; it needs no new
scope.
```

- [ ] **Step 2: Run the whole branch**

Run:
```bash
npm run build && npm run typecheck && npm run lint && npm test
```
Expected: all pass.

- [ ] **Step 3: Check that no test line was removed except the one sanctioned change**

Run: `git diff origin/mainline -- tests | grep -E '^-[^-]'`
Expected: exactly these two lines, both from `tests/contract/turn-records-infrastructure.test.ts`:

```
-    expect(roles.every((role) => role.startsWith("SlackOrchestratorTaskRole") || role.startsWith("BrokerServiceRole"))).toBe(true);
-    expect(roles.length).toBeGreaterThanOrEqual(2);
```

Also run `git diff origin/mainline --stat -- tests/contract/__snapshots__`
Expected: no output.

- [ ] **Step 4: Check that new source files name no vendor**

Run: `grep -niE "linear|jira|atlassian|github|asana" packages/contracts/src/slack-details.ts packages/broker/src/aws/slack-details.ts packages/broker/src/aws/slack-details-view.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: the Details button, who can open it and what it shows

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Open Questions

1. **Authorization (R1).** The plan lets any member who can see the reply open Details, and logs
   who looked. If the owner wants requester-only, `detailsActionHandler` compares `action.userId`
   with `details.requestedBy.userId` and shows "Only <@requester> can open these details". There
   is no admin exception, because Slack clicks carry no AgentX admin identity.
2. **The amended infrastructure assertion.** "gives no other role access to turn records" (spec 013
   phase 4) now admits the ingress role. If Pratik rejects a third reader, the alternative is a
   broker-served read. That needs a loading modal (`views.open`, then `views.update`), a new
   service caller on the broker's `/v1/service` routes, and a second Lambda hop.
3. **IAM attribute conditions.** AWS requires `dynamodb:Attributes` to list the key attributes. The
   plan lists the table and index keys. The rollout's `simulate-principal-policy` check confirms
   it before any button ships.
4. **Gate decision shape (R6).** 14c part 2 leaves recording gate decisions in turn records as a
   follow-up. The plan assumes the shape that plan names, `{ outcome, source, kind?, rule?,
   reason }`. If the follow-up chooses another shape, the view says it cannot show it, and
   `DetailsGateSchema` should be aligned.
5. **Slack Connect and Enterprise Grid.** A member from another organization in a shared channel
   may click with a different team ID. The key then misses, and they see "no saved details". This
   fails closed. Confirm whether external members should see Details at all.
6. **Control plane rollback.** Resolved: 14c2 answers unknown actions privately ("This button is no longer available").
   nothing, so an old Details button would do nothing visible. Consider having 14c part 2 answer
   any unknown action privately ("This button is no longer available").

## Self-Review

- **Spec coverage.**
  - FR-024: the button (Task 6), the modal for the clicking member built from the turn record
    (Tasks 3 and 4).
  - FR-025: reused from 14c part 2, and re-asserted for Details clicks (Task 4, first test).
  - US4 scenario 3: private, redacted, from the record (Tasks 3 and 4).
  - US4 scenario 4: an unavailable record is said, never silent (Task 4, R8).
  - The spec decision "private modal, not a thread post": no posting dependency (Task 4).
  - The brief's scope items: authorization R1, data access R2 and R3, IAM Task 5, limits R7 and
    Task 3, expiry and write failure Task 4, release order and app settings in Rollout.
- **Placeholder scan.** No "TBD" or "similar to". Every code step has its code. Anchors are quoted
  exactly and checked in Task 1, Step 1.
- **Type consistency.**
  - `DetailsReference`, `TurnDetails`, `TurnDetailsCall` and `SlackModalView` are named the same
    in every task.
  - `detailsButtonValue` returns `string | undefined` everywhere.
  - `readDetails(key)`, `openView(triggerId, view)` and `respondEphemeral(url, text)` match
    between the Task 4 handler, its test and its registration.
  - `postWithBlocks(thread, text, blocks)` matches between the processor, `main.ts` and the test.
  - `TURN_DETAILS_ATTRIBUTES` has 17 names; `TURN_DETAILS_READ_ATTRIBUTES` has 21 (those plus 4
    keys).
- **Review Focus.** Each of the six lines names the test that pins it, in its owning task.
