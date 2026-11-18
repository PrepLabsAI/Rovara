// Real check on the customer's staging, RC1 (design real-check-security-design.md, 4.3 and 5.1): the READ-ONLY operation tables and the call caps. Pure data and tiny helpers; nothing here calls a network,
// holds a credential or imports a Node module.
//
// Every table is an ALLOW-list that fails closed: an operation that is not in a table is refused, whatever its method says. A table grows by a reviewed change, one row at a time, each row with its own test.
//   - Google APIs: the exact method, host and path shape of each read the first APIs offer (Firestore, Pub/Sub read, Storage read, BigQuery, project lookup). Writes, streams, consuming reads (Pub/Sub pull) and
//     anything that returns credentials are simply not rows;
//   - AWS: the read subset of the data-plane actions Rovara's local AWS stands in for. `sqs:ReceiveMessage` is a read that is NOT here: it hides messages from other consumers (design 4.3);
//   - plain HTTP: the small list of action words that refuse even a GET (`/delete`, `/cancel`, `/send`, `/refund`, `/publish` and kin), and the headers and query names that change a request's method.
// The classifier (`real-check-classifier.ts`) reads these tables; the connection contract (`real-check-connection.ts`) uses the API and action names.
import { TEST_ACCOUNT_AWS_ACTIONS } from "./test-account.js";

// ---- caps (5.1; owner decision R3-5)

export interface RealCheckLimits {
  /** Calls in one check (one dependency, one run). */
  callsPerCheck: number;
  /** Calls per project per UTC day. */
  callsPerProjectPerDay: number;
  /** Calls per company per UTC day. */
  callsPerCompanyPerDay: number;
  /** Checks at once per connection. */
  concurrentChecks: number;
  /** Calls per second in one check. */
  callsPerSecond: number;
  /** Milliseconds per call. */
  msPerCall: number;
  /** Milliseconds per check. */
  msPerCheck: number;
  /** Bytes of one answer. */
  answerBytes: number;
  /** Bytes of one request body. */
  requestBytes: number;
  /** Bytes a BigQuery query may bill. */
  bigQueryBytesBilled: number;
}

const MIB = 1_048_576;
const GB = 1_000_000_000;

/** The defaults: 25 calls per check, 200 per project and 1,000 per company a day, 2 at once, 10 s per call, 3 min per check, 1 MiB answers, 1 GB BigQuery. */
export const REAL_CHECK_LIMIT_DEFAULTS: Readonly<RealCheckLimits> = {
  callsPerCheck: 25,
  callsPerProjectPerDay: 200,
  callsPerCompanyPerDay: 1_000,
  concurrentChecks: 2,
  callsPerSecond: 5,
  msPerCall: 10_000,
  msPerCheck: 180_000,
  answerBytes: MIB,
  requestBytes: 64 * 1024,
  bigQueryBytesBilled: GB,
};

/** Rovara's maximums: a connection may raise a cap up to these and no further. */
export const REAL_CHECK_LIMIT_MAXIMUMS: Readonly<RealCheckLimits> = {
  callsPerCheck: 200,
  callsPerProjectPerDay: 2_000,
  callsPerCompanyPerDay: 20_000,
  concurrentChecks: 5,
  callsPerSecond: 20,
  msPerCall: 30_000,
  msPerCheck: 600_000,
  answerBytes: 8 * MIB,
  requestBytes: MIB,
  bigQueryBytesBilled: 100 * GB,
};

export const REAL_CHECK_LIMIT_KEYS = Object.keys(REAL_CHECK_LIMIT_DEFAULTS) as Array<keyof RealCheckLimits>;

// ---- Google APIs (4.3 row 3)

export const REAL_CHECK_GOOGLE_APIS = ["firestore", "pubsub", "storage", "bigquery", "projects"] as const;
export type RealCheckGoogleApi = (typeof REAL_CHECK_GOOGLE_APIS)[number];

/** The one host of each API. A GCP connection reaches exactly the hosts of the APIs it approves. */
export const REAL_CHECK_GOOGLE_HOSTS: Readonly<Record<RealCheckGoogleApi, string>> = {
  firestore: "firestore.googleapis.com",
  pubsub: "pubsub.googleapis.com",
  storage: "storage.googleapis.com",
  bigquery: "bigquery.googleapis.com",
  projects: "cloudresourcemanager.googleapis.com",
};

export type RealCheckGoogleKind = "get" | "list" | "query" | "dry_run_query" | "test_iam" | "lookup";

export interface RealCheckGoogleRow {
  api: RealCheckGoogleApi;
  /** `GET` or `POST`; a HEAD of a GET row is a read too. */
  method: "GET" | "POST";
  /**
   * The path, as plain text with `{name}` for one segment (never `/` or `:`), `{name*}` for one or more segments (last position, before an optional `:verb`), and a literal custom-method suffix (`:runQuery`).
   * The first `{...}` of a Storage object name may carry an encoded slash (`%2F`), the only place one is accepted.
   */
  path: string;
  kind: RealCheckGoogleKind;
  /** Query names this row accepts (anything else is refused). */
  query: readonly string[];
  /** Body members a POST row accepts (anything else is refused); undefined for a GET row. */
  body?: readonly string[];
}

const PAGING = ["pageSize", "pageToken", "fields", "prettyPrint"] as const;

/** Firestore, Pub/Sub read, Storage read, BigQuery read and the project lookup. Every method is a read by Google's own naming (get/list/query) and is not a stream, a transaction or a consuming read. */
export const REAL_CHECK_GOOGLE_ROWS: readonly RealCheckGoogleRow[] = [
  // Firestore: get and list documents; query shapes; no commit, write, transaction or listen.
  { api: "firestore", method: "GET", path: "/v1/projects/{p}/databases/{d}/documents/{path*}", kind: "get", query: [...PAGING, "mask.fieldPaths", "readTime", "showMissing", "orderBy"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents:runQuery", kind: "query", query: ["fields", "prettyPrint"], body: ["structuredQuery", "readTime"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents/{path*}:runQuery", kind: "query", query: ["fields", "prettyPrint"], body: ["structuredQuery", "readTime"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents:runAggregationQuery", kind: "query", query: ["fields", "prettyPrint"], body: ["structuredAggregationQuery", "readTime"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents/{path*}:runAggregationQuery", kind: "query", query: ["fields", "prettyPrint"], body: ["structuredAggregationQuery", "readTime"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents:listCollectionIds", kind: "list", query: ["fields", "prettyPrint"], body: ["pageSize", "pageToken", "readTime"] },
  { api: "firestore", method: "POST", path: "/v1/projects/{p}/databases/{d}/documents/{path*}:listCollectionIds", kind: "list", query: ["fields", "prettyPrint"], body: ["pageSize", "pageToken", "readTime"] },
  // Pub/Sub: topics and subscriptions, read as metadata. NOT pull (it consumes), publish, acknowledge, seek or snapshot creation.
  { api: "pubsub", method: "GET", path: "/v1/projects/{p}/topics", kind: "list", query: PAGING },
  { api: "pubsub", method: "GET", path: "/v1/projects/{p}/topics/{t}", kind: "get", query: ["fields", "prettyPrint"] },
  { api: "pubsub", method: "GET", path: "/v1/projects/{p}/topics/{t}/subscriptions", kind: "list", query: PAGING },
  { api: "pubsub", method: "GET", path: "/v1/projects/{p}/subscriptions", kind: "list", query: PAGING },
  { api: "pubsub", method: "GET", path: "/v1/projects/{p}/subscriptions/{s}", kind: "get", query: ["fields", "prettyPrint"] },
  { api: "pubsub", method: "POST", path: "/v1/projects/{p}/topics/{t}:testIamPermissions", kind: "test_iam", query: ["fields", "prettyPrint"], body: ["permissions"] },
  { api: "pubsub", method: "POST", path: "/v1/projects/{p}/subscriptions/{s}:testIamPermissions", kind: "test_iam", query: ["fields", "prettyPrint"], body: ["permissions"] },
  // Storage (JSON API): bucket and object metadata, listings and downloads. NOT upload, copy, compose, rewrite, watch or anything that changes an object or a bucket.
  { api: "storage", method: "GET", path: "/storage/v1/b/{b}", kind: "get", query: ["projection", "fields", "prettyPrint"] },
  { api: "storage", method: "GET", path: "/storage/v1/b/{b}/o", kind: "list", query: ["prefix", "delimiter", "maxResults", "pageToken", "projection", "versions", "startOffset", "endOffset", "matchGlob", "includeTrailingDelimiter", "fields", "prettyPrint"] },
  { api: "storage", method: "GET", path: "/storage/v1/b/{b}/o/{o}", kind: "get", query: ["alt", "projection", "fields", "prettyPrint"] },
  { api: "storage", method: "GET", path: "/download/storage/v1/b/{b}/o/{o}", kind: "get", query: ["alt", "fields", "prettyPrint"] },
  { api: "storage", method: "GET", path: "/storage/v1/b/{b}/iam/testPermissions", kind: "test_iam", query: ["permissions", "fields", "prettyPrint"] },
  // BigQuery: metadata, rows of a table, job status and results, and `jobs.query` with a forced cap. NOT jobs.insert (load, copy, extract and query-into-table), insertAll, or any dataset or table change.
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/datasets", kind: "list", query: ["maxResults", "pageToken", "all", "filter", "fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/datasets/{d}", kind: "get", query: ["fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/datasets/{d}/tables", kind: "list", query: ["maxResults", "pageToken", "fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/datasets/{d}/tables/{t}", kind: "get", query: ["selectedFields", "view", "fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/datasets/{d}/tables/{t}/data", kind: "list", query: ["maxResults", "pageToken", "startIndex", "selectedFields", "fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/jobs/{j}", kind: "get", query: ["location", "fields", "prettyPrint"] },
  { api: "bigquery", method: "GET", path: "/bigquery/v2/projects/{p}/queries/{j}", kind: "get", query: ["location", "maxResults", "pageToken", "startIndex", "timeoutMs", "fields", "prettyPrint"] },
  {
    api: "bigquery", method: "POST", path: "/bigquery/v2/projects/{p}/queries", kind: "dry_run_query", query: ["fields", "prettyPrint"],
    body: ["query", "dryRun", "maximumBytesBilled", "useLegacySql", "useQueryCache", "location", "timeoutMs", "maxResults", "defaultDataset", "parameterMode", "queryParameters", "requestId"],
  },
  // The project lookup the production check and the connect probe need (`resourcemanager.projects.get`, `testIamPermissions`).
  { api: "projects", method: "GET", path: "/v3/projects/{p}", kind: "lookup", query: ["fields", "prettyPrint"] },
  { api: "projects", method: "GET", path: "/v1/projects/{p}", kind: "lookup", query: ["fields", "prettyPrint"] },
  { api: "projects", method: "POST", path: "/v3/projects/{p}:testIamPermissions", kind: "test_iam", query: ["fields", "prettyPrint"], body: ["permissions"] },
  { api: "projects", method: "POST", path: "/v1/projects/{p}:testIamPermissions", kind: "test_iam", query: ["fields", "prettyPrint"], body: ["permissions"] },
];

/** The API a host belongs to, or undefined when it is not a Google API host of the table. */
export function realCheckGoogleApiOfHost(host: string): RealCheckGoogleApi | undefined {
  return REAL_CHECK_GOOGLE_APIS.find((api) => REAL_CHECK_GOOGLE_HOSTS[api] === host);
}

/** Any Google API host (including the sign-in hosts): a request to one is classified by the Google table, never as plain HTTP. */
export function isGoogleApiHost(host: string): boolean {
  return host === "googleapis.com" || host.endsWith(".googleapis.com");
}

/** Words that make a BigQuery statement not a plain read when they appear anywhere outside a string, a comment or a quoted name. A script (a second statement) is refused by the classifier on its own. */
export const REAL_CHECK_BIGQUERY_WRITE_WORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER", "TRUNCATE", "EXPORT", "LOAD", "CALL", "EXECUTE", "BEGIN", "DECLARE", "SET", "GRANT", "REVOKE", "ASSERT", "COMMIT", "ROLLBACK", "TRANSACTION", "EXTERNAL_QUERY", "VECTOR_SEARCH",
] as const;

// ---- AWS (4.3 row 4; the signer itself is phase B)

/**
 * The actions an `aws_role_read` connection may hold: reads and lists only, by AWS's own rating, from the services Rovara's local AWS stands in for. Consuming reads are NOT here: `sqs:ReceiveMessage` hides
 * messages from their real consumers, and `sagemaker:InvokeEndpoint` runs a model. A service gets in, an action at a time, by a reviewed change.
 */
export const REAL_CHECK_AWS_READ_ACTIONS = {
  s3: ["GetObject", "ListBucket"],
  dynamodb: ["GetItem", "Query", "Scan", "BatchGetItem", "DescribeTable", "ListTables"],
  sqs: ["GetQueueAttributes", "GetQueueUrl", "ListQueues"],
  sns: ["GetTopicAttributes", "ListTopics"],
  kinesis: ["DescribeStream", "ListStreams", "GetShardIterator", "GetRecords"],
  events: ["DescribeEventBus", "ListRules"],
  sagemaker: ["DescribeEndpoint"],
} as const satisfies Record<string, readonly string[]>;

/** Reads that are refused on purpose, with the reason. Pinned by a test so a later edit cannot add one quietly. */
export const REAL_CHECK_AWS_CONSUMING_READS = ["sqs:ReceiveMessage", "sagemaker:InvokeEndpoint"] as const;

/** Whether `service:Action` is on the read table. Exact match only: no wildcard, no case folding. */
export function isRealCheckAwsReadAction(action: unknown): boolean {
  if (typeof action !== "string") return false;
  const index = action.indexOf(":");
  if (index <= 0) return false;
  const rows = (REAL_CHECK_AWS_READ_ACTIONS as Record<string, readonly string[] | undefined>)[action.slice(0, index)];
  return rows !== undefined && rows.includes(action.slice(index + 1));
}

/** The test-account write actions, for tests that prove none of them is on the read table. */
export const REAL_CHECK_AWS_TEST_ACCOUNT_ACTIONS = TEST_ACCOUNT_AWS_ACTIONS;

// ---- plain HTTP (4.3 row 1)

/**
 * A path word that makes even a GET a refusal: the call is named for a change. Compared to whole words of every path segment (split at `-`, `_`, `.`, `:` and a lower-to-upper change), lower case.
 * The design's list (`delete`, `cancel`, `send`, `refund`, `publish`) is the start; the rest are the usual verbs of an endpoint that acts. It errs on the side of refusing: a contract that needs one of them for a
 * real read does not get it in v1.
 */
export const REAL_CHECK_ACTION_WORDS: ReadonlySet<string> = new Set([
  "delete", "remove", "destroy", "purge", "drop", "truncate", "cancel", "send", "refund", "publish", "create", "update", "charge", "capture", "void", "revoke", "approve", "reject", "archive",
  "unsubscribe", "subscribe", "trigger", "execute", "run", "reset", "submit", "pay", "transfer", "invite", "disable", "enable", "activate", "deactivate", "confirm", "upload", "import", "export",
  "terminate", "kill", "restart", "retry", "replay", "merge", "restore", "rotate", "regenerate",
]);

/** Query names whose VALUE names an action on some legacy APIs (`?action=delete`): their values are read for action words. */
export const REAL_CHECK_ACTION_QUERY_NAMES: ReadonlySet<string> = new Set(["action", "method", "cmd", "command", "operation", "op", "do", "act", "verb", "task"]);

/** Request headers that change a request's method (a proxy or framework applies them): any of them, in any case, is a refusal. */
export const REAL_CHECK_METHOD_OVERRIDE_HEADERS: ReadonlySet<string> = new Set(["x-http-method-override", "x-http-method", "x-method-override", "x-http-verb"]);

/** Query names that do the same (`?_method=DELETE`, Google's `$httpMethod`). Compared lower case. */
export const REAL_CHECK_METHOD_OVERRIDE_QUERY_NAMES: ReadonlySet<string> = new Set(["_method", "__method", "$httpmethod", "httpmethod", "x-http-method-override", "x-http-method", "method_override"]);
