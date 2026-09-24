# Contract: Metrics and Alarms

Namespace `AgentX`, emitted as CloudWatch embedded metric format from existing log streams, so no
new IAM permissions are required. Metric logs carry no request text, response text, arguments or
credentials.

| Metric | Emitter | Dimensions | Meaning |
|---|---|---|---|
| `ConnectorDiscoveryFailed` | Broker | `connector` | Discovery could not connect or authenticate |
| `ConnectorSchemaDrift` | Broker | `connector` | Call-time schema hash differed from the catalog |
| `ConnectorToolSkipped` | Broker | `connector` | An approved tool was not representable or not found |
| `ConnectorNotConnected` | Broker | `connector` | A call failed with `not_connected` |
| `ToolCallUnknownOutcome` | Broker | `connector` | A write ended `UNKNOWN` |
| `ToolSchemaError` | Slack service | `connector` or `agentx` | A call failed validation |
| `ToolUnknownName` | Slack service | — | The model called a name that is not offered |
| `TurnEmptyResponse` | Slack service | — | The final assistant message had no text |
| `TurnCompleted` | Slack service | — | Denominator for rates |

## Alarms (shipped in `AgentXControlPlane`)

| Alarm | Condition | Action |
|---|---|---|
| `AgentXConnectorBroken` | `ConnectorDiscoveryFailed + ConnectorSchemaDrift ≥ 1` in 5 minutes, any connector | SNS topic `AgentXOperatorAlerts` |
| `AgentXEmptyResponses` | `TurnEmptyResponse > 3` in 1 hour | SNS topic `AgentXOperatorAlerts` |

The topic has no subscription by default. The deployer subscribes an email address or connects
AWS Chatbot to a Slack channel.
