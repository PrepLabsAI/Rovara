// TEST SUPPORT: the tools of each monitoring connector, by connector type .
import { DATADOG_TOOL_NAMES } from "../../packages/broker/src/connectors/native/datadog.js";
import { GRAFANA_TOOL_NAMES } from "../../packages/broker/src/connectors/native/grafana.js";
import { PAGERDUTY_TOOL_NAMES } from "../../packages/broker/src/connectors/native/pagerduty.js";
import { SENTRY_TOOL_NAMES } from "../../packages/broker/src/connectors/native/sentry.js";
import { VERCEL_TOOL_NAMES } from "../../packages/broker/src/connectors/native/vercel.js";

export const PROJECT_CONNECTOR_TOOLS = {
  sentry: SENTRY_TOOL_NAMES, datadog: DATADOG_TOOL_NAMES, grafana: GRAFANA_TOOL_NAMES, pagerduty: PAGERDUTY_TOOL_NAMES, vercel: VERCEL_TOOL_NAMES,
} as const;
