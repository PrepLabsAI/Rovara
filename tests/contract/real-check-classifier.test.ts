// Real check RC2 (contract): the operation classifier. Every write shape is refused (one test per kind of write), a read of each protocol passes, production and model hosts are refused, and the caps the classifier
// owns (request size, the BigQuery bytes cap) are enforced. No network and no credential: the classifier only reads a request.
import { describe, expect, it } from "vitest";
import { classifyRealCheckRequest, bigQueryProjectRefs, bigQueryStatementIsRead, realCheckPathLabel, isRealCheckOperationTemplate, type RealCheckPolicy, type RealCheckRequest, type RealCheckVerdict } from "../../packages/contracts/src/real-check-classifier.js";
import { REAL_CHECK_GOOGLE_ROWS, REAL_CHECK_LIMIT_DEFAULTS } from "../../packages/contracts/src/real-check-read-tables.js";

const VENDOR = "sandbox.vendor-test.example.com";
const GCP_PROJECT = "acme-staging-4321";
const PROD_PROJECT = "acme-prod-1234";
const deny = { accountIds: [], hosts: ["api.acme-prod.example.com", "*.live-vendor.example.com"], arnPrefixes: [], gcpProjects: [PROD_PROJECT, "555555555"] };
const GOOGLE_HOSTS = ["firestore.googleapis.com", "pubsub.googleapis.com", "storage.googleapis.com", "bigquery.googleapis.com", "cloudresourcemanager.googleapis.com"];
const policy = (over: Partial<RealCheckPolicy> = {}): RealCheckPolicy => ({ hosts: [VENDOR, ...GOOGLE_HOSTS], gcpProjects: [GCP_PROJECT, "123456789"], graphqlPaths: ["/graphql"], prodDeny: deny, limits: { requestBytes: 4_096, bigQueryBytesBilled: 1_000_000_000 }, ...over });
const request = (method: string, url: string, over: Partial<RealCheckRequest> = {}): RealCheckRequest => ({ method, url, ...over });
const run = (method: string, url: string, over: Partial<RealCheckRequest> = {}, pol: RealCheckPolicy = policy()): RealCheckVerdict => classifyRealCheckRequest(request(method, url, over), pol);
const reason = (verdict: RealCheckVerdict) => (verdict.allow ? "allowed" : verdict.reason);
const json = (value: unknown) => JSON.stringify(value);
const http = (path: string) => `https://${VENDOR}${path}`;
const graphql = (query: string, extra: Record<string, unknown> = {}) => run("POST", http("/graphql"), { body: json({ query, ...extra }), headers: { "Content-Type": "application/json" } });
const fs = (path: string) => `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)${path}`;
const ps = (path: string) => `https://pubsub.googleapis.com/v1/projects/${GCP_PROJECT}${path}`;
const gcs = (path: string) => `https://storage.googleapis.com${path}`;
const bq = (path: string) => `https://bigquery.googleapis.com/bigquery/v2/projects/${GCP_PROJECT}${path}`;
const query = (sql: string, extra: Record<string, unknown> = {}) => run("POST", bq("/queries"), { body: json({ query: sql, ...extra }) });

describe("plain HTTP: reads", () => {
  it("allows GET and HEAD on an allowed host and labels them without values", () => {
    for (const method of ["GET", "HEAD"]) {
      const verdict = run(method, http("/v2/user/videos/7f3a9b2c11?cursor=SECRETVALUE&fields=a"));
      expect(verdict).toMatchObject({ allow: true, protocol: "http", method, host: VENDOR, operation: `${method} ${VENDOR} /v2/user/videos/{id}` });
      expect(JSON.stringify(verdict)).not.toContain("SECRETVALUE");
      expect(JSON.stringify(verdict)).not.toContain("7f3a9b2c11");
    }
    expect(run("GET", http("/"))).toMatchObject({ allow: true });
    expect(run("GET", http("/v2/items/"))).toMatchObject({ allow: true });
    expect(run("GET", `https://${VENDOR}:443/v2/items`)).toMatchObject({ allow: true });
  });

  it("lists operations when the connection does: a GET outside the list is not allowed, {id} is one segment", () => {
    const listed = policy({ operations: ["GET /v2/user/videos/{id}", "GET /v2/user/info"] });
    expect(run("GET", http("/v2/user/videos/abc"), {}, listed)).toMatchObject({ allow: true });
    expect(run("HEAD", http("/v2/user/videos/abc"), {}, listed)).toMatchObject({ allow: true });
    expect(run("GET", http("/v2/user/info"), {}, listed)).toMatchObject({ allow: true });
    for (const path of ["/v2/user/videos", "/v2/user/videos/abc/extra", "/v2/user", "/v2/other", "/v2/user/info/x"]) expect(reason(run("GET", http(path), {}, listed)), path).toBe("not_allowed");
    expect(isRealCheckOperationTemplate("GET /v2/user/{id}")).toBe(true);
    for (const bad of ["POST /v2/x", "GET v2/x", "GET /v2/*", "GET /v2//x", "GET /v2/{Id}", "get /v2/x", "GET /v2/x ", "", 5]) expect(isRealCheckOperationTemplate(bad), String(bad)).toBe(false);
  });
});

describe("plain HTTP: every write shape is refused", () => {
  it.each([["POST"], ["PUT"], ["PATCH"], ["DELETE"]])("%s is a write, with or without a body, on any path", (method) => {
    expect(reason(run(method, http("/v2/items")))).toBe("write");
    expect(reason(run(method, http("/v2/items/1"), { body: json({ a: 1 }) }))).toBe("write");
    expect(reason(run(method, http("/v2/items"), { headers: { "content-type": "application/json" }, body: "{}" }))).toBe("write");
  });

  it("other methods are not allowed; a method that is not an upper-case token is unreadable", () => {
    for (const method of ["OPTIONS", "TRACE", "CONNECT", "PROPFIND", "MKCOL"]) expect(reason(run(method, http("/v2/items"))), method).toBe("not_allowed");
    for (const method of ["get", "Get", "GET ", "G", "", "GET\n", "POST1", "A".repeat(20)]) expect(reason(run(method, http("/v2/items"))), JSON.stringify(method)).toBe("unreadable");
  });

  it("a GET that carries a body is refused, whatever the body says", () => {
    expect(reason(run("GET", http("/v2/items"), { body: json({ query: "{ a }" }) }))).toBe("not_allowed");
    expect(reason(run("HEAD", http("/v2/items"), { body: "x" }))).toBe("not_allowed");
  });

  it("a GET whose path names an action is a write: delete, cancel, send, refund, publish and the rest", () => {
    for (const path of [
      "/v2/post/publish", "/v2/items/1/delete", "/v2/orders/9/cancel", "/v2/mail/send", "/v2/payments/refund", "/v1/refunds/refund", "/v2/users/1/delete-account", "/v2/users/1/delete_account", "/v2/sendEmail", "/v2/orders/9/CANCEL",
      "/v2/orders%3Acancel", "/v2/orders/capture", "/v2/jobs/run", "/v2/keys/revoke", "/v2/tokens/rotate", "/v2/thing.delete", "/v2/export",
    ]) expect(reason(run("GET", http(path))), path).toBe("write");
    // Whole words only: a name that merely contains one is a read.
    for (const path of ["/v2/sender", "/v2/deleted-items", "/v2/runs/5", "/v2/updates", "/v2/publisher", "/v2/products/1", "/v2/reports", "/v2/unread", "/v2/resources", "/v2/allitems"]) expect(reason(run("GET", http(path))), path).toBe("allowed");
  });

  it("an action word with a common prefix or suffix is a write: unpublish, resend, deleteall, bulk-delete", () => {
    for (const path of ["/v1/posts/1/unpublish", "/v1/deleteall", "/v1/resend", "/v1/bulk-delete", "/v1/cancelAll", "/v1/orders/refundnow", "/v1/batch-send", "/v1/unsubscribe", "/v1/rerun"]) expect(reason(run("GET", http(path))), path).toBe("write");
  });

  it("an action word listed in the connection's operations does not make it a read", () => {
    expect(reason(run("GET", http("/v2/items/1/delete"), {}, policy({ operations: ["GET /v2/items/{id}/delete"] })))).toBe("write");
  });

  it("an action value in an action-style query is a write", () => {
    for (const q of ["action=delete", "action=DELETE", "method=cancel", "cmd=send", "op=refund", "operation=publish", "Action=delete&id=1", "action=%64elete", "do=remove"]) expect(reason(run("GET", http(`/v2/items?${q}`))), q).toBe("write");
    expect(reason(run("GET", http("/v2/items?action=list&op=get")))).toBe("allowed");
  });

  it("a method override is a write: a header in any case, or a query name", () => {
    for (const name of ["X-HTTP-Method-Override", "x-http-method-override", "X-Method-Override", "X-HTTP-Method", "X-HTTP-VERB"]) expect(reason(run("GET", http("/v2/items"), { headers: { [name]: "DELETE" } })), name).toBe("write");
    for (const q of ["_method=DELETE", "__method=delete", "%5Fmethod=DELETE", "$httpMethod=DELETE", "X-HTTP-Method-Override=PUT"]) expect(reason(run("GET", http(`/v2/items?${q}`))), q).toBe("write");
  });

  it("a GraphQL mutation or subscription in a GET query string is refused wherever the server routes it", () => {
    expect(reason(run("GET", http(`/v2/anything?query=${encodeURIComponent("mutation { deleteAll }")}`)))).toBe("write");
    expect(reason(run("GET", http(`/api/gql?mutation=${encodeURIComponent("mutation { a }")}`)))).toBe("write");
    expect(reason(run("GET", http(`/v1/graphql?query=${encodeURIComponent("subscription { a }")}`)))).toBe("write");
    expect(reason(run("GET", http(`/v2/search?query=${encodeURIComponent("{ not graphql")}`)))).toBe("allowed");
    expect(reason(run("GET", http("/v2/search?query=shoes")))).toBe("allowed");
    // A document this check cannot read (too deep) that still holds a mutation is refused, not passed.
    const deep = `query Q${"{a".repeat(70)}${"}".repeat(70)} mutation M{deleteAllUsers{ok}}`;
    expect(reason(run("GET", http(`/api/gql?query=${encodeURIComponent(deep)}&operationName=M`)))).toBe("write");
    expect(reason(run("GET", http(`/api/gql?query=${encodeURIComponent("{ unreadable Mutation")}`)))).toBe("write");
  });
});

describe("the URL is read strictly", () => {
  it("refuses a URL that is not a plain https URL", () => {
    for (const url of [
      `http://${VENDOR}/v2/items`, `https://user:pass@${VENDOR}/v2/items`, `https://${VENDOR}:8443/v2/items`, `https://${VENDOR}/v2/items#frag`, `https://${VENDOR}/v2/../admin`, `https://${VENDOR}/v2/%2e%2e/admin`,
      `https://${VENDOR}/v2/%2E%2E/admin`, `https://${VENDOR}/v2/./items`, `https://${VENDOR}/v2//items`, `https://${VENDOR}/v2/items;x=1`, `https://${VENDOR}/v2/it%2fems`, `https://${VENDOR}/v2/it%5cems`, `https://${VENDOR}/v2/%252e%252e`,
      `https://${VENDOR}/v2/it ems`, `https://${VENDOR}/v2/ite\\ms`, `https://${VENDOR}/v2/%zz`, `https://${VENDOR}/v2/%00`, `https://${VENDOR}/v2/items?a=%zz`, `https://${VENDOR}/café`, "ftp://x", "", "//x/y", "https:///x", `https://${VENDOR}/${"a/".repeat(3000)}`,
      `https://[::1]/x`, `https://${VENDOR}/v2/items?${"a=1&".repeat(60)}`,
    ]) expect(reason(run("GET", url)), url.slice(0, 80)).toBe("unreadable");
    expect(reason(classifyRealCheckRequest({ method: 5, url: 7 } as unknown as RealCheckRequest, policy()))).toBe("unreadable");
    expect(reason(classifyRealCheckRequest(null as unknown as RealCheckRequest, policy()))).toBe("unreadable");
    expect(reason(classifyRealCheckRequest({ method: "GET", url: http("/x"), body: 5 } as unknown as RealCheckRequest, policy()))).toBe("unreadable");
    expect(reason(classifyRealCheckRequest({ method: "GET", url: http("/x"), headers: { a: 5 } } as unknown as RealCheckRequest, policy()))).toBe("unreadable");
  });

  it("never throws, whatever the input", () => {
    for (const url of ["https://", "https://x", `https://${VENDOR}?`, `https://${VENDOR}/?%`, "https://" + "a".repeat(300)]) expect(() => run("GET", url)).not.toThrow();
  });
});

describe("GraphQL", () => {
  it("allows a query, with variables and an operation name", () => {
    expect(graphql("{ viewer { id } }")).toMatchObject({ allow: true, protocol: "graphql", method: "POST" });
    expect(graphql("query V($id: ID!) { video(id: $id) { title } }", { operationName: "V", variables: { id: "1" } })).toMatchObject({ allow: true });
    expect(graphql("query A { a }", { operationName: null, variables: null })).toMatchObject({ allow: true });
    expect(run("POST", http("/graphql"), { body: "{ viewer { id } }", headers: { "content-type": "application/graphql" } })).toMatchObject({ allow: true });
    expect(run("GET", http(`/graphql?query=${encodeURIComponent("{ viewer { id } }")}&operationName=A`))).toMatchObject({ allow: true, protocol: "graphql" });
  });

  it("refuses a mutation and a subscription", () => {
    expect(reason(graphql("mutation { deleteAll }"))).toBe("write");
    expect(reason(graphql("mutation M($id: ID!) { delete(id: $id) }", { operationName: "M" }))).toBe("write");
    expect(reason(graphql("query Q { a } mutation M { b }", { operationName: "Q" }))).toBe("write");
    expect(reason(graphql("# harmless\nmutation { a }"))).toBe("write");
    expect(reason(graphql("subscription { events }"))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: "mutation { a }", headers: { "Content-Type": "application/graphql" } }))).toBe("write");
    expect(reason(run("GET", http(`/graphql?query=${encodeURIComponent("mutation { a }")}`)))).toBe("write");
  });

  it("does not take a keyword inside a string, comment or name for a mutation", () => {
    expect(graphql('query { search(term: "mutation { x }") { id } }')).toMatchObject({ allow: true });
    expect(graphql("query mutation { a }")).toMatchObject({ allow: true });
  });

  it("refuses a document it cannot read, a persisted query, a batch, a repeated key, extra members and a query string on a POST", () => {
    expect(reason(graphql("query {"))).toBe("unreadable");
    expect(reason(graphql(""))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: json({ extensions: { persistedQuery: { sha256Hash: "a".repeat(64) } } }) }))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: json({ id: "persisted", variables: {} }) }))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: json([{ query: "{ a }" }, { query: "mutation { a }" }]) }))).toBe("unreadable");
    expect(reason(run("POST", http("/graphql"), { body: '{"query":"{ a }","query":"mutation { a }"}' }))).toBe("unreadable");
    expect(reason(graphql("{ a }", { extensions: {} }))).toBe("not_allowed");
    expect(reason(graphql("{ a }", { operationName: 5 }))).toBe("unreadable");
    expect(reason(graphql("{ a }", { variables: [1] }))).toBe("unreadable");
    expect(reason(run("POST", http(`/graphql?query=${encodeURIComponent("mutation { a }")}`), { body: json({ query: "{ a }" }) }))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: "query=%7Ba%7D", headers: { "content-type": "application/x-www-form-urlencoded" } }))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body: "not json" }))).toBe("unreadable");
    expect(reason(run("POST", http("/graphql")))).toBe("not_allowed");
    expect(reason(run("GET", http("/graphql")))).toBe("unreadable");
    expect(reason(run("GET", http("/graphql?query=%7Ba%7D&extra=1")))).toBe("not_allowed");
  });

  it("a POST to a path the connection did not declare as GraphQL is a write, even with a query body", () => {
    expect(reason(run("POST", http("/v2/graphql"), { body: json({ query: "{ a }" }) }))).toBe("write");
    expect(reason(run("POST", http("/GraphQL"), { body: json({ query: "{ a }" }) }))).toBe("write");
    expect(reason(run("POST", http("/graphql/extra"), { body: json({ query: "{ a }" }) }))).toBe("write");
    // The declared endpoint with a trailing slash is still that endpoint, and still only a query.
    expect(reason(run("POST", http("/graphql/"), { body: json({ query: "{ a }" }) }))).toBe("allowed");
    expect(reason(run("POST", http("/graphql/"), { body: json({ query: "mutation { a }" }) }))).toBe("write");
    expect(reason(run("POST", http("/graphql"), { body: json({ query: "{ a }" }) }, policy({ graphqlPaths: [] })))).toBe("write");
  });

  it("a JSON body sent as application/graphql is not a query: a selection set holds no string", () => {
    const polyglot = json({ query: "mutation { deleteAllUsers { ok } }" });
    expect(reason(run("POST", http("/graphql"), { body: polyglot, headers: { "content-type": "application/graphql" } }))).toBe("unreadable");
    expect(reason(run("POST", http("/graphql"), { body: '{"a": 1}', headers: { "content-type": "application/graphql" } }))).toBe("unreadable");
    expect(run("POST", http("/graphql"), { body: 'query ($a: String = "x") { a(b: "y", c: 3) { d } }', headers: { "content-type": "application/graphql" } })).toMatchObject({ allow: true });
  });

  it("a header name repeated in another case is not read: the forwarder sends one and this check read the other", () => {
    const headers = { "content-type": "application/graphql", "Content-Type": "application/json" };
    expect(reason(run("POST", http("/graphql"), { body: json({ query: "mutation { a }" }), headers }))).toBe("unreadable");
    expect(reason(run("GET", http("/v2/items"), { headers: { Accept: "a", accept: "b" } }))).toBe("unreadable");
    expect(reason(run("GET", fs("/documents/users/alice"), { headers: { Accept: "a", accept: "b" } }))).toBe("unreadable");
    expect(reason(run("GET", http("/v2/items"), { headers: { Accept: "a", "Accept-Language": "b" } }))).toBe("allowed");
  });

  it("enforces the request-size cap on the body", () => {
    const body = json({ query: `{ ${"a ".repeat(3_000)} }` });
    expect(Buffer.byteLength(body)).toBeGreaterThan(4_096);
    expect(reason(run("POST", http("/graphql"), { body }))).toBe("not_allowed");
    expect(reason(run("POST", http("/graphql"), { body }, policy({ limits: { requestBytes: 65_536, bigQueryBytesBilled: 1 } })))).toBe("allowed");
  });
});

describe("Google APIs: reads", () => {
  it("allows a Firestore get, list and query shapes", () => {
    expect(run("GET", fs("/documents/users/alice"))).toMatchObject({ allow: true, protocol: "google", operation: "GET firestore.googleapis.com /v1/projects/{p}/databases/{d}/documents/{path*}" });
    expect(run("GET", fs("/documents/users?pageSize=10&orderBy=name"))).toMatchObject({ allow: true });
    expect(run("POST", fs("/documents:runQuery"), { body: json({ structuredQuery: { from: [{ collectionId: "users" }] } }) })).toMatchObject({ allow: true });
    expect(run("POST", fs("/documents/users/alice:runQuery"), { body: json({ structuredQuery: {} }) })).toMatchObject({ allow: true });
    expect(run("POST", fs("/documents:runAggregationQuery"), { body: json({ structuredAggregationQuery: {} }) })).toMatchObject({ allow: true });
    expect(run("POST", fs("/documents:listCollectionIds"), { body: json({ pageSize: 5 }) })).toMatchObject({ allow: true });
  });

  it("allows Pub/Sub metadata reads, Storage reads (with an encoded object name), BigQuery metadata and the project lookup", () => {
    for (const path of ["/topics", "/topics/orders", "/topics/orders/subscriptions", "/subscriptions", "/subscriptions/worker"]) expect(run("GET", ps(path)), path).toMatchObject({ allow: true });
    expect(run("GET", gcs("/storage/v1/b/acme-staging-bucket"))).toMatchObject({ allow: true });
    expect(run("GET", gcs("/storage/v1/b/acme-staging-bucket/o?prefix=logs%2F&maxResults=5"))).toMatchObject({ allow: true });
    expect(run("GET", gcs("/storage/v1/b/acme-staging-bucket/o/reports%2F2026%2Fjan.csv?alt=media"))).toMatchObject({ allow: true });
    expect(run("GET", gcs("/download/storage/v1/b/acme-staging-bucket/o/x.csv"))).toMatchObject({ allow: true });
    for (const path of ["/datasets", "/datasets/d1", "/datasets/d1/tables", "/datasets/d1/tables/t1", "/datasets/d1/tables/t1/data?maxResults=10", "/jobs/job_1", "/queries/job_1?location=US"]) expect(run("GET", bq(path)), path).toMatchObject({ allow: true });
    expect(run("GET", `https://cloudresourcemanager.googleapis.com/v3/projects/${GCP_PROJECT}`)).toMatchObject({ allow: true });
    expect(run("POST", `https://cloudresourcemanager.googleapis.com/v3/projects/${GCP_PROJECT}:testIamPermissions`, { body: json({ permissions: ["storage.objects.create", "pubsub.topics.publish"] }) })).toMatchObject({ allow: true });
    expect(run("POST", ps("/topics/orders:testIamPermissions"), { body: json({ permissions: ["pubsub.topics.publish"] }) })).toMatchObject({ allow: true });
    expect(run("GET", `https://storage.googleapis.com/storage/v1/b/acme-staging-bucket/iam/testPermissions?permissions=storage.objects.create`)).toMatchObject({ allow: true });
  });

  it("accepts the project by number as well as by id", () => {
    expect(run("GET", "https://pubsub.googleapis.com/v1/projects/123456789/topics")).toMatchObject({ allow: true });
  });
});

describe("Google APIs: every write shape is refused", () => {
  it("Firestore: commit, batchWrite, begin/rollback transactions, create, patch, delete, listen, a read-write transaction in a query", () => {
    expect(reason(run("POST", fs("/documents:commit"), { body: json({ writes: [] }) }))).toBe("write");
    expect(reason(run("POST", fs("/documents:batchWrite"), { body: json({ writes: [] }) }))).toBe("write");
    expect(reason(run("POST", fs("/documents:beginTransaction"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", fs("/documents:rollback"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", fs("/documents/users"), { body: json({ fields: {} }) }))).toBe("write");
    expect(reason(run("POST", fs("/documents/users/alice:commit"), { body: "{}" }))).toBe("write");
    expect(reason(run("PATCH", fs("/documents/users/alice"), { body: json({ fields: {} }) }))).toBe("write");
    expect(reason(run("DELETE", fs("/documents/users/alice")))).toBe("write");
    expect(reason(run("PUT", fs("/documents/users/alice"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: json({ structuredQuery: {}, newTransaction: { readWrite: {} } }) }))).toBe("not_allowed");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: json({ structuredQuery: {}, transaction: "abc" }) }))).toBe("not_allowed");
  });

  it("Pub/Sub: publish, pull (it consumes), acknowledge, seek, create, delete", () => {
    expect(reason(run("POST", ps("/topics/orders:publish"), { body: json({ messages: [{ data: "eA==" }] }) }))).toBe("write");
    expect(reason(run("POST", ps("/subscriptions/worker:pull"), { body: json({ maxMessages: 1 }) }))).toBe("write");
    expect(reason(run("POST", ps("/subscriptions/worker:acknowledge"), { body: json({ ackIds: ["a"] }) }))).toBe("write");
    expect(reason(run("POST", ps("/subscriptions/worker:seek"), { body: "{}" }))).toBe("write");
    expect(reason(run("PUT", ps("/topics/new"), { body: "{}" }))).toBe("write");
    expect(reason(run("DELETE", ps("/topics/orders")))).toBe("write");
    expect(reason(run("PATCH", ps("/subscriptions/worker"), { body: "{}" }))).toBe("write");
    expect(reason(run("GET", ps("/subscriptions/worker:pull")))).toBe("not_allowed");
  });

  it("Storage: upload, insert, copy, rewrite, compose, patch, update, delete, watch, ACL and IAM changes", () => {
    expect(reason(run("POST", gcs("/upload/storage/v1/b/acme-staging-bucket/o?uploadType=media&name=x"), { body: "data" }))).toBe("write");
    expect(reason(run("POST", gcs("/storage/v1/b/acme-staging-bucket/o"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", gcs("/storage/v1/b/acme-staging-bucket/o/x/copyTo/b/other/o/y"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", gcs("/storage/v1/b/acme-staging-bucket/o/x/rewriteTo/b/other/o/y"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", gcs("/storage/v1/b/acme-staging-bucket/o/x/compose"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", gcs("/storage/v1/b/acme-staging-bucket/o/watch"), { body: "{}" }))).toBe("write");
    expect(reason(run("PATCH", gcs("/storage/v1/b/acme-staging-bucket/o/x"), { body: "{}" }))).toBe("write");
    expect(reason(run("PUT", gcs("/storage/v1/b/acme-staging-bucket/o/x"), { body: "{}" }))).toBe("write");
    expect(reason(run("PUT", gcs("/storage/v1/b/acme-staging-bucket/iam"), { body: "{}" }))).toBe("write");
    expect(reason(run("DELETE", gcs("/storage/v1/b/acme-staging-bucket/o/x")))).toBe("write");
    expect(reason(run("DELETE", gcs("/storage/v1/b/acme-staging-bucket")))).toBe("write");
    // Not in the table, so not a read: the XML API, the HMAC key list and a batch call.
    expect(reason(run("GET", gcs("/acme-staging-bucket/x.csv")))).toBe("not_allowed");
    expect(reason(run("GET", gcs("/storage/v1/projects/p/hmacKeys")))).toBe("not_allowed");
    expect(reason(run("POST", gcs("/batch/storage/v1"), { body: "x" }))).toBe("write");
  });

  it("BigQuery: jobs.insert, insertAll, create/delete/patch of datasets and tables, a routine call", () => {
    expect(reason(run("POST", bq("/jobs"), { body: json({ configuration: { query: { query: "SELECT 1" } } }) }))).toBe("write");
    expect(reason(run("POST", bq("/datasets/d1/tables/t1/insertAll"), { body: json({ rows: [] }) }))).toBe("write");
    expect(reason(run("POST", bq("/datasets"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", bq("/datasets/d1/tables"), { body: "{}" }))).toBe("write");
    expect(reason(run("DELETE", bq("/datasets/d1/tables/t1")))).toBe("write");
    expect(reason(run("DELETE", bq("/datasets/d1?deleteContents=true")))).toBe("write");
    expect(reason(run("PATCH", bq("/datasets/d1/tables/t1"), { body: "{}" }))).toBe("write");
    expect(reason(run("PUT", bq("/datasets/d1"), { body: "{}" }))).toBe("write");
    expect(reason(run("POST", bq("/jobs/job_1/cancel")))).toBe("write");
    expect(reason(run("POST", bq("/routines"), { body: "{}" }))).toBe("write");
  });

  it("a method override on a Google API is a write: the header, `$httpMethod`, `_method`", () => {
    expect(reason(run("GET", fs("/documents/users/alice"), { headers: { "X-HTTP-Method-Override": "DELETE" } }))).toBe("write");
    expect(reason(run("GET", fs("/documents/users/alice?$httpMethod=DELETE")))).toBe("write");
    expect(reason(run("GET", fs("/documents/users/alice?_method=DELETE")))).toBe("write");
    expect(reason(run("POST", ps("/topics/orders:testIamPermissions?%24httpMethod=DELETE"), { body: json({ permissions: ["a.b"] }) }))).toBe("write");
  });

  it("refuses a query name or value the row does not list, a body on a GET, an unreadable body, and bad permissions", () => {
    expect(reason(run("GET", fs("/documents/users?key=abc")))).toBe("not_allowed");
    expect(reason(run("GET", fs("/documents/users?access_token=abc")))).toBe("not_allowed");
    expect(reason(run("GET", fs("/documents/users?userProject=other")))).toBe("not_allowed");
    expect(reason(run("GET", fs("/documents/users?transaction=abc")))).toBe("not_allowed");
    expect(reason(run("GET", gcs("/storage/v1/b/b1/o/x?alt=sse")))).toBe("not_allowed");
    expect(reason(run("GET", fs("/documents/users"), { body: "{}" }))).toBe("not_allowed");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: "nope" }))).toBe("unreadable");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: json([1]) }))).toBe("unreadable");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: '{"structuredQuery":{},"structuredQuery":{}}' }))).toBe("unreadable");
    expect(reason(run("POST", fs("/documents:runQuery"), { body: json({ structuredQuery: {}, extra: 1 }) }))).toBe("not_allowed");
    const perms = (permissions: unknown) => run("POST", ps("/topics/orders:testIamPermissions"), { body: json({ permissions }) });
    for (const bad of [[], "x", ["not a permission"], ["a"], [5], Array.from({ length: 101 }, () => "a.b")]) expect(reason(perms(bad)), JSON.stringify(bad).slice(0, 30)).toBe("unreadable");
  });

  it("refuses an encoded colon, an encoded slash outside a Storage object name, and a path no row matches", () => {
    expect(reason(run("POST", fs("/documents%3Acommit"), { body: "{}" }))).toBe("write");
    expect(reason(run("GET", fs("/documents/users%3Aalice")))).toBe("unreadable");
    expect(reason(run("POST", fs("/documents/users%3Acommit:runQuery"), { body: json({ structuredQuery: {} }) }))).toBe("unreadable");
    expect(reason(run("GET", fs("/documents/users%2Falice")))).toBe("unreadable");
    expect(reason(run("GET", gcs("/storage/v1/b/b%2F1")))).toBe("unreadable");
    expect(reason(run("GET", "https://firestore.googleapis.com/v1/projects"))).toBe("not_allowed");
    expect(reason(run("GET", "https://firestore.googleapis.com/"))).toBe("not_allowed");
    expect(reason(run("GET", "https://compute.googleapis.com/compute/v1/projects/x/instances", {}, policy({ hosts: [...GOOGLE_HOSTS, "compute.googleapis.com"] })))).toBe("not_allowed");
  });

  it("each row of the table is itself a read: a GET row never carries a body and a POST row's members never include a write member", () => {
    for (const row of REAL_CHECK_GOOGLE_ROWS) {
      if (row.method === "GET") expect(row.body).toBeUndefined();
      for (const member of row.body ?? []) expect(member).not.toMatch(/^(writes|transaction|newTransaction|destinationTable|createSession|connectionProperties|configuration|rows|messages|ackIds)$/u);
      expect(row.path).not.toMatch(/:(commit|batchWrite|publish|pull|acknowledge|seek|rollback|beginTransaction|listen|write)$/u);
    }
  });
});

describe("Google APIs: the project", () => {
  it("a request names the connection's own project and no other", () => {
    expect(reason(run("GET", "https://pubsub.googleapis.com/v1/projects/some-other-project/topics"))).toBe("not_allowed");
    expect(reason(run("GET", "https://pubsub.googleapis.com/v1/projects/987654321/topics"))).toBe("not_allowed");
    expect(reason(run("GET", "https://pubsub.googleapis.com/v1/projects/ACME-STAGING-4321/topics"))).toBe("not_allowed");
    expect(reason(run("GET", `https://cloudresourcemanager.googleapis.com/v3/projects/some-other-project`))).toBe("not_allowed");
  });

  it("a project on the company's production list is refused as production, even if the connection lists it", () => {
    const misconfigured = policy({ gcpProjects: [GCP_PROJECT, PROD_PROJECT, "555555555"] });
    expect(reason(run("GET", `https://pubsub.googleapis.com/v1/projects/${PROD_PROJECT}/topics`, {}, misconfigured))).toBe("prod");
    expect(reason(run("GET", "https://pubsub.googleapis.com/v1/projects/555555555/topics", {}, misconfigured))).toBe("prod");
    expect(reason(run("GET", `https://pubsub.googleapis.com/v1/projects/${PROD_PROJECT.toUpperCase()}/topics`, {}, misconfigured))).toBe("prod");
  });

  it("a BigQuery default dataset in another project is not allowed", () => {
    expect(reason(query("SELECT 1", { defaultDataset: { projectId: "other-project-1", datasetId: "d" } }))).toBe("not_allowed");
    expect(reason(query("SELECT 1", { defaultDataset: { projectId: GCP_PROJECT, datasetId: "d" } }))).toBe("allowed");
    expect(reason(query("SELECT 1", { defaultDataset: "d" }))).toBe("unreadable");
  });
});

describe("BigQuery: a SELECT with a forced cap, never a write", () => {
  it("allows a SELECT and a WITH, and forces the bytes cap", () => {
    const plain = query("SELECT id FROM `acme-staging-4321.d.t` LIMIT 10");
    expect(plain).toMatchObject({ allow: true, bigQuery: { maximumBytesBilled: "1000000000", dryRun: false } });
    if (!plain.allow) throw new Error("expected allow");
    expect(JSON.parse(plain.forwardBody ?? "{}")).toMatchObject({ query: "SELECT id FROM `acme-staging-4321.d.t` LIMIT 10", maximumBytesBilled: "1000000000" });
    expect(query("WITH a AS (SELECT 1 AS x) SELECT x FROM a;")).toMatchObject({ allow: true });
    expect(query("select 1", { dryRun: true })).toMatchObject({ allow: true, bigQuery: { dryRun: true } });
  });

  it("lowers a higher cap to the connection's, keeps a lower one, and refuses a figure it cannot read", () => {
    const cap = (value: unknown) => {
      const verdict = query("SELECT 1", { maximumBytesBilled: value });
      return verdict.allow ? verdict.bigQuery?.maximumBytesBilled : reason(verdict);
    };
    expect(cap("999999999999999")).toBe("1000000000");
    expect(cap(5e12)).toBe("1000000000");
    expect(cap("500")).toBe("500");
    expect(cap(500)).toBe("500");
    for (const bad of ["0", 0, "-1", "1e9", "abc", "", " 5", "05", -1, 1.5, true, null, {}]) expect(cap(bad), JSON.stringify(bad)).toBe("unreadable");
    const own = query("SELECT 1", { maximumBytesBilled: "999999999999" });
    if (!own.allow) throw new Error("expected allow");
    expect((JSON.parse(own.forwardBody ?? "{}") as { maximumBytesBilled: string }).maximumBytesBilled).toBe("1000000000");
    // The default cap applies when the policy names none.
    const defaulted = run("POST", bq("/queries"), { body: json({ query: "SELECT 1" }) }, policy({ limits: undefined }));
    expect(defaulted).toMatchObject({ allow: true, bigQuery: { maximumBytesBilled: String(REAL_CHECK_LIMIT_DEFAULTS.bigQueryBytesBilled) } });
  });

  it.each([
    ["INSERT INTO d.t VALUES (1)"], ["insert into d.t select 1"], ["UPDATE d.t SET a = 1 WHERE true"], ["DELETE FROM d.t WHERE true"], ["MERGE d.t USING d.s ON true WHEN MATCHED THEN DELETE"],
    ["CREATE TABLE d.t AS SELECT 1"], ["CREATE OR REPLACE TABLE d.t AS SELECT 1"], ["DROP TABLE d.t"], ["ALTER TABLE d.t ADD COLUMN c INT64"], ["TRUNCATE TABLE d.t"],
    ["EXPORT DATA OPTIONS(uri='gs://b/x') AS SELECT 1"], ["LOAD DATA INTO d.t FROM FILES(uri)"], ["CALL d.proc()"], ["EXECUTE IMMEDIATE 'DROP TABLE d.t'"], ["BEGIN SELECT 1; END"], ["DECLARE x INT64; SELECT x"],
    ["SET x = 1"], ["GRANT `roles/viewer` ON TABLE d.t TO 'user:a@b.c'"], ["COMMIT"], ["ROLLBACK"], ["BEGIN TRANSACTION"], ["ASSERT true"],
    ["SELECT 1; DROP TABLE d.t"], ["SELECT 1; SELECT 2"], ["SELECT 1;\n-- x\nDROP TABLE d.t;"], ["SELECT 1 /* x */ ; INSERT INTO d.t VALUES (1)"],
    ["WITH a AS (SELECT 1) DELETE FROM d.t WHERE true"], ["WITH a AS (SELECT 1) INSERT INTO d.t SELECT * FROM a"],
    ["FROM d.t |> SELECT a"], ["   "], ["-- only a comment"], ["SELECT 1 UNION ALL SELECT 2; DELETE FROM d.t"],
  ])("refuses %s", (sql) => {
    const verdict = query(sql);
    expect(verdict.allow, sql).toBe(false);
  });

  it("a write word inside a string, a comment or a quoted name does not make a read a write", () => {
    expect(query("SELECT 'delete from t; drop table x' AS s")).toMatchObject({ allow: true });
    expect(query("SELECT 1 -- ; DROP TABLE x")).toMatchObject({ allow: true });
    expect(query("SELECT /* DELETE */ 1")).toMatchObject({ allow: true });
    expect(query("SELECT * FROM `acme-staging-4321.d.update`")).toMatchObject({ allow: true });
    expect(query("SELECT update_time, create_time FROM d.t")).toMatchObject({ allow: true });
    expect(query('SELECT "a;b"')).toMatchObject({ allow: true });
    expect(query("SELECT '''a;b'''")).toMatchObject({ allow: true });
    expect(query("(SELECT 1)")).toMatchObject({ allow: true });
  });

  it("a string, comment or quoted name left open is unreadable, not a read", () => {
    for (const sql of ["SELECT 'open", "SELECT /* open", "SELECT `open", 'SELECT """open', "SELECT 'a\nb'", "SELECT 'it\\'s; DROP'"]) expect(bigQueryStatementIsRead(sql), sql).toBe("unreadable");
    expect(bigQueryStatementIsRead(5)).toBe("unreadable");
    expect(bigQueryStatementIsRead("")).toBe("unreadable");
    expect(bigQueryStatementIsRead("x".repeat(70_000))).toBe("unreadable");
  });

  it("a backslash anywhere is unreadable: raw strings take no escapes and other strings and quoted names do, so BigQuery would read a script here as a read", () => {
    const rawString = "SELECT r'\\' AS a; DELETE FROM d.t WHERE TRUE; SELECT '\\'' AS b";
    const quotedName = "SELECT 1 AS `a\\` 'q`; DELETE FROM d.t WHERE TRUE; SELECT '#'";
    for (const sql of [rawString, quotedName, "SELECT REGEXP_CONTAINS(x, r'\\d+') FROM d.t", "SELECT 'a\\nb'"]) {
      expect(bigQueryStatementIsRead(sql), sql).toBe("unreadable");
      expect(reason(query(sql, { useLegacySql: false })), sql).toBe("unreadable");
    }
  });

  it("a table of another project, or one on the production list, is not read: p.d.t names its project", () => {
    expect(query("SELECT * FROM `acme-staging-4321.d.t`")).toMatchObject({ allow: true });
    expect(query("SELECT * FROM acmestaging.d.t", {}).allow).toBe(false);
    expect(reason(query("SELECT * FROM `acme-prod-1234.sales.orders`"))).toBe("prod");
    expect(reason(query("SELECT * FROM `ACME-PROD-1234.sales.orders`"))).toBe("prod");
    expect(reason(query("SELECT * FROM `555555555.sales.orders`"))).toBe("prod");
    expect(reason(query("SELECT * FROM `other-project-9.d.t`"))).toBe("not_allowed");
    expect(reason(query("SELECT * FROM `other-project-9`.d.t"))).toBe("not_allowed");
    expect(reason(query("SELECT * FROM other_project.d.t"))).toBe("not_allowed");
    expect(reason(query("SELECT a.b.c FROM d.t AS a"))).toBe("not_allowed");
    expect(reason(query("SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS"))).toBe("not_allowed");
    expect(reason(query("SELECT * FROM x JOIN `acme-prod-1234.sales.orders` USING (id)"))).toBe("prod");
    expect(reason(query("SELECT * FROM d.t, `acme-prod-1234`.sales.orders"))).toBe("prod");
    expect(query("SELECT 1.5 AS x, 'acme-prod-1234.sales.orders' AS y")).toMatchObject({ allow: true });
    expect(query("SELECT * FROM d.t -- acme-prod-1234.sales.orders")).toMatchObject({ allow: true });
    expect(bigQueryProjectRefs("SELECT * FROM `p-1.d.t` JOIN p2.d.t USING (id)")).toEqual(["p-1", "p2"]);
    expect(bigQueryProjectRefs("SELECT 'it' ")).toEqual([]);
    expect(bigQueryProjectRefs("SELECT 'open")).toBeUndefined();
  });

  it("a user-defined, remote or model function is not a read: a dotted name that is not a BigQuery namespace, and ML.* and AI.* with it", () => {
    for (const sql of ["SELECT d.remote_fn(x) FROM d.t", "SELECT `acme-staging-4321.d.fn`(x) FROM d.t", "SELECT ML.GENERATE_TEXT(MODEL d.m, TABLE d.t) FROM d.t", "SELECT AI.GENERATE(x) FROM d.t", "SELECT p.d.fn(x)", "SELECT * FROM EXTERNAL_QUERY('c', 'select 1')"]) expect(query(sql).allow, sql).toBe(false);
    for (const sql of ["SELECT SAFE.PARSE_DATE('%Y', x), NET.HOST(y) FROM d.t", "SELECT COUNT(x), SUM(t.y) FROM d.t AS t"]) expect(query(sql).allow, sql).toBe(true);
  });

  it("refuses an unknown or session-creating member, a wrong type, and a dry run of a write", () => {
    for (const extra of [{ destinationTable: {} }, { createSession: true }, { connectionProperties: [{ key: "session_id", value: "x" }] }, { configuration: {} }, { labels: {} }, { jobCreationMode: "x" }]) expect(reason(query("SELECT 1", extra)), JSON.stringify(extra)).toBe("not_allowed");
    expect(reason(query("SELECT 1", { dryRun: "yes" }))).toBe("unreadable");
    expect(reason(query("SELECT 1", { useLegacySql: 1 }))).toBe("unreadable");
    expect(reason(query("DROP TABLE d.t", { dryRun: true }))).toBe("write");
    expect(reason(run("POST", bq("/queries"), { body: json({ dryRun: true }) }))).toBe("unreadable");
    expect(reason(run("POST", bq("/queries"), { body: '{"query":"SELECT 1","dryRun":true,"dryRun":false}' }))).toBe("unreadable");
  });
});

describe("the classifier's own caps fail closed", () => {
  it("a request or BigQuery cap that is not a whole number from 1 to Rovara's maximum refuses every request", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, "4096", null, 10 ** 15, 2 ** 60]) {
      expect(reason(run("GET", http("/v2/items"), {}, policy({ limits: { requestBytes: bad as number, bigQueryBytesBilled: 1_000_000_000 } }))), `request ${typeof bad} ${String(bad)}`).toBe("unreadable");
      expect(reason(query("SELECT 1", {}) && run("POST", bq("/queries"), { body: json({ query: "SELECT 1" }) }, policy({ limits: { requestBytes: 4_096, bigQueryBytesBilled: bad as number } }))), `bq ${typeof bad} ${String(bad)}`).toBe("unreadable");
    }
    expect(reason(run("GET", http("/v2/items"), {}, policy({ limits: { requestBytes: 1_048_576, bigQueryBytesBilled: 100_000_000_000 } })))).toBe("allowed");
    expect(reason(run("GET", http("/v2/items"), {}, policy({ limits: { requestBytes: 1_048_577, bigQueryBytesBilled: 1 } })))).toBe("unreadable");
  });
});

describe("hosts: production, model services and the allow-list", () => {
  it("refuses a host that is not one of the connection's", () => {
    expect(reason(run("GET", "https://other.example.com/v2/items"))).toBe("host_not_allowed");
    expect(reason(run("GET", `https://${VENDOR}.evil.example.com/v2/items`))).toBe("host_not_allowed");
    expect(reason(run("GET", `https://x.${VENDOR}/v2/items`))).toBe("host_not_allowed");
    expect(reason(run("GET", `https://${VENDOR}./v2/items`))).toBe("host_not_allowed");
    expect(reason(run("GET", "https://127.0.0.1/v2/items", {}, policy({ hosts: ["127.0.0.1"] })))).toBe("host_not_allowed");
    expect(reason(run("GET", "https://169.254.169.254/latest/meta-data", {}, policy({ hosts: ["169.254.169.254"] })))).toBe("host_not_allowed");
    expect(reason(run("GET", "https://2130706433/x", {}, policy({ hosts: ["2130706433"] })))).toBe("host_not_allowed");
    expect(reason(run("GET", http("/v2/items"), {}, policy({ hosts: [] })))).toBe("host_not_allowed");
  });

  it("is case-insensitive about the request's host", () => {
    expect(reason(run("GET", `https://${VENDOR.toUpperCase()}/v2/items`))).toBe("allowed");
  });

  it("refuses a production host even when the connection lists it: the list, a prod label, a vendor's production host", () => {
    const all = policy({ hosts: ["api.acme-prod.example.com", "eu.live-vendor.example.com", "api.prod.example.com", "login.salesforce.com", "api.live.example.com", "api.production.example.com", "api.prd.example.com"] });
    for (const host of ["api.acme-prod.example.com", "eu.live-vendor.example.com", "API.ACME-PROD.EXAMPLE.COM", "api.prod.example.com", "login.salesforce.com", "api.live.example.com", "api.production.example.com", "api.prd.example.com"]) expect(reason(run("GET", `https://${host}/v2/items`, {}, all)), host).toBe("prod");
    expect(reason(run("GET", "https://acme.my.salesforce.com/services/data", {}, policy({ hosts: ["acme.my.salesforce.com"] })))).toBe("prod");
    expect(reason(run("GET", "https://test.salesforce.com/services/data", {}, policy({ hosts: ["test.salesforce.com"] })))).toBe("allowed");
  });

  it("an empty or missing production list refuses everything", () => {
    expect(reason(run("GET", http("/v2/items"), {}, policy({ prodDeny: undefined })))).toBe("prod");
    expect(reason(run("GET", http("/v2/items"), {}, policy({ prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } })))).toBe("prod");
    expect(reason(run("GET", http("/v2/items"), {}, policy({ prodDeny: { accountIds: [], hosts: [], arnPrefixes: [], gcpProjects: [] } })))).toBe("prod");
    // A list that holds only a GCP project is a list.
    expect(reason(run("GET", http("/v2/items"), {}, policy({ prodDeny: { accountIds: [], hosts: [], arnPrefixes: [], gcpProjects: [PROD_PROJECT] } })))).toBe("allowed");
  });

  it("never reaches an AI model service, listed or not, in any spelling", () => {
    const models = policy({ hosts: ["api.openai.com", "generativelanguage.googleapis.com", "x.openai.azure.com", "gw.example.com", "api.anthropic.com"], modelGatewayHosts: ["gw.example.com"] });
    for (const host of ["api.openai.com", "API.OPENAI.COM", "api.openai.com.", "generativelanguage.googleapis.com", "x.openai.azure.com", "gw.example.com", "api.anthropic.com"]) expect(reason(run("GET", `https://${host}/v1/models`, {}, models)), host).toBe("model_host");
    expect(reason(run("GET", "https://api.openai.com/v1/models"))).toBe("model_host");
  });
});

describe("the verdict and the ledger label", () => {
  it("labels a path with {id} for every segment that is not a plain lower-case word or a version", () => {
    expect(realCheckPathLabel(["v2", "user", "videos", "7f3a9b2c11", "A1", "x_y", "9"])).toBe("/v2/user/videos/{id}/{id}/x_y/{id}");
    expect(realCheckPathLabel(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toBe("/a/b/c/d/e/f/g/h/…");
    expect(realCheckPathLabel([])).toBe("/");
    expect(realCheckPathLabel(["v2beta1", "v10"])).toBe("/v2beta1/v10");
  });

  it("never carries a query value, a body or a header, on an allowed or a refused call", () => {
    const marker = "ZQXV9marker";
    const verdicts = [
      run("GET", http(`/v2/items/${marker}?token=${marker}&q=${marker}`), { headers: { Authorization: `Bearer ${marker}` } }),
      run("POST", http(`/v2/items/${marker}?x=${marker}`), { body: json({ secret: marker }) }),
      run("GET", `https://other.example.com/${marker}?k=${marker}`),
      graphql(`mutation { a(x: "${marker}") }`),
      run("GET", fs(`/documents/users/${marker}?pageSize=${marker}`)),
      run("GET", `https://pubsub.googleapis.com/v1/projects/${marker}/topics`),
    ];
    for (const verdict of verdicts) expect(JSON.stringify(verdict), JSON.stringify(verdict)).not.toContain(marker);
  });

  it("only a BigQuery verdict forwards a rewritten body", () => {
    for (const verdict of [run("GET", http("/v2/items")), graphql("{ a }"), run("GET", fs("/documents/users/a"))]) expect(verdict.allow && "forwardBody" in verdict).toBe(false);
    expect("forwardBody" in (query("SELECT 1") as object)).toBe(true);
  });
});
