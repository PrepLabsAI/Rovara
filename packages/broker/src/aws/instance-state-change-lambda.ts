// The Lambda behind the EC2 instance state-change rule (infra/lib/instance-state-change.ts). The handler itself is instance-state-change.ts, which has no AWS client; this file wires it to the State
// table (the same session code the reconciler runs) and to the metric the reconciler's lost-instance alarm reads.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createInstanceStateChangeHandler } from "./instance-state-change.js";
import { requiredEnvironment } from "./lambda.js";
import { failActiveOperation } from "./outbox-failure.js";
import { SessionManager } from "./sessions.js";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }));
const tableName = process.env.STATE_TABLE_NAME ?? "";
const line = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "instance-state-change", ...entry }));

export const handler = createInstanceStateChangeHandler({
  sessions: new SessionManager({ documentClient, tableName }),
  failActiveOperation: (workspaceId, error) => failActiveOperation(documentClient, tableName, workspaceId, error),
  emit(metrics) {
    line({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: "Count" })) }],
      },
      event: "metric",
      ...metrics,
    });
  },
  log: line,
});
