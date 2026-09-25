# Contract: Metrics and Alarms

Namespace `AgentX`. The broker (a Lambda function) writes embedded metric format lines to its own
log stream, each with two CloudWatch dimension sets, `[connector]` and none, so every broker metric
below also has a dimensionless "any connector" series and no new IAM permission is required. The
Slack service (Fargate, the `awslogs` log driver) cannot emit embedded metric format from a
container, so it instead writes `{"event":"metric","metric":<name>,"count":<n>}` lines that
CloudWatch Logs metric filters in the `AgentXSlackOrchestrator` stack turn into metrics; every one
of those filters publishes a dimensionless series only, except `ToolSchemaError`'s, which carries a
`connector` dimension and has no dimensionless series. Metric logs carry no request text, response
text, arguments or credentials.

| Metric | Emitter | Dimensions | Meaning |
|---|---|---|---|
| `ConnectorDiscoveryFailed` | Broker | `connector`, and dimensionless | Discovery threw `RUNTIME_UNAVAILABLE`. An authentication or authorization failure does not throw; it is reported through `ConnectorNotConnected` instead, never this metric |
| `ConnectorSchemaDrift` | Broker | `connector`, and dimensionless | Call-time schema hash differed from the catalog |
| `ConnectorToolSkipped` | Broker | `connector`, and dimensionless | An approved tool was not representable or not found, counted on every discovery served, including a cache hit |
| `ConnectorNotConnected` | Broker | `connector`, and dimensionless | A served discovery catalog reported itself not connected, or a call failed with `not_connected`; a vendor-rejected credential counts here, never as `ConnectorDiscoveryFailed` |
| `ToolCallUnknownOutcome` | Broker | `connector`, and dimensionless | A write ended `UNKNOWN` |
| `ToolSchemaError` | Slack service | `connector` or `agentx` (no dimensionless series) | A call failed validation |
| `ToolUnknownName` | Slack service | — | The model called a name that is not offered |
| `TurnEmptyResponse` | Slack service | — | The final assistant message had no text |
| `TurnCompleted` | Slack service | — | Denominator for rates |
| `TurnRecordWriteFailed` | Slack service | — | A turn record was not written (a build, parse or write failure; a redelivered event that already has a record is not a failure and is not counted) |
| `TurnMetricsEmitFailed` | Slack service | — | A record was written but emitting its own `TurnCompleted`/`TurnEmptyResponse`/`ToolSchemaError`/`ToolUnknownName` metrics then failed |

Every discovery request a turn makes is observed, whether or not the underlying vendor catalog was
served from the 10-minute cache: `ConnectorNotConnected` and `ConnectorToolSkipped` from discovery,
like `ConnectorDiscoveryFailed`, are counted once per turn that hits the condition, not once per
underlying vendor problem. Discovery metrics scale with turns, so a connector that stays broken for
an hour of turns adds one count per turn, not one count total. A replayed ledger result (an
idempotent retry or a hosted redelivery) is the same outcome the original request already counted;
`observeConnectorRoute` skips `ConnectorSchemaDrift`, `ConnectorNotConnected` and
`ToolCallUnknownOutcome` for it, so a replay is never double-counted.

## Alarms (shipped in `AgentXControlPlane`)

| Alarm | Condition | Action |
|---|---|---|
| `AgentXConnectorBroken` | `ConnectorDiscoveryFailed + ConnectorSchemaDrift ≥ 1` in 5 minutes, any connector | SNS topic `AgentXOperatorAlerts` |
| `AgentXConnectorNotConnected` | `ConnectorNotConnected ≥ 1` in 5 minutes, any connector | SNS topic `AgentXOperatorAlerts` |
| `AgentXEmptyResponses` | `TurnEmptyResponse > 3` in 1 hour | SNS topic `AgentXOperatorAlerts` |
| `AgentXRecordingFailures` | `TurnRecordWriteFailed + TurnMetricsEmitFailed ≥ 1` in 5 minutes | SNS topic `AgentXOperatorAlerts` |
| `AgentXSlackDeadLetters` | `SlackRequestDeadLetterQueue`'s `ApproximateNumberOfMessagesVisible` (Maximum) `≥ 1` in 5 minutes | SNS topic `AgentXOperatorAlerts` |

All five treat missing data as not breaching and notify the same topic, `AgentXOperatorAlerts`,
which has no subscription by default. The deployer subscribes an email address or connects AWS
Chatbot to a Slack channel, for example:

```sh
aws sns subscribe --topic-arn <OperatorAlertsTopicArn output> --protocol email \
  --notification-endpoint you@example.com
```

After the first deploy, confirm the subscription actually pages before relying on it:

```sh
aws cloudwatch set-alarm-state --alarm-name AgentXConnectorBroken --state-value ALARM \
  --state-reason test
```

Reset it the same way with `--state-value OK` once the notification has been confirmed. An alarm
that stays red is telling you something specific, not a false positive to silence: purge the
`SlackRequestDeadLetterQueueUrl` queue, once you have handled the requests in it, to clear
`AgentXSlackDeadLetters`; reconnect the credential named in the broker's connector logs, or disable
that connector on the project, to clear `AgentXConnectorNotConnected` or a persistent
`AgentXConnectorBroken`.
