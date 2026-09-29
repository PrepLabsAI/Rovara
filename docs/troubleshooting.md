# Troubleshooting

Start from the symptom. Each section names the log line to look for and what it means. A reference
table of log events is at the end.

The ingress Lambda and the orchestrator service write JSON log lines to CloudWatch Logs, with the
components `slack-ingress` and `slack-orchestrator`. They record event IDs, decisions such as
`event.ignored` with a reason, and failures by error type. Tokens, request text and response text
are never written there. See [security](security.md) for what else is kept.

## Login shows `Missing Authentication Token`

Opening the bare Cognito domain directly is not a login flow and can return
`{"message":"Missing Authentication Token"}`. Always start login through the client, for example
`agentx login --callback-port 8765`. An administrator login must be an account that carries the
configured administrator claim, such as membership in the Cognito `agentx-admin` group.

## An admin command fails

The exit code names the kind of failure:

| Exit code | Meaning |
|---|---|
| 2 | Invalid input |
| 3 | Login is required |
| 4 | Forbidden or not found |
| 6 | The control plane is unavailable |

See the [CLI reference](cli.md) for each command.

## The bot does not answer in a channel

Search the `slack-ingress` logs for the event.

- `event.ignored reason="channel_not_bound"`: the channel has no binding. Bind it with
  `agentx admin slack bind`.
- `request.rejected reason="invalid_signature"`: usually the stored signing secret is wrong. Both
  services cache the Slack secret for up to five minutes, so allow that long after a change.
- `event.ignored reason="member_check_failed"` with `slackError="missing_scope"`: the bot token
  lacks `users:read`. Add the scope and reinstall the app.
- `reason="not_a_person"`: a bot posted the mention.
- `reason="own_message"`: AgentX posted it.
- `reason="app_posted_disabled"`: the message came through another app and
  `SlackAppPostedMessages` is `ignore`.
- `reason="bot_or_edited_message"`: an edited message, or app-posted messages that are off or not
  configured.
- `reason="no_user"`: the event named no Slack user.
- `reason="malformed_event"`: any other event that could not be parsed.

If no line appears at all, check the Slack app. Socket Mode must be off. Event Subscriptions must
be on, with the request URL set to the `SlackEventsUrl` output and the bot event `app_mention`
subscribed. The app must be invited to the channel with `/invite @AgentX`.

AgentX ignores messages without a mention, edits, bot messages, its own messages, direct messages,
and users from other Slack organizations.

## A thread stops answering for a minute

`thread.paused` records each request the per-thread limit refused. A thread that sends more than 6
requests in a minute is paused until the next minute. The `AgentXControlPlane` parameter
`SlackThreadTurnsPerMinute` changes the limit.

## A thread fails with `CONVERSATION_STATE_LOST`

The thread's transcript lives on its workspace volume. If the workspace is replaced, the next
request fails with `CONVERSATION_STATE_LOST` rather than starting over on top of files it has no
memory of. Start a new thread to continue.

## A connector's tools are missing

- `connector.discovery_failed`: a connector's tools were left out of a turn.
  - `cause="transient"` is an outage the next turn may clear.
  - `cause="setup"`, with its error `code`, needs an administrator. For example, `FORBIDDEN` means
    the connector is no longer enabled for the project.
  - Failures inside the control plane's own vendor discovery, including a GitHub App that is not
    installed on a scoped repository, arrive as `RUNTIME_UNAVAILABLE` and are logged as
    `transient`. When one persists, check the broker's `connector.tools_skipped` and error logs.
- `connector.not_connected`: the connector's credential is missing or its vendor rejected it. The
  connector reports itself not connected instead of failing the call.
- `connector.type_unknown`: a stored connector's type is not one this deployment knows, for
  example a newer type left over after a rollback. It is skipped, not served.
- `connector.unusable`: a stored connector's configuration failed to parse for its own type. It is
  skipped, and the log line names the reason.

Registration preflight also reports which approved tools the vendor offers and whether the
connector is connected. For vendor-specific fixes, see [Jira](connectors/jira.md#troubleshooting),
[Asana](connectors/asana.md#troubleshooting) and [Linear](connectors/linear.md).

## A write has no attribution footer

`connector.attribution_dropped` means a write went out without its footer because the signed
arguments would have broken the vendor's schema, for example a `body` length limit. The line names
the project, revision, connector, scope, tool and request ID, never the request's text.

## Approve and Cancel buttons do nothing

The buttons need the Slack app's **Interactivity** turned on, with the Request URL set to the
`AgentXControlPlane` output `SlackInteractivityUrl`. Without it a press reaches no one, and members
must confirm by replying `@AgentX yes`. A button this release does not know, for example after a
rollback, tells the member it is no longer available.

On Slack Enterprise Grid, a press may carry a different team ID and answer that the confirmation is
no longer pending. This has not been checked on a Grid workspace. A typed `@AgentX yes` still
works.

`gate.confirmation_failed` means a question could not be saved or posted. The member is told that
nothing it would list will run.

## Every change asks for confirmation

`gate.classifier_unavailable` at start, with `classifierAvailable: false` in the start line, means
the runtime does not know the classifier model ID. Every change then asks. Check the
`AgentXSlackOrchestrator` parameter `GateClassifierModelId`. AgentX also asks when the model errors,
gives an answer that is not a plain verdict, or does not answer in time (8 seconds by default).

## The Details button is missing or shows no details

- `reply.details_failed`: Slack refused the button, and the reply was posted as plain text.
  `slackError` holds Slack's error code, such as `invalid_blocks`.
- `interaction.details_refused`: a refused opening, with a `reason` such as `external_member`,
  `expired` or `not_found`.
- `interaction.details_invalid`: the record fails its schema. Use `agentx admin turns export`.
- `interaction.details_read_failed`: the read failed or took more than 1 second. Press Details
  again.
- `interaction.details_open_failed`: the view could not open.
- Records older than 30 days are no longer kept, and the view says so.

## A turn record is missing

- `turn_record.write_failed`: a record was lost. The member still got the reply.
- `turn_record.duplicate`: SQS redelivered a request that was already recorded.
- A mention with no text after `@AgentX` is answered by the ingress Lambda and leaves no record.
- An attempt that fails and is retried leaves no record. The attempt that finishes writes it.
- `recordingErrors` on a record lists fixed category strings when part of the recording failed,
  for example `handler_failed:tool_execution_end`.
- `turn_record.invalid`: after a control-plane rollback, export skips records the older schema
  refuses and counts them as `skipped`. They export again after rolling forward, within 30 days.

## A request failed in the thread

If the orchestrator's turn fails, AgentX posts the failure in the thread. Other failures, such as
workspace preparation or a Slack API error, are retried. On the fifth attempt AgentX posts the
failure and stops. A request the service could not finish five times, for example because it
restarted each time, moves to the `SlackRequestDeadLetterQueueUrl` queue.

## An alarm is red

Five alarms ship in `AgentXControlPlane`:

| Alarm | What it means |
|---|---|
| `AgentXConnectorBroken` | A connector's discovery failed, or a vendor changed an approved tool's schema |
| `AgentXConnectorNotConnected` | A connector's vendor credential is missing, revoked or rejected |
| `AgentXEmptyResponses` | More than three turns in an hour ended without text |
| `AgentXRecordingFailures` | A turn record or a turn's own metrics were lost |
| `AgentXSlackDeadLetters` | A Slack request exhausted its receives and landed in the dead-letter queue |

All five notify the SNS topic `AgentXOperatorAlerts`, which has no subscription by default.
Subscribe an address after the first deploy:

```sh
aws sns subscribe --topic-arn <OperatorAlertsTopicArn output> --protocol email \
  --notification-endpoint you@example.com
```

Confirm that it pages you with a smoke test, then clear it:

```sh
aws cloudwatch set-alarm-state --alarm-name AgentXConnectorBroken --state-value ALARM --state-reason test
aws cloudwatch set-alarm-state --alarm-name AgentXConnectorBroken --state-value OK --state-reason test
```

In an environment installed with `agentx init`, `agentx --env <name> alerts test` sends another
test alarm.

If an alarm stays red, act on what it tells you:

- `AgentXSlackDeadLetters`: handle the requests in the `SlackRequestDeadLetterQueueUrl` queue, then
  purge it.
- `AgentXConnectorNotConnected` or a persistent `AgentXConnectorBroken`: reconnect or disable the
  connector named in the broker logs.

Connector and turn metrics go to the `AgentX` CloudWatch namespace. See
[the metrics contract](../specs/013-connector-gateway/contracts/metrics.md) for the full list.

## Log event reference

| Event | Meaning |
|---|---|
| `event.ignored` | A Slack event was ignored; `reason` says why (see above) |
| `request.rejected` | A request was refused; `invalid_signature` usually means a wrong signing secret |
| `thread.paused` | The per-thread limit refused a request |
| `turn_limit.failed` | The turn could not be counted; a 500 that Slack retries |
| `member_check.notice_failed` | The fail-closed notice could not be posted; the event is still handled |
| `thread_paused.notice_failed` | The pause notice could not be posted; the event is still handled |
| `turn_limit.release_failed` | Releasing the claimed event failed after a turn-count failure; the claim is briefly stale |
| `enqueue.release_failed` | Releasing the claimed event failed after an enqueue failure; the claim is briefly stale |
| `turn_limit.decrement_failed` | Undoing the turn count after an enqueue failure failed; the count is briefly stale |
| `connector.discovery_failed` | A connector's tools were left out of a turn (`cause` is `transient` or `setup`) |
| `connector.tools_skipped` | Broker log to check when discovery failures persist |
| `connector.attribution_dropped` | A write went out without its attribution footer |
| `connector.not_connected` | A connector's credential is missing or was rejected |
| `connector.token_cache_failed` | A shared token-cache read, write or delete failed; the provider mints again |
| `connector.type_unknown` | A stored connector's type is unknown to this deployment; skipped |
| `connector.unusable` | A stored connector's configuration failed to parse; skipped |
| `gate.decision` | The action gate's decision for one call |
| `gate.classifier_unavailable` | The classifier model is unknown to the runtime; every change asks |
| `gate.confirmation_failed` | A confirmation question could not be saved or posted |
| `gate.reply_withheld` | A turn's only reply was its confirmation question |
| `turn_record.write_failed` | A turn record was lost; the member still got the reply |
| `turn_record.duplicate` | SQS redelivered a request that was already recorded |
| `turn_record.invalid` | A record failed the control plane's record schema and was skipped |
| `reply.details_failed` | Slack refused the Details button, or the post hit a network error |
| `interaction.details_opened` | A member opened a Details view |
| `interaction.details_refused` | A Details opening was refused; `reason` says why |
| `interaction.details_invalid` | A turn record failed its schema when opened |
| `interaction.details_read_failed` | Reading a record failed or took more than 1 second |
| `interaction.details_open_failed` | The Details view could not open |
