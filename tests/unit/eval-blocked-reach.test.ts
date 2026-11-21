// L4-TH1: when a sealed eval stops because it tried to reach something other than the model helper (a database port, an outside host), the "Not run" reason NAMES the blocked connection in fixed words: a database by its
// port, an outside service by its host name. The names are read from a closed list of error shapes (never from a URL), bounded to 3, redacted, and shown on the eval card (the health run's words), the check result and the
// pull request line. Every guard has a named mutant in briefs/lead4/l4-th1/MUTANTS.md.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_HEALTH_WORKER_REASONS, EvalBlockedReachSchema, EvalHealthResultBodySchema, EvalRunDiagnosticSchema, evalBlockedReachClause, evalHealthNotRunWords, evalRunFailureSentence,
  type EvalBlockedReach, type EvalRunDiagnostic,
} from "@agentx/contracts";
import { renderAiEvidence, renderPublicAi } from "../../packages/contracts/src/evidence-ai-render.js";
import { evidenceAiFromArtifact, publicEvidenceAi } from "../../packages/contracts/src/index.js";
import { EvalSandboxRunFailure, diagnoseEvalFailure, findBlockedReach } from "../../packages/worker/src/verification/eval-run-diagnostic.js";
import { runEvalHealthJob, type EvalHealthJobPorts } from "../../packages/worker/src/verification/eval-health-job.js";
import { deliverEvalHealthPlan, recordEvalHealthResult, startEvalHealthRun, type EvalHealthRunDeps } from "../../packages/broker/src/core/setup-agent/eval-health-run.js";
import { readEvalHealthRow, readEvalHealthView, requestEvalHealthCheck } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { A, B, CAP, NOW, ROLES, filesOf, company, person, project, reportOf } from "../support/eval-card-world.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";

// Built at run time: the public repository refuses key-shaped literals.
const TOKEN = ["Zk3pQ9vL2m", "Xa7TnR5wYc8", "UdB4hGe6JfS"].join("");
const PY_DB = ['psycopg2.OperationalError: could not translate host name "db" to address: Name or service not known'];
const PY_HTTP = [`requests.exceptions.ConnectionError: HTTPSConnectionPool(host='api.tiktok.com', port=443): Max retries exceeded with url: /v2/video/list?access_token=${TOKEN}&cursor=1 (Caused by NameResolutionError("<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to resolve 'api.tiktok.com' ([Errno -3] Temporary failure in name resolution)"))`];
const NODE_DB = ["Error: connect ECONNREFUSED 127.0.0.1:5432", "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16) {", "  errno: -111,", "  code: 'ECONNREFUSED',", "  syscall: 'connect',", "  address: '127.0.0.1',", "  port: 5432", "}"];
const NODE_HOST = [`TypeError: fetch failed`, `    at node:internal/deps/undici/undici:13502:13 {`, `  [cause]: Error: getaddrinfo ENOTFOUND open.tiktokapis.com`, `      at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {`, `    errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'open.tiktokapis.com'`];
const lines = (...parts: string[][]): string => ["Traceback (most recent call last):", '  File "evals/run.py", line 9, in <module>', ...parts.flat()].join("\n");
const run = (output: string, extra: { secrets?: string[]; exitCode?: number; timedOut?: boolean } = {}): EvalRunDiagnostic => diagnoseEvalFailure({ phase: "run", exitCode: extra.exitCode ?? 1, output, secrets: extra.secrets ?? [], ...(extra.timedOut === undefined ? {} : { timedOut: extra.timedOut }) });
const blockedOf = (diagnostic: EvalRunDiagnostic): EvalBlockedReach => { if (diagnostic.blocked === undefined) throw new Error(`not blocked: ${diagnostic.code}`); return diagnostic.blocked; };

describe("a sealed eval that tried to reach something else is named, in fixed words", () => {

  it("reads Python, Node, Go, MySQL, Redis and Mongo shapes", () => {
    expect(blockedOf(run(lines(PY_DB)))).toEqual({ items: [{ kind: "database" }] });
    expect(blockedOf(run(NODE_DB.join("\n")))).toEqual({ items: [{ kind: "database", port: 5432 }] });
    expect(blockedOf(run(NODE_HOST.join("\n")))).toEqual({ items: [{ kind: "service", host: "open.tiktokapis.com" }] });
    expect(blockedOf(run("panic: dial tcp 10.0.0.4:3306: connect: connection refused"))).toEqual({ items: [{ kind: "database", port: 3306 }] });
    expect(blockedOf(run("dial tcp: lookup api.stripe.com on 127.0.0.11:53: no such host"))).toEqual({ items: [{ kind: "service", host: "api.stripe.com" }] });
    expect(blockedOf(run("sqlalchemy.exc.OperationalError: (pymysql.err.OperationalError) (2003, \"Can't connect to MySQL server on 'mysql' ([Errno -2] Name or service not known)\")"))).toEqual({ items: [{ kind: "database" }] });
    expect(blockedOf(run("redis.exceptions.ConnectionError: Error 111 connecting to cache.internal:6379. Connection refused."))).toEqual({ items: [{ kind: "database", port: 6379 }] });
    expect(blockedOf(run("pymongo.errors.ServerSelectionTimeoutError: mongo:27017: [Errno -2] Name or service not known"))).toEqual({ items: [{ kind: "database", port: 27017 }] });
    expect(blockedOf(run("aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host hooks.slack.com:443 ssl:default [Name or service not known]"))).toEqual({ items: [{ kind: "service", host: "hooks.slack.com" }] });
    expect(blockedOf(run("asyncpg: ConnectionRefusedError: [Errno 111] Connect call failed ('127.0.0.1', 5432)"))).toEqual({ items: [{ kind: "database", port: 5432 }] });
    expect(blockedOf(run("ConnectTimeoutError: Connect Timeout Error (attempted address: api.openweathermap.org:443, timeout: 10000ms)"))).toEqual({ items: [{ kind: "service", host: "api.openweathermap.org" }] });
  });

  it("names only what is a host: an address, loopback, this machine and the model route are never named; a bare refusal stays 'exited'", () => {
    for (const output of [
      "Error: connect ECONNREFUSED 127.0.0.1:8080", "Error: connect ETIMEDOUT 52.1.2.3:443", "Error: getaddrinfo ENOTFOUND localhost", "Error: getaddrinfo ENOTFOUND rovara-models",
      "Error: getaddrinfo ENOTFOUND generativelanguage.googleapis.com", "Error: getaddrinfo ENOTFOUND us-central1-aiplatform.googleapis.com", "Error: getaddrinfo ENOTFOUND metadata.google.internal",
      "ConnectionRefusedError: [Errno 111] Connection refused", "socket.gaierror: [Errno -2] Name or service not known", "dial tcp [::1]:8080: connect: connection refused",
    ]) expect(run(output), output).toMatchObject({ code: "exited" });
    // A database on this machine is still a database (named by its port alone).
    expect(blockedOf(run("Error: connect ECONNREFUSED ::1:5432"))).toEqual({ items: [{ kind: "database", port: 5432 }] });
    expect(blockedOf(run("Error: getaddrinfo ENOTFOUND API.Example.COM."))).toEqual({ items: [{ kind: "service", host: "api.example.com" }] });
  });
});

describe("review fixes: model route, causes and cost", () => {

  it("hostile output is read in bounded time: one 16 KB line of repeated triggers, for every shape", () => {
    const hostile = [
      "ENOTFOUND ".repeat(1_700), "ENOTFOUND'".repeat(1_600), `HTTPSConnectionPool(host='a.com', port=1)`.repeat(450), "could not translate host name \"".repeat(500),
      "server running on host \"a\"".repeat(700), "getaddrinfo ENOTFOUND ".repeat(700), "dial tcp: lookup ".repeat(900), "Error 1 connecting to ".repeat(750), ("a".repeat(250) + ":").repeat(64),
    ];
    for (const text of hostile) {
      const started = Date.now();
      run(text);
      // #1297: 2 s, not 400 ms. The read is linear (16 KB of the slowest shape takes about 80 ms locally) and a shared CI runner took 405 ms; catastrophic
      // backtracking on 16 KB takes far longer than 2 s, so the guard still catches it.
      expect(Date.now() - started, text.slice(0, 30)).toBeLessThan(2_000);
    }
  });

  it("two databases are 'databases' with their ports; an opaque long label is not a host", () => {
    const d = run("Error: connect ECONNREFUSED 10.0.0.1:5432\nError: connect ECONNREFUSED 10.0.0.2:6379");
    expect(blockedOf(d).items).toEqual([{ kind: "database", port: 5432 }, { kind: "database", port: 6379 }]);
    expect(evalRunFailureSentence(d)).toBe("your eval tried to reach databases (ports 5432, 6379). Rovara's sealed check can't reach those yet");
    expect(run(`Error: getaddrinfo ENOTFOUND ${"a1b2c3d4e5".repeat(3)}xy.example.com`).code).toBe("exited");
    for (const port of [3306, 27017, 1433]) expect(blockedOf(run(`Error: connect ECONNREFUSED 10.0.0.1:${port}`)).items).toEqual([{ kind: "database", port }]);
  });

  it("the public list keeps 'more' and drops ports and hosts", () => {
    const d = run(`Error: getaddrinfo ENOTFOUND a1.example.com\nError: getaddrinfo ENOTFOUND a2.example.com\nError: getaddrinfo ENOTFOUND a3.example.com\nError: getaddrinfo ENOTFOUND a4.example.com`);
    expect(evalRunFailureSentence(d, { named: false })).toBe("your eval tried to reach outside services, among others. Rovara's sealed check can't reach those yet");
  });
});

describe("nothing secret-shaped leaks, whatever the line carried", () => {

  it("a host that carries a secret this run knows is not named, in any of its forms", () => {
    const secret = "runtoken0123456789abc";
    expect(run(`Error: getaddrinfo ENOTFOUND ${secret}.evil.example`, { secrets: [secret] })).toMatchObject({ code: "exited" });
    expect(run(`Error: getaddrinfo ENOTFOUND ${secret.toUpperCase()}.evil.example`, { secrets: [secret] })).toMatchObject({ code: "exited" });
    expect(run("Error: getaddrinfo ENOTFOUND build-7f3a.example.com", { secrets: ["unrelated-secret-value"] }).code).toBe("blocked_connection");
  });
});

describe("the list is bounded", () => {

  it("the same host or port seen again is one item; a huge output is read in a bounded way", () => {
    expect(blockedOf(run(Array.from({ length: 50 }, () => "Error: getaddrinfo ENOTFOUND api.same.com").join("\n"))).items).toHaveLength(1);
    const started = Date.now();
    const d = run(`${"x".repeat(2_000_000)}\n${NODE_HOST.join("\n")}`);
    expect(d.code).toBe("blocked_connection");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(findBlockedReach("a".repeat(100_000) + ":5432: [Errno 111] Connection refused")).toBeDefined();
  });

  it("the longest possible words fit the 300 characters the card takes, in the health run too", () => {
    const worst: EvalBlockedReach = { items: [{ kind: "database", port: 65535 }, { kind: "service", host: `${"a".repeat(40)}.example`.slice(0, 45) }, { kind: "service", host: `${"b".repeat(40)}.example`.slice(0, 45) }], more: true };
    expect(EvalBlockedReachSchema.safeParse(worst).success).toBe(true);
    expect(evalHealthNotRunWords("blocked_connection", worst).length).toBeLessThanOrEqual(300);
    const worstDb: EvalBlockedReach = { items: [{ kind: "database", port: 65535 }, { kind: "database", port: 65534 }, { kind: "service", host: "c".repeat(45) }], more: true };
    expect(evalHealthNotRunWords("blocked_connection", worstDb).length).toBeLessThanOrEqual(300);
  });
});

describe("the contract keeps the shape closed", () => {
  it("a blocked list goes with a blocked_connection and only with it", () => {
    const base = { phase: "run", tail: "" } as const;
    const blocked: EvalBlockedReach = { items: [{ kind: "database", port: 5432 }] };
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection", blocked }).success).toBe(true);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection" }).success).toBe(false);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "exited", blocked }).success).toBe(false);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection", blocked, name: "x" }).success).toBe(false);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection", blocked: { items: [{ kind: "database", port: 5432, host: "db.internal" }] } }).success).toBe(false);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection", blocked: { items: [{ kind: "database", port: 70000 }] } }).success).toBe(false);
    expect(EvalRunDiagnosticSchema.safeParse({ ...base, code: "blocked_connection", blocked: { items: [{ kind: "service", host: "a.com", path: "/x" }] } }).success).toBe(false);
  });

  it("an invalid list in a sentence falls back to the kind-less fixed words, never to the stored text", () => {
    expect(evalBlockedReachClause({ items: [{ kind: "service", host: "a.com/secret?token=1" }] } as unknown as EvalBlockedReach)).toBe("your eval tried to reach something other than the model. Rovara's sealed check can't reach that yet");
    expect(evalBlockedReachClause(undefined)).toMatch(/^your eval tried to reach something other than the model/u);
    expect(evalRunFailureSentence({ code: "blocked_connection" })).toMatch(/something other than the model/u);
  });
});

describe("it reaches the check result, the evidence and the pull request line", () => {
  const blocked = (): EvalRunDiagnostic => run(lines(NODE_DB, NODE_HOST), { secrets: [TOKEN] });

  it("the signed-in evidence names it; the public view keeps the kinds", () => {
    const artifact = { schemaVersion: 1 as const, candidateDigest: "a".repeat(64), roundKind: "check_unsealed" as const, evalPass: 1 as const, outcome: "not_run" as const, notRunReason: "eval_run_failed" as const, runFailure: blocked(),
      context: { aiChange: true, discovery: "configured" as const, previousPasses: 0 as const }, excluded: [], notices: [], usage: { calls: 0, costMicros: 0 }, cache: "not_used" as const, feedback: { notRun: true as const }, fixRequested: false, evalConfigured: true };
    const ai = evidenceAiFromArtifact(artifact, "a".repeat(64))!;
    const text = renderAiEvidence(ai).lines.join("\n");
    expect(text).toContain("Eval: Not run: your eval tried to reach a database (port 5432) and an outside service (open.tiktokapis.com). Rovara's sealed check can't reach those yet.");
    expect(text).not.toContain("Retry from the Rovara task page");
    expect(text).not.toContain(TOKEN);
    const publicText = renderPublicAi(ai as never).lines.join("\n");
    expect(publicText).toContain("Eval: Not run: your eval tried to reach a database and an outside service. Rovara's sealed check can't reach those yet.");
    expect(publicText).not.toMatch(/5432|tiktok/u);
    // The stored public projection holds the kinds only (mutant: keep the ports and hosts).
    const projected = publicEvidenceAi(ai);
    expect(projected?.eval.runFailure).toEqual({ code: "blocked_connection", phase: "run", tail: "", blocked: { items: [{ kind: "database" }, { kind: "service" }] } });
    expect(JSON.stringify(projected)).not.toMatch(/5432|tiktok/u);
  });
});

describe("the health run says what the eval tried to reach", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const signal = () => new AbortController().signal;
  const job = () => ({ requestId: randomUUID(), claimId: randomUUID() });
  async function jobWorld(failWith: () => Error) {
    const w = await createEvalFinalCheckWorld(true, 2); roots.push(w.root);
    const ports: EvalHealthJobPorts = { plan: () => w.ports.plan(), approval: w.ports.approval, meter: w.ports.meter, runner: async () => { throw failWith(); } };
    return { w, ports };
  }

  it("a blocked eval is posted as blocked_connection with the list; any other failure stays 'unavailable' with no list", async () => {
    const { ports } = await jobWorld(() => new EvalSandboxRunFailure(run(lines(NODE_DB, PY_HTTP), { secrets: [TOKEN] })));
    const answer = await runEvalHealthJob(job(), ports, signal());
    expect(EvalHealthResultBodySchema.safeParse(answer).success).toBe(true);
    expect(answer.result).toEqual({ status: "not_run", reason: "blocked_connection", blocked: { items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.tiktok.com" }] } });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    const plain = await runEvalHealthJob(job(), (await jobWorld(() => new EvalSandboxRunFailure(run("ModuleNotFoundError: No module named 'yaml'")))).ports, signal());
    expect(plain.result).toEqual({ status: "not_run", reason: "unavailable" });
    const generic = await runEvalHealthJob(job(), (await jobWorld(() => new Error(`getaddrinfo ENOTFOUND api.tiktok.com ${TOKEN}`))).ports, signal());
    expect(generic.result).toEqual({ status: "not_run", reason: "unavailable" });
  });

  it("the wire refuses a list that does not go with its reason, an unbounded list and extra keys", () => {
    const ok = { items: [{ kind: "database", port: 5432 }] };
    const body = (result: unknown) => ({ requestId: randomUUID(), claimId: randomUUID(), result });
    expect(EVAL_HEALTH_WORKER_REASONS).toContain("blocked_connection");
    expect(EvalHealthResultBodySchema.safeParse(body({ status: "not_run", reason: "blocked_connection", blocked: ok })).success).toBe(true);
    expect(EvalHealthResultBodySchema.safeParse(body({ status: "not_run", reason: "blocked_connection" })).success).toBe(true);
    expect(EvalHealthResultBodySchema.safeParse(body({ status: "not_run", reason: "unavailable", blocked: ok })).success).toBe(false);
    expect(EvalHealthResultBodySchema.safeParse(body({ status: "not_run", reason: "blocked_connection", blocked: { items: Array.from({ length: 9 }, () => ({ kind: "database" })) } })).success).toBe(false);
    expect(EvalHealthResultBodySchema.safeParse(body({ status: "not_run", reason: "blocked_connection", blocked: ok, message: "x" })).success).toBe(false);
  });

  const HEAD = "a".repeat(40);
  async function brokerWorld() {
    const w = company(A, { ...ROLES });
    const r = await w.run(filesOf(2), reportOf(2)); await r.approve();
    const clock = { now: NOW };
    const adapter = { async authority(request: { company: string; project: string; approver: { personId: string; provider: string } }) { return { company: request.company, project: request.project, principal: { companyId: request.company, personId: request.approver.personId, provider: request.approver.provider, displayName: "", roles: [] }, provider: "customer", connected: true }; }, async reserve() { return undefined; } };
    const registry = { names: (point: string) => point === "eval-reservation" ? ["test"] : [], get: () => adapter } as never;
    const deps = (over: Partial<EvalHealthRunDeps> = {}): EvalHealthRunDeps => ({
      store: w.store, companyId: A, now: () => clock.now, members: w.members, registry, monthlyCap: async () => CAP, mainHeads: async () => [{ repositoryId: "web", baseCommitSha: HEAD }],
      launch: async () => true, audit: async () => undefined, ...over,
    });
    await requestEvalHealthCheck({ store: w.store, companyId: A, now: () => clock.now, members: w.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000 }, person(A, "maintainer"));
    const row = (await readEvalHealthRow({ store: w.store, companyId: A }, project))!;
    const outcome = await startEvalHealthRun(deps(), project);
    if (outcome.outcome !== "started") throw new Error("not started");
    return { w, deps, clock, requestId: row.requestId, claimId: outcome.claimId };
  }
  const card = (b: Awaited<ReturnType<typeof brokerWorld>>) => readEvalCard({ store: b.w.store, companyId: A, members: b.w.members, monthlyCap: async () => CAP, healthRuns: true, now: () => b.clock.now }, project, person(A, "admin"));

  it("the broker keeps the list with the not-run reason and the card says it in fixed words, inside the 300 characters Cloud's card takes", async () => {
    const b = await brokerWorld();
    const result = { status: "not_run", reason: "blocked_connection", blocked: { items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.tiktok.com" }] } };
    expect((await recordEvalHealthResult(b.deps(), project, { requestId: b.requestId, claimId: b.claimId, result })).outcome).toBe("not_run");
    expect(await readEvalHealthRow({ store: b.w.store, companyId: A }, project)).toMatchObject({ state: "not_run", notRun: { reason: "blocked_connection", blocked: { items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.tiktok.com" }] } } });
    const view = await readEvalHealthView({ store: b.w.store, companyId: A, members: b.w.members, now: () => b.clock.now }, project);
    expect(view).toMatchObject({ state: "not_run", reason: "blocked_connection", blocked: { items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.tiktok.com" }] } });
    const read = await card(b);
    const words = read?.health?.words;
    expect(words).toBe("Not run: your eval tried to reach a database (port 5432) and an outside service (api.tiktok.com). Rovara's sealed check can't reach those yet.");
    expect(words!.length).toBeLessThanOrEqual(300);
  });

  it("two companies: another company's runner cannot record into, and its card never shows, this company's blocked list", async () => {
    const b = await brokerWorld();
    const other = company(B, { ...ROLES }, b.w.store);
    const result = { status: "not_run", reason: "blocked_connection", blocked: { items: [{ kind: "service", host: "api.tiktok.com" }] } };
    expect((await recordEvalHealthResult({ ...b.deps(), companyId: B, members: other.members }, project, { requestId: b.requestId, claimId: b.claimId, result })).outcome).toBe("refused");
    expect(await deliverEvalHealthPlan({ ...b.deps(), companyId: B, members: other.members }, project, { requestId: b.requestId, claimId: b.claimId })).toBeUndefined();
    expect((await readEvalHealthRow({ store: b.w.store, companyId: A }, project))!.state).toBe("running");
    expect((await recordEvalHealthResult(b.deps(), project, { requestId: b.requestId, claimId: b.claimId, result })).outcome).toBe("not_run");
    const bView = await readEvalHealthView({ store: b.w.store, companyId: B, members: other.members, now: () => b.clock.now }, project);
    expect(bView).toEqual({ state: "none" });
    expect(JSON.stringify(bView)).not.toContain("tiktok");
    // A planted list is read only through the strict row shape: a host with a path is not shown.
    const raw = (await b.w.store.get((await import("../../packages/broker/src/core/setup-agent/eval-health-request.js")).evalHealthRequestKey(A, project)))!;
    await b.w.store.put({ item: { ...raw, notRun: { reason: "blocked_connection", at: new Date(NOW).toISOString(), blocked: { items: [{ kind: "service", host: "evil.com/x?t=1" }] } } } });
    expect(await readEvalHealthRow({ store: b.w.store, companyId: A }, project)).toBeUndefined();
  });
});
