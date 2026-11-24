// Access log format of the control-plane HTTP API's `$default` stage. Written to answer one question after the fact: which route did a caller (a worker's terminal callback, a
// dispatcher read, a webhook) hit, what status did API Gateway answer, and was that the gateway itself (route missing, authorizer, throttle) or the broker Lambda behind it.
//
// Every field is a gateway-generated value. Deliberately NOT here, so a log reader can never see them (pinned by tests/contract/api-access-log.test.ts):
//  - `path` / `resourcePath` and `queryString`: the callback and app routes carry workspace, operation, approval and token ids in the path, and some calls (browser sign-in,
//    OAuth and link flows) carry codes in the query. `routeKey` is the route TEMPLATE (e.g. `POST /v1/internal/{proxy+}`), which names the route without the ids.
//  - `sourceIp` and the other `$context.identity.*` values (user agent, caller, cognito identity): personal data the broker's own authentication already makes unnecessary.
//  - Any request header, request body, response body, `$context.authorizer.claims.*` or `$context.authorizer.principalId` (a person's identity, a token's claims).
//  - `$context.error.message` and `$context.error.messageString`: free text that can echo request parts. `errorResponseType` is the fixed enum (UNAUTHORIZED, THROTTLED, ...).
// The format is JSON so CloudWatch Logs Insights reads the fields without parsing. Values are strings; an unset value comes through as "-" or "".
const FIELDS = {
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  httpMethod: "$context.httpMethod",
  routeKey: "$context.routeKey",
  status: "$context.status",
  responseLength: "$context.responseLength",
  responseLatencyMs: "$context.responseLatency",
  errorResponseType: "$context.error.responseType",
  authorizerError: "$context.authorizer.error",
  integrationStatus: "$context.integration.status",
  integrationServiceStatus: "$context.integration.integrationStatus",
  integrationLatencyMs: "$context.integration.latency",
  integrationErrorMessage: "$context.integrationErrorMessage",
} as const;

export const API_ACCESS_LOG_FIELDS: Readonly<Record<string, string>> = FIELDS;

/** The `AccessLogSettings.Format` string. */
export const API_ACCESS_LOG_FORMAT: string = JSON.stringify(FIELDS);
