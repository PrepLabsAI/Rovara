// Fake vendor APIs for the native connectors, one handler per vendor for `routeFetch` (tests/support/developer-fakes.ts). A handler
// answers only its own vendor's hosts (anything else is left to the next handler, and an unmatched request throws), checks the credential the way the vendor
// does, and records what it was asked so a test can say which host and path a connector reached. Tasks 14 to 17 add their vendors here.

export type VendorHandler = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;

export interface RecordedRequest { method: string; url: string; authorization: string | undefined }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get("authorization") ?? undefined;
}

export interface FakeSentryIssue {
  id: string;
  shortId: string;
  title: string;
  /** The slug of the project the issue is in. */
  project: string;
  level?: string;
  status?: string;
  count?: string;
}

export interface FakeSentryOptions {
  /** The only token the fake accepts; any other is a 401. */
  token: string;
  org?: string;
  regions?: readonly ("us" | "de")[];
  issues?: readonly FakeSentryIssue[];
  /** Answers every request with this status (a vendor outage, a 429). */
  status?: number;
  /** The project issues endpoint answers with every project's issues, as a misbehaving vendor (or a free-form query) could make it. */
  leakOtherProjects?: boolean;
}

/** Sentry's API as the Sentry connector uses it: `https://<us|de>.sentry.io/api/0/...` with `Authorization: Bearer <token>`. */
export function fakeSentry(options: FakeSentryOptions): { handler: VendorHandler; requests: RecordedRequest[] } {
  const org = options.org ?? "acme";
  const regions = options.regions ?? ["us", "de"];
  const hosts = new Set(regions.map((region) => `${region}.sentry.io`));
  const issues = options.issues ?? [
    { id: "101", shortId: "WEB-1", title: "TypeError: x is undefined", project: "web-app", level: "error", status: "unresolved", count: "42" },
    { id: "102", shortId: "WEB-2", title: "Timeout in checkout", project: "web-app", level: "warning", status: "unresolved", count: "7" },
    { id: "201", shortId: "API-1", title: "Database connection lost", project: "api-app", level: "fatal", status: "unresolved", count: "3" },
  ];
  const requests: RecordedRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization: authorizationOf(init) });
    if (options.status !== undefined) return json({ detail: "fake outage" }, options.status);
    if (authorizationOf(init) !== `Bearer ${options.token}`) return json({ detail: "Invalid token" }, 401);
    const path = url.pathname;
    const issueOf = (id: string) => issues.find((issue) => issue.id === id);
    const view = (issue: FakeSentryIssue) => ({
      id: issue.id, shortId: issue.shortId, title: issue.title, level: issue.level ?? "error", status: issue.status ?? "unresolved", count: issue.count ?? "1", userCount: 2,
      firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-22T00:00:00Z", culprit: "app/checkout", permalink: `https://sentry.io/organizations/${org}/issues/${issue.id}/`,
      project: { id: "1", slug: issue.project, name: issue.project }, metadata: { type: "TypeError", value: issue.title },
    });
    if (path === `/api/0/organizations/${org}/`) return json({ slug: org, name: "Acme" });
    const projectIssues = new RegExp(`^/api/0/projects/${org}/([^/]+)/issues/$`).exec(path);
    if (projectIssues !== null) {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return json(issues.filter((issue) => options.leakOtherProjects === true || issue.project === projectIssues[1]).slice(0, limit).map(view));
    }
    const latest = new RegExp(`^/api/0/organizations/${org}/issues/(\\d+)/events/latest/$`).exec(path);
    if (latest !== null) {
      const issue = issueOf(latest[1]!);
      if (issue === undefined) return json({ detail: "not found" }, 404);
      return json({
        eventID: `evt${issue.id}`, dateCreated: "2026-10-22T00:00:00Z", title: issue.title, message: issue.title, platform: "javascript",
        tags: [
          { key: "environment", value: "prod" }, { key: "release", value: "web@1.2.3" }, { key: "browser.name", value: "Chrome" },
          // What real events carry about the person and the request: none of it may reach the model.
          { key: "user", value: "id:4242" }, { key: "user.email", value: "private@example.com" }, { key: "url", value: "https://shop.example/cart?token=abc" },
          { key: "ip", value: "203.0.113.9" }, { key: "client_ip", value: "203.0.113.10" }, { key: "server_name", value: "web-7f9c" }, { key: "customer_id", value: "cus_123456" },
        ],
        user: { email: "private@example.com", ip_address: "203.0.113.9" },
        entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [{ filename: "app/checkout.js", function: "pay", lineNo: 42, inApp: true }] } }] } }],
      });
    }
    const one = new RegExp(`^/api/0/organizations/${org}/issues/(\\d+)/$`).exec(path);
    if (one !== null) {
      const issue = issueOf(one[1]!);
      return issue === undefined ? json({ detail: "not found" }, 404) : json(view(issue));
    }
    const releases = new RegExp(`^/api/0/projects/${org}/([^/]+)/releases/$`).exec(path);
    if (releases !== null) {
      return json([
        { version: "web@1.2.3", dateCreated: "2026-10-20T00:00:00Z", newGroups: 2, commitCount: 5, lastDeploy: { environment: "prod", dateFinished: "2026-10-20T01:00:00Z" } },
        { version: "web@1.2.2", dateCreated: "2026-10-10T00:00:00Z", newGroups: 0, commitCount: 1, lastDeploy: null },
      ]);
    }
    return json({ detail: "not found" }, 404);
  };
  return { handler, requests };
}

// ---- Datadog

export interface FakeDatadogMonitor { id: number; name: string; type?: string; overall_state?: string; tags: string[]; query?: string }

export interface FakeDatadogLog { id: string; service: string; tags: string[]; message: string; status?: string; host?: string }

export interface FakeDatadogOptions {
  apiKey: string;
  appKey: string;
  /** The API hosts it answers for; default api.datadoghq.eu. */
  hosts?: readonly string[];
  monitors?: readonly FakeDatadogMonitor[];
  /** A message the first log carries (to prove a key echoed back is scrubbed). */
  logMessage?: string;
  /** The logs a search answers with, whatever the search asked for (a vendor that ignores the filter). */
  logs?: readonly FakeDatadogLog[];
  /** Answers every request with this status (an outage, a 429). */
  status?: number;
}

export interface RecordedDatadogRequest { method: string; url: string; apiKey: string | undefined; appKey: string | undefined; body: unknown }

/** Datadog's API as the connector uses it: `https://api.<site>/api/...` with `DD-API-KEY` and `DD-APPLICATION-KEY`. */
export function fakeDatadog(options: FakeDatadogOptions): { handler: VendorHandler; requests: RecordedDatadogRequest[] } {
  const hosts = new Set(options.hosts ?? ["api.datadoghq.eu"]);
  const monitors = options.monitors ?? [
    { id: 11, name: "Payments latency", type: "metric alert", overall_state: "Alert", tags: ["service:payments", "env:prod", "team:core"], query: "avg(last_5m):avg:payments.latency{env:prod} > 2" },
    { id: 12, name: "Billing errors", type: "log alert", overall_state: "OK", tags: ["service:billing", "env:prod"], query: "logs(\"service:billing status:error\").index(\"*\").rollup(\"count\").last(\"5m\") > 10" },
  ];
  const requests: RecordedDatadogRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, apiKey: headers.get("dd-api-key") ?? undefined, appKey: headers.get("dd-application-key") ?? undefined, body });
    if (options.status !== undefined) return json({ errors: ["fake outage with details"] }, options.status);
    const apiOk = headers.get("dd-api-key") === options.apiKey;
    const appOk = headers.get("dd-application-key") === options.appKey;
    if (url.pathname === "/api/v1/validate") return apiOk ? json({ valid: true }) : json({ errors: ["Forbidden"] }, 403);
    if (!apiOk || !appOk) return json({ errors: ["Forbidden"] }, 403);
    if (url.pathname === "/api/v1/monitor/search") {
      return json({ monitors: monitors.map((monitor) => ({ id: monitor.id, name: monitor.name, status: monitor.overall_state, type: monitor.type, tags: monitor.tags })), metadata: { page: 0, page_count: 1, per_page: 25, total_count: monitors.length } });
    }
    const one = /^\/api\/v1\/monitor\/(\d+)$/.exec(url.pathname);
    if (one !== null) {
      const monitor = monitors.find((entry) => entry.id === Number(one[1]));
      return monitor === undefined ? json({ errors: ["Monitor not found"] }, 404) : json({ ...monitor, message: "Page the on-call @pagerduty-core" });
    }
    if (url.pathname === "/api/v1/query") {
      return json({ status: "ok", query: url.searchParams.get("query"), series: [{ metric: "payments.latency", scope: "service:payments,env:prod", pointlist: [[1_760_000_000_000, 1.5], [1_760_000_060_000, 2.5], [1_760_000_120_000, 0.5]] }] });
    }
    if (url.pathname === "/api/v2/logs/events/search" && init?.method === "POST") {
      const logs = options.logs ?? [
        { id: "l1", service: "payments", tags: ["env:prod"], message: options.logMessage ?? "charge failed for order 17", status: "error" },
        { id: "l2", service: "payments", tags: ["env:prod"], message: "charge started", status: "info" },
      ];
      return json({ data: logs.map((log, index) => ({ id: log.id, type: "log", attributes: { timestamp: `2026-10-22T10:0${String(index)}:00Z`, status: log.status ?? "info", service: log.service, ...(log.host === undefined ? {} : { host: log.host }), message: log.message, tags: log.tags } })) });
    }
    return json({ errors: ["not found"] }, 404);
  };
  return { handler, requests };
}

// ---- Grafana

export interface FakeGrafanaOptions {
  token: string;
  host?: string;
  /** A path the Grafana is served under, such as `/grafana`. */
  basePath?: string;
  /** Answers /api/health alone with this status (the rest keep working). */
  healthStatus?: number;
  /** Answers every request with this status. */
  status?: number;
  /** A body for /api/ds/query's result, to test failures. */
  queryError?: boolean;
}

export interface RecordedGrafanaRequest { method: string; url: string; authorization: string | undefined; body: unknown }

/** Grafana's HTTP API as the connector uses it: alert rules in two folders, firing alerts for them, two dashboards and a Prometheus data source. */
export function fakeGrafana(options: FakeGrafanaOptions): { handler: VendorHandler; requests: RecordedGrafanaRequest[] } {
  const host = options.host ?? "grafana.examplehost.com";
  const requests: RecordedGrafanaRequest[] = [];
  const rules = [
    { uid: "rule-pay", title: "Payments error rate", folderUID: "fold-pay", ruleGroup: "payments", condition: "C", for: "5m", noDataState: "NoData", execErrState: "Error", labels: { severity: "critical" }, annotations: { summary: "Payments are failing" }, data: [{ refId: "A", datasourceUid: "prom1", model: { expr: "rate(payments_errors_total[5m])" } }] },
    { uid: "rule-web", title: "Web latency", folderUID: "fold-web", ruleGroup: "web", condition: "C", for: "10m", labels: { severity: "warning" }, annotations: { summary: "Web is slow" }, data: [] },
  ];
  const dashboards: Record<string, unknown> = {
    "dash-pay": { dashboard: { uid: "dash-pay", title: "Payments overview", tags: ["payments"], panels: [{ id: 1, title: "Error rate", type: "timeseries", targets: [{ expr: "rate(payments_errors_total[5m])" }] }] }, meta: { folderUid: "fold-pay", folderTitle: "Payments", version: 3 } },
    "dash-web": { dashboard: { uid: "dash-web", title: "Web overview", tags: [], panels: [] }, meta: { folderUid: "fold-web", folderTitle: "Web", version: 1 } },
  };
  const handler: VendorHandler = async (url, init) => {
    if (url.hostname !== host) return undefined;
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization, body });
    if (options.status !== undefined) return json({ message: "fake outage with details" }, options.status);
    const path = options.basePath !== undefined && url.pathname.startsWith(`${options.basePath}/`) ? url.pathname.slice(options.basePath.length) : url.pathname;
    if (path === "/api/health" && options.healthStatus !== undefined) return json({ message: "unhealthy" }, options.healthStatus);
    if (path === "/api/health") return json({ commit: "abc", database: "ok", version: "11.0.0" });
    if (authorization !== `Bearer ${options.token}`) return json({ message: "Unauthorized" }, 401);
    if (path === "/api/user") return json({ id: 5, login: "sa-rovara", isServiceAccount: true });
    if (path === "/api/v1/provisioning/alert-rules") return json(rules);
    const rule = /^\/api\/v1\/provisioning\/alert-rules\/([^/]+)$/.exec(path);
    if (rule !== null) {
      const found = rules.find((entry) => entry.uid === rule[1]);
      return found === undefined ? json({ message: "not found" }, 404) : json(found);
    }
    if (path === "/api/alertmanager/grafana/api/v2/alerts") {
      return json([
        { labels: { alertname: "Payments error rate", __alert_rule_uid__: "rule-pay", grafana_folder: "Payments", severity: "critical" }, annotations: { summary: "Payments are failing" }, status: { state: "active" }, startsAt: "2026-10-22T09:00:00Z" },
        { labels: { alertname: "Web latency", __alert_rule_uid__: "rule-web", grafana_folder: "Web", severity: "warning" }, annotations: { summary: "Web is slow" }, status: { state: "active" }, startsAt: "2026-10-22T09:30:00Z" },
      ]);
    }
    const dashboard = /^\/api\/dashboards\/uid\/([^/]+)$/.exec(path);
    if (dashboard !== null) return dashboards[dashboard[1]!] === undefined ? json({ message: "Dashboard not found" }, 404) : json(dashboards[dashboard[1]!]);
    if (path === "/api/ds/query" && init?.method === "POST") {
      if (options.queryError === true) return json({ results: { A: { error: "bad expression near token", status: 400 } } });
      return json({ results: { A: { status: 200, frames: [{
        schema: { fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels: { job: "payments" } }] },
        data: { values: [[1_760_000_000_000, 1_760_000_060_000, 1_760_000_120_000], [1.5, 2.5, 0.5]] },
      }] } } });
    }
    return json({ message: "not found" }, 404);
  };
  return { handler, requests };
}

// ---- PagerDuty

export interface FakePagerDutyOptions {
  apiKey: string;
  /** The API hosts it answers for; default api.pagerduty.com. */
  hosts?: readonly string[];
  /** Answers every request with this status. */
  status?: number;
  /** The incident list ignores the `service_ids[]` filter, as a misbehaving vendor could. */
  ignoreServiceFilter?: boolean;
  /** The on-call list ignores the `escalation_policy_ids[]` filter. */
  ignoreOncallFilter?: boolean;
}

export interface RecordedPagerDutyRequest { method: string; url: string; authorization: string | undefined; accept: string | undefined }

/** PagerDuty's REST API v2 as the connector uses it: two services (PSVC001, PSVC002), their policies, incidents on each, and on-calls. */
export function fakePagerDuty(options: FakePagerDutyOptions): { handler: VendorHandler; requests: RecordedPagerDutyRequest[] } {
  const hosts = new Set(options.hosts ?? ["api.pagerduty.com"]);
  const services: Record<string, { id: string; summary: string; escalation_policy: { id: string; summary: string } }> = {
    PSVC001: { id: "PSVC001", summary: "Payments", escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
    PSVC002: { id: "PSVC002", summary: "Billing", escalation_policy: { id: "PEP0002", summary: "Billing on-call" } },
    // Shares the Payments escalation policy.
    PSVC003: { id: "PSVC003", summary: "Payments batch", escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
  };
  const incidents = [
    { id: "PINC001", incident_number: 101, title: "Payments API 5xx", status: "triggered", urgency: "high", service: { id: "PSVC001", summary: "Payments" }, created_at: "2026-10-22T09:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC001", assignments: [{ at: "2026-10-22T09:00:05Z", assignee: { id: "PUSER01", summary: "Dana Ops" } }], escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
    { id: "PINC002", incident_number: 102, title: "Payments latency", status: "resolved", urgency: "low", service: { id: "PSVC001", summary: "Payments" }, created_at: "2026-10-21T09:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC002" },
    { id: "PINC003", incident_number: 103, title: "Billing batch failed", status: "acknowledged", urgency: "high", service: { id: "PSVC002", summary: "Billing" }, created_at: "2026-10-22T08:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC003" },
  ];
  const requests: RecordedPagerDutyRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization: headers.get("authorization") ?? undefined, accept: headers.get("accept") ?? undefined });
    if (options.status !== undefined) return json({ error: { message: "fake outage with details" } }, options.status);
    if (headers.get("authorization") !== `Token token=${options.apiKey}`) return json({ error: { message: "Unauthorized", code: 2006 } }, 401);
    if (headers.get("accept") !== "application/vnd.pagerduty+json;version=2") return json({ error: { message: "bad version" } }, 400);
    if (url.pathname === "/abilities") return json({ abilities: ["teams", "urgencies"] });
    if (url.pathname === "/incidents") {
      const wanted = url.searchParams.getAll("service_ids[]");
      const statuses = url.searchParams.getAll("statuses[]");
      const found = incidents.filter((incident) => (options.ignoreServiceFilter === true || wanted.includes(incident.service.id)) && (statuses.length === 0 || statuses.includes(incident.status)));
      return json({ incidents: found, limit: 25, offset: 0, more: false });
    }
    const one = /^\/incidents\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (one !== null) {
      const found = incidents.find((incident) => incident.id === one[1]);
      return found === undefined ? json({ error: { message: "Not Found", code: 2100 } }, 404) : json({ incident: found });
    }
    const entries = /^\/incidents\/([A-Za-z0-9]+)\/log_entries$/.exec(url.pathname);
    if (entries !== null) {
      return json({ log_entries: [
        { id: "L1", type: "trigger_log_entry", summary: "Triggered through the API", created_at: "2026-10-22T09:00:00Z", agent: { id: "PAGENT1", type: "service_reference", summary: "Payments monitor" }, channel: { type: "api", details: "secret-routing-key-123" } },
        { id: "L2", type: "acknowledge_log_entry", summary: "Acknowledged by Dana Ops", created_at: "2026-10-22T09:05:00Z", agent: { id: "PUSER01", type: "user_reference", summary: "Dana Ops" } },
      ], limit: 50, offset: 0, more: false });
    }
    const service = /^\/services\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (service !== null) return services[service[1]!] === undefined ? json({ error: { message: "Not Found" } }, 404) : json({ service: services[service[1]!] });
    if (url.pathname === "/oncalls") {
      const policies = url.searchParams.getAll("escalation_policy_ids[]");
      const all = [
        { user: { id: "PUSER01", summary: "Dana Ops" }, escalation_policy: { id: "PEP0001", summary: "Payments on-call" }, escalation_level: 1, start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", schedule: { id: "PSCH001", summary: "Payments primary" } },
        { user: { id: "PUSER02", summary: "Eli Billing" }, escalation_policy: { id: "PEP0002", summary: "Billing on-call" }, escalation_level: 1, start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", schedule: { id: "PSCH002", summary: "Billing primary" } },
      ];
      return json({ oncalls: all.filter((entry) => options.ignoreOncallFilter === true || policies.includes(entry.escalation_policy.id)), limit: 25, offset: 0, more: false });
    }
    return json({ error: { message: "Not Found" } }, 404);
  };
  return { handler, requests };
}

// ---- Vercel

export interface FakeVercelOptions {
  token: string;
  /** Answers every request with this status. */
  status?: number;
  /** The deployment list ignores the `projectId` filter. */
  ignoreProjectFilter?: boolean;
}

export interface RecordedVercelRequest { method: string; url: string; authorization: string | undefined }

/** Vercel's REST API as the connector uses it: deployments of two projects (prj_web1, prj_api1) with build events. */
export function fakeVercel(options: FakeVercelOptions): { handler: VendorHandler; requests: RecordedVercelRequest[] } {
  const deployments = [
    { uid: "dpl_web1prod", name: "web", projectId: "prj_web1", readyState: "READY", state: "READY", target: "production", url: "web-abc.vercel.app", created: 1_760_000_000_000, creator: { uid: "u1", username: "dana", email: "dana@example.com" }, meta: { githubCommitMessage: "Fix checkout", githubCommitRef: "main", githubCommitSha: "abc123", githubCommitAuthorEmail: "dana@example.com" }, inspectorUrl: "https://vercel.com/acme/web/abc" },
    { uid: "dpl_web1prev", name: "web", projectId: "prj_web1", readyState: "ERROR", state: "ERROR", target: null, url: "web-def.vercel.app", created: 1_759_990_000_000, creator: { uid: "u1", username: "dana", email: "dana@example.com" }, meta: { githubCommitMessage: "Try a thing", githubCommitRef: "feature" }, errorMessage: "Build failed", errorCode: "BUILD_FAILED" },
    { uid: "dpl_api1prod", name: "api", projectId: "prj_api1", readyState: "READY", state: "READY", target: "production", url: "api-ghi.vercel.app", created: 1_759_980_000_000, creator: { uid: "u2", username: "eli" } },
  ];
  const requests: RecordedVercelRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (url.hostname !== "api.vercel.com") return undefined;
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization });
    if (options.status !== undefined) return json({ error: { code: "fake", message: "fake outage with details" } }, options.status);
    if (authorization !== `Bearer ${options.token}`) return json({ error: { code: "forbidden", message: "Not authorized" } }, 403);
    if (url.pathname === "/v2/user") return json({ user: { id: "AEIIDYVk59zbFF2Sxfyxxmua", username: "rovara" } });
    if (url.pathname === "/v7/deployments" || url.pathname === "/v6/deployments") {
      const project = url.searchParams.get("projectId");
      const target = url.searchParams.get("target");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const found = deployments.filter((entry) => (options.ignoreProjectFilter === true || entry.projectId === project) && (target === null || entry.target === target)).slice(0, limit);
      return json({ deployments: found, pagination: { count: found.length, next: null, prev: null } });
    }
    const one = /^\/v13\/deployments\/([^/]+)$/.exec(url.pathname);
    if (one !== null) {
      const found = deployments.find((entry) => entry.uid === one[1]);
      return found === undefined ? json({ error: { code: "not_found", message: "no such deployment" } }, 404) : json({ id: found.uid, ...found, createdAt: found.created });
    }
    const events = /^\/v3\/deployments\/([^/]+)\/events$/.exec(url.pathname);
    if (events !== null) {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const all = [
        { type: "command", created: 1_760_000_001_000, payload: { text: "npm run build", deploymentId: events[1], id: "e1", serial: "1", date: 1 } },
        { type: "stdout", created: 1_760_000_002_000, payload: { text: "compiled with a warning", deploymentId: events[1], id: "e2", serial: "2", date: 2 } },
        { type: "stderr", created: 1_760_000_003_000, payload: { text: "Error: boom in build", deploymentId: events[1], id: "e3", serial: "3", date: 3 } },
      ];
      // Like Vercel, `direction=backward` answers the newest first.
      return json((url.searchParams.get("direction") === "backward" ? [...all].reverse() : all).slice(0, limit));
    }
    return json({ error: { code: "not_found", message: "not found" } }, 404);
  };
  return { handler, requests };
}

// ---- GitHub Actions

export interface FakeGitHubActionsOptions {
  /** Answers every Actions and deployments request with this status. */
  status?: number;
  /** The text of job 7001's log, or a function of the installation tokens minted so far (to put one in the log). */
  logText?: string | ((tokens: readonly string[]) => string);
  /** Where the log request is redirected: a URL, or `null` for a 302 with no Location header. Default: a GitHub storage host. */
  logRedirect?: string | null;
  /** What the log request answers when it is not a redirect (a 200 with the text itself). */
  logInline?: boolean;
  /** The storage answers with a second redirect (to another storage host). */
  storageRedirects?: boolean;
  /** The lists answer with other repositories' items too, as a misbehaving vendor could. */
  leak?: boolean;
  /** The lists ignore the status, branch, environment and per_page the request names, as a misbehaving vendor could. */
  ignoreFilters?: boolean;
  /** The status the log request is redirected with (default 302). */
  logRedirectStatus?: number;
  /** How GitHub spells the owner in the addresses it answers with (default `example`; GitHub answers with the account's own capitals). */
  ownerCase?: string;
  /** The Actions and deployments endpoints answer 200 with text that is not JSON. */
  plainText?: boolean;
  /** `GET /actions/runs/{id}` answers with another run than the one asked for. */
  wrongItem?: boolean;
  /** How many jobs a run has (default 2), and how many steps its first job has (default 2). */
  jobCount?: number;
  stepCount?: number;
}

export interface RecordedGitHubRequest { method: string; url: string; authorization: string | undefined; body: unknown; userAgent?: string | undefined }

/** The repositories the fake knows, all under installation 55 of the owner `example`. */
export const FAKE_GITHUB_REPOSITORIES = { demo: 4242, other: 777, legacy: 5151 } as const;
export const FAKE_GITHUB_STORAGE_HOST = "pipelinesghubeus6.actions.githubusercontent.com";

/**
 * GitHub as the GitHub Actions connector uses it. The App endpoints (a repository's installation, an installation access token) take any bearer; every
 * repository endpoint takes only a token this fake minted, for a repository that token names, with the permission the endpoint needs (`actions` for
 * `/actions/...`, `deployments` for `/deployments`), and answers like GitHub otherwise. Storage hosts answer the log, and refuse an Authorization header.
 */
export function fakeGitHubActions(options: FakeGitHubActionsOptions = {}): { handler: VendorHandler; requests: RecordedGitHubRequest[]; minted(): RecordedGitHubRequest[]; tokens: string[] } {
  const requests: RecordedGitHubRequest[] = [];
  const tokens: string[] = [];
  const grants = new Map<string, { repositories: string[]; permissions: Record<string, string> }>();
  const api = (repository: string) => `https://api.github.com/repos/${options.ownerCase ?? "example"}/${repository}`;
  const run = (id: number, repository: keyof typeof FAKE_GITHUB_REPOSITORIES, over: Record<string, unknown> = {}) => ({
    id, name: "CI", display_title: `run ${String(id)}`, head_branch: "main", head_sha: "a".repeat(40), status: "completed", conclusion: "success", event: "push", run_number: id - 9000,
    created_at: "2026-10-22T09:00:00Z", updated_at: "2026-10-22T09:05:00Z", html_url: `https://github.com/example/${repository}/actions/runs/${String(id)}`,
    actor: { login: "dana", id: 1 }, repository: { id: FAKE_GITHUB_REPOSITORIES[repository], full_name: `example/${repository}` }, ...over,
  });
  const runs = [
    run(9001, "demo", { display_title: "Fix checkout", conclusion: "failure" }),
    run(9002, "demo", { display_title: "Try a thing", status: "in_progress", conclusion: null, head_branch: "feature" }),
    run(9003, "demo", { display_title: "Docs", conclusion: "success" }),
    run(9101, "other", { display_title: "Other repository secret work" }),
  ];
  const job = (id: number, runId: number, repository: string, over: Record<string, unknown> = {}) => ({
    id, run_id: runId, run_url: `${api(repository)}/actions/runs/${String(runId)}`, name: "build", status: "completed", conclusion: "failure",
    started_at: "2026-10-22T09:00:10Z", completed_at: "2026-10-22T09:04:00Z",
    steps: [{ name: "Set up job", status: "completed", conclusion: "success", number: 1 }, { name: "npm test", status: "completed", conclusion: "failure", number: 2 }], ...over,
  });
  const deployment = (id: number, repository: string, environment: string) => ({
    id, sha: "b".repeat(40), ref: "main", task: "deploy", environment, created_at: "2026-10-22T10:00:00Z", updated_at: "2026-10-22T10:01:00Z", creator: { login: "dana" }, repository_url: api(repository),
  });
  const deployments = [
    deployment(5001, "demo", "production"), deployment(5002, "demo", "staging"), deployment(6001, "other", "production"),
    // Each wrong in one way only: right path on another host, and an address that is a list holding the right one.
    { ...deployment(6002, "demo", "production"), repository_url: "https://evil.example/repos/example/demo" },
    { ...deployment(6003, "demo", "production"), repository_url: [api("demo")] },
  ];
  const status = (id: number, repository: string, deploymentId: number, state: string) => ({
    id, state, description: `deployment ${state}`, environment: "production", target_url: "https://shop.example/", log_url: "", created_at: "2026-10-22T10:02:00Z",
    deployment_url: `${api(repository)}/deployments/${String(deploymentId)}`, repository_url: api(repository),
  });
  const logLines = (): string => Array.from({ length: 300 }, (_unused, index) => `2026-10-22T09:00:${String(index % 60).padStart(2, "0")}.0000000Z line ${String(index + 1)} of the log`).join("\n");
  const handler: VendorHandler = async (url, init) => {
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const authorization = headers.get("authorization") ?? undefined;
    const isStorage = url.hostname.endsWith(".actions.githubusercontent.com") || url.hostname.endsWith(".blob.core.windows.net");
    if (url.hostname !== "api.github.com" && !isStorage) return undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization, body, userAgent: headers.get("user-agent") ?? undefined });
    // GitHub's API refuses a request with no User-Agent header (HTTP 403, not a permissions answer); node's own https request sends none, so every caller must set one.
    if (!isStorage && !headers.has("user-agent")) return new Response("Request forbidden by administrative rules. Please make sure your request has a User-Agent header.", { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
    if (isStorage) {
      if (authorization !== undefined) return json({ message: "storage takes no Authorization header" }, 400);
      if (options.storageRedirects === true) return new Response(null, { status: 302, headers: { location: `https://${FAKE_GITHUB_STORAGE_HOST}/second/log.txt` } });
      const text = typeof options.logText === "function" ? options.logText(tokens) : options.logText ?? logLines();
      return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
    }
    const installation = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (installation !== null) return installation[1] === "example" ? json({ id: 55, account: { login: "example" } }) : json({ message: "Not Found" }, 404);
    if (init?.method === "POST" && url.pathname === "/app/installations/55/access_tokens") {
      const asked = body as { repositories: string[]; permissions: Record<string, string> };
      const token = `ghs_fake${String(tokens.length + 1)}_${Object.keys(asked.permissions).sort().join("_")}`;
      tokens.push(token);
      grants.set(token, asked);
      return json({ token }, 201);
    }
    const repo = /^\/repos\/example\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (repo === null) return json({ message: "Not Found" }, 404);
    const grant = authorization?.startsWith("Bearer ") ? grants.get(authorization.slice(7)) : undefined;
    if (grant === undefined) return json({ message: "Bad credentials" }, 401);
    const name = repo[1]!;
    const rest = repo[2]!;
    if (!grant.repositories.includes(name)) return json({ message: "Not Found" }, 404);
    const needed = rest.startsWith("actions/") ? "actions" : rest.startsWith("deployments") ? "deployments" : "contents";
    if (grant.permissions[needed] !== "read") return json({ message: "Resource not accessible by integration" }, 403);
    if (options.status !== undefined) return json({ message: "fake outage with secret-detail-xyz" }, options.status);
    if (options.plainText === true && !rest.includes("/logs")) return new Response("not json at all", { status: 200 });
    const limit = options.ignoreFilters === true ? 100 : Number(url.searchParams.get("per_page") ?? "30");
    const known = (id: number) => name === "demo" && id > 0;
    if (rest === "actions/runs") {
      const wanted = url.searchParams.get("status");
      const branch = url.searchParams.get("branch");
      const found = runs.filter((entry) => (options.leak === true || entry.repository.full_name === `example/${name}`)
        && (options.ignoreFilters === true || branch === null || entry.head_branch === branch)
        && (options.ignoreFilters === true || wanted === null || entry.status === wanted || entry.conclusion === wanted));
      return json({ total_count: found.length, workflow_runs: found.slice(0, limit) });
    }
    const oneRun = /^actions\/runs\/(\d+)$/.exec(rest);
    if (oneRun !== null) {
      const found = options.wrongItem === true ? runs[2] : runs.find((entry) => entry.id === Number(oneRun[1]) && (options.leak === true || entry.repository.full_name === `example/${name}`));
      return found === undefined ? json({ message: "Not Found" }, 404) : json(found);
    }
    const jobs = /^actions\/runs\/(\d+)\/jobs$/.exec(rest);
    if (jobs !== null) {
      const id = Number(jobs[1]);
      if (!runs.some((entry) => entry.id === id && entry.repository.full_name === `example/${name}`)) return json({ message: "Not Found" }, 404);
      const steps = Array.from({ length: options.stepCount ?? 2 }, (_unused, index) => ({ name: index === 1 ? "npm test" : `step ${String(index + 1)}`, status: "completed", conclusion: index === 1 ? "failure" : "success", number: index + 1 }));
      const list = [job(7001, id, name, { steps }), job(7002, id, name, { name: "lint", conclusion: "success", steps: [] }),
        ...Array.from({ length: Math.max(0, (options.jobCount ?? 2) - 2) }, (_unused, index) => job(7100 + index, id, name, { name: `extra-${String(index)}`, steps: [] })),
        ...(options.leak === true ? [
          job(7999, 9101, "other", { name: "other-repo-job" }), job(7998, id + 1, name, { name: "another-run-job" }),
          // Each wrong in one way only: the run's id is another run's but the address is this one's; the id is this run's but the address is another repository's.
          job(7997, id + 2, name, { name: "wrong-run-id-job", run_url: `${api(name)}/actions/runs/${String(id)}` }),
          job(7996, id, "other", { name: "wrong-run-url-job" }),
        ] : [])];
      return json({ total_count: list.length, jobs: list });
    }
    const log = /^actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (log !== null) {
      if (!known(Number(log[1])) || Number(log[1]) !== 7001) return json({ message: "Not Found" }, 404);
      if (options.logInline === true) return new Response("inline log", { status: 200 });
      const location = options.logRedirect === undefined ? `https://${FAKE_GITHUB_STORAGE_HOST}/abc/log.txt?sig=1` : options.logRedirect;
      return new Response(null, { status: options.logRedirectStatus ?? 302, headers: location === null ? {} : { location } });
    }
    if (rest === "deployments") {
      const environment = url.searchParams.get("environment");
      const found = deployments.filter((entry) => (options.leak === true ? entry.id >= 5001 : entry.repository_url === api(name)) && (options.ignoreFilters === true || environment === null || entry.environment === environment));
      return json(found.slice(0, limit));
    }
    const statuses = /^deployments\/(\d+)\/statuses$/.exec(rest);
    if (statuses !== null) {
      const id = Number(statuses[1]);
      if (!deployments.some((entry) => entry.id === id && entry.repository_url === api(name))) return json({ message: "Not Found" }, 404);
      return json([status(1, name, id, "success"), status(2, name, id, "in_progress"),
        ...(options.leak === true ? [
          status(3, "other", 6001, "failure"),
          // Each wrong in one way only: this repository's address with another deployment's; another repository's address with this deployment's.
          { ...status(4, name, 5002, "queued") },
          { ...status(5, name, id, "error"), repository_url: api("other") },
        ] : [])]);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { handler, requests, minted: () => requests.filter((request) => request.url.endsWith("/access_tokens")), tokens };
}
