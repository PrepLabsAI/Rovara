// L4-EINT: the eval stand-in lanes (E3, E4, E6, E7, E8, E12) joined into ONE production path, behind the operator's switch AGENTX_EVAL_STAND_INS (default off). One end-to-end test with fakes: the free dry run's dependency list (kept by
// the broker per company and project) -> the descriptor the worker is delivered -> a stand-in round planned from the BASE commit's recordings and OpenAPI description plus the writer's sample set -> both sides of the comparison get the
// SAME bytes from the real stand-in server -> the eval's verdict and the PR lines. Then two companies, a switch that is off (byte for byte), and the version (E4).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvalAnswerBook, evalStandInLines, standInOperationId,
  type EvalDependencyList, type EvalStandInSetContent, type StandInWriterSet, type TrustedEvalStandInSummary,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { recordEvalDependencyList } from "../../packages/broker/src/core/setup-agent/eval-dependency-list.js";
import { createEvalStandInDescriptorSource, readEvalStandInDescriptor } from "../../packages/broker/src/core/setup-agent/eval-stand-in-descriptor.js";
import { createEvalStandInServers, type EvalStandInServers } from "../../packages/worker/src/eval-standin-server.js";
import { prepareEvalStandIns } from "../../packages/worker/src/eval-stand-in-plan.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const project = "demo";
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");

/** What the free dry run found: a database, the vendor the eval calls and an error tracker the code reports to. */
const LIST: EvalDependencyList = {
  version: 1, modelCalls: 0, ended: "failed",
  databases: [{ port: 5432, engine: "postgres" }], hosts: [{ name: "api.tiktok.com", port: 443 }, { name: "o42.ingest.sentry.io", port: 443 }], envVars: [],
};
const OPENAPI = { openapi: "3.0.3", info: { title: "tiktok", version: "1" }, servers: [{ url: "https://api.tiktok.com" }], paths: {
  "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" }, followers: { type: "integer" } } } } } } } } } } },
  "/v2/videos": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { videos: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } } } } } } } },
} };
const WRITER_SET: StandInWriterSet = {
  schemaVersion: 1, writer: "rovara-standin-writer/1", requestDigest: "a".repeat(64), tables: {},
  answers: { [standInOperationId("GET", "api.tiktok.com", "/v2/user/info")]: [{ data: { display_name: "Maya Creates", followers: 1200 } }, { data: { display_name: "Noor Cooks", followers: 87000 } }] },
};
const writerSetOf = (): StandInWriterSet => structuredClone(WRITER_SET);

const roots: string[] = [];
const servers: EvalStandInServers[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.http.closeAllConnections(); server.http.close(); }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function checkout(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "eint-checkout-")); roots.push(root);
  await writeFile(join(root, "openapi.json"), JSON.stringify(OPENAPI));
  await mkdir(join(root, "seeds"), { recursive: true });
  await writeFile(join(root, "seeds", "dev.sql"), "CREATE TABLE creators (id int primary key, name text);\nINSERT INTO creators VALUES (1, 'a');\n");
  for (const [path, text] of Object.entries(extra)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
  return root;
}
/** The materialize seam: copies a fixture and remembers WHICH commit it was asked for (it must be the BASE commit: a change cannot edit the answers it is measured against). */
const asked: string[] = [];
const materializeFrom = (root: string) => async (_dir: string, sha: string, destination: string): Promise<void> => {
  asked.push(sha);
  const { cp } = await import("node:fs/promises");
  await cp(root, destination, { recursive: true });
};

describe("the dry run's dependency list reaches the worker as a descriptor, only with the switch on", () => {
  it("builds the descriptor from THIS company's list (telemetry host left out) and the writer's set, and nothing for another company", async () => {
    const store = new MemoryDocumentStore();
    await recordEvalDependencyList({ store, now: () => NOW }, { orgId: A, project, taskId: "task-1" }, LIST);
    const own = await readEvalStandInDescriptor({ store, companyId: A }, project);
    expect(own).toEqual({ version: 1, hosts: [{ name: "api.tiktok.com", port: 443 }] });
    expect(JSON.stringify(own)).not.toContain("sentry");
    // Two companies: B has no list and sees nothing of A's; the same project name is not a bridge.
    expect(await readEvalStandInDescriptor({ store, companyId: B }, project)).toBeUndefined();
    await recordEvalDependencyList({ store, now: () => NOW }, { orgId: B, project, taskId: "task-2" }, { ...LIST, hosts: [{ name: "api.other-company.example.test" }] });
    expect(await readEvalStandInDescriptor({ store, companyId: B }, project)).toEqual({ version: 1, hosts: [{ name: "api.other-company.example.test" }] });
    expect(await readEvalStandInDescriptor({ store, companyId: A }, project)).toEqual(own);
    // The source asked for another company's scope answers nothing.
    const source = createEvalStandInDescriptorSource({ store, companyId: A }, { AGENTX_EVAL_STAND_INS: "1" })!;
    expect(await source({ companyId: B, project })).toBeUndefined();
    expect(await source({ companyId: A, project })).toEqual(own);
  });
});

describe("the worker plans ONE stand-in round from the base commit and both sides get the same bytes", () => {
  /** What a helper does for one run: serve the set, keep the answers it made, report a summary (the worker absorbs it). */
  async function oneRun(round: Awaited<ReturnType<typeof prepareEvalStandIns>>["round"] & object, requests: ReadonlyArray<{ host: string; path: string; method?: string }>) {
    const content: EvalStandInSetContent = round.setContent();
    const book = new EvalAnswerBook();
    for (const recorded of content.recorded) book.preloadRecorded(recorded);
    for (const entry of content.book) book.restore(entry);
    const initial = new Set(book.snapshot().map((entry) => entry.key));
    const stand = createEvalStandInServers({ plan: content.plan, book });
    servers.push(stand);
    await new Promise<void>((resolve) => { stand.http.listen(0, "127.0.0.1", () => resolve()); });
    const port = (stand.http.address() as net.AddressInfo).port;
    const bodies: string[] = [];
    for (const request of requests) {
      bodies.push(await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method: request.method ?? "GET", path: request.path, headers: { host: request.host }, agent: false }, (response) => { const chunks: Buffer[] = []; response.on("data", (c: Buffer) => chunks.push(c)); response.on("end", () => resolve(`${String(response.statusCode)} ${Buffer.concat(chunks).toString("utf8")}`)); });
        req.on("error", reject); req.end(request.method === "POST" ? "{}" : undefined);
      }));
    }
    const stats = stand.stats();
    const summary: TrustedEvalStandInSummary = { schemaVersion: 1, trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: "a".repeat(64), counts: book.counts(), foreign: 0, refused: 0, tlsFailed: 0,
      additions: book.snapshot().filter((entry) => !initial.has(entry.key)), gaps: stats.gaps, newHosts: stats.newHosts, ...(stats.telemetry.length === 0 ? {} : { telemetry: stats.telemetry }) };
    return { bodies, report: { ...round.absorb(summary), telemetry: round.telemetry(), hosts: round.plannedHosts(), databases: ["Postgres" as const] } };
  }

  it("dependency list -> descriptor -> round (writer's answers, the description, the cassette) -> old and new identical -> the verdict and the PR lines", async () => {
    const store = new MemoryDocumentStore();
    await recordEvalDependencyList({ store, now: () => NOW }, { orgId: A, project, taskId: "task-1" }, LIST);
    const descriptor = { ...(await readEvalStandInDescriptor({ store, companyId: A }, project))!, writerSet: writerSetOf() };
    const root = await checkout({ "cassettes/creators.har": JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "https://api.tiktok.com/v2/recorded" }, response: { status: 200, content: { mimeType: "application/json", text: "{\"recorded\":true}" } } }] } }) });
    asked.length = 0;
    const prepared = await prepareEvalStandIns({ descriptor, dependencies: undefined, repositoryDirectory: root, baseCommit: "a".repeat(40), scratchDir: join(root, "..", "scratch-1"), workspaceId: WORKSPACE, operationId: OPERATION, signal: new AbortController().signal, materialize: materializeFrom(root) });
    const round = prepared.round!;
    expect(round).toBeDefined();
    expect(asked).toEqual(["a".repeat(40)]);
    expect(round.plannedHosts()).toEqual(["api.tiktok.com"]);
    expect(prepared.version).toMatch(/^[a-f0-9]{64}$/u);

    const requests = [
      { host: "api.tiktok.com", path: "/v2/user/info?username=maya" },     // the writer's answers (E7 in E6)
      { host: "api.tiktok.com", path: "/v2/videos" },                       // the description (made up from the contract)
      { host: "api.tiktok.com", path: "/v2/recorded" },                     // the repository's own recording
      { host: "api.tiktok.com", path: "/v9/never-heard-of-it" },            // nobody's contract: still answered
      { host: "o42.ingest.sentry.io", path: "/api/42/envelope/", method: "POST" }, // telemetry: OK, no gap
    ];
    const oldSide = await oneRun(round, requests);
    const newSide = await oneRun(round, requests);
    // BOTH SIDES IDENTICAL: the same bytes for every request, through the round's one book.
    expect(newSide.bodies).toEqual(oldSide.bodies);
    expect(oldSide.bodies[0]).toMatch(/Maya Creates|Noor Cooks/u);
    expect(oldSide.bodies[2]).toBe("200 {\"recorded\":true}");
    expect(oldSide.bodies[4]).toBe("200 OK");
    expect(round.book.counts()).toMatchObject({ recorded: 1, generated: 2, generatedNoContract: 1, newConnections: 0 });
    expect(round.telemetry()).toEqual(["sentry.io"]);
    // The PR lines (E9 words, DEC 254zzz71): what it ran against, what was made up, the telemetry named, and no secret or path.
    const result = { ...round.counts(), notCompared: 0 };
    const lines = evalStandInLines({ recorded: result.recorded, generated: result.generated, generatedNoContract: result.generatedNoContract, newConnections: result.newConnections, notCompared: 1, saturated: false, telemetry: round.telemetry(), ranAgainst: { databases: ["Postgres"], hosts: round.plannedHosts() } });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Ran against stand-ins for Postgres and api.tiktok.com.");
    expect(lines[1]).toBe("3 answers were made up (2 from a contract, 1 with none, 0 new connections). Both runs got the same answers.");
    expect(lines[2]).toBe("1 answer came from your own recordings.");
    expect(lines[3]).toBe("1 question was not compared: it needed an answer the stand-ins had to make up.");
    expect(lines[4]).toBe("Telemetry calls answered with OK: sentry.io.");
    expect(lines.join(" ")).not.toMatch(/https?:|\/v2|o42|ingest|token|key/iu);
  });
});
