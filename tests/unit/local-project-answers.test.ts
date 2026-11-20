// The answer route on `rovara up` (lead 4, J1): the owner of this install only (no script token); the same answer service; the code on the project's registered code host at its head; a project that is not
// there and anyone else read the same.
import { describe, expect, it } from "vitest";
import { ANSWER_WORDS, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createLocalProjectAnswers } from "../../packages/broker/src/local/app/project-answers.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { HEAD, OLD, page, REFUND_TS, T0, answer, goodSentence, scriptedModel } from "../support/answer-world.js";

const url = "https://github.com/acme/app.git";
const reads: string[] = [];
const host = {
  kind: "github",
  baseBranchHead: async () => HEAD,
  fileAtRevision: async (_repo: unknown, path: string, revision: string) => { reads.push(`${path}@${revision.slice(0, 4)}`); return path === "src/refund.ts" ? REFUND_TS : undefined; },
};
const registry = { names: () => ["github"], get: (_kind: string, name: string) => (name === "github" ? host : undefined), require: () => host } as never;
const flow = { projects: { latest: async (name: string) => {
  if (name === "app") return { definition: { name: "app", repositories: [{ name: "web", url, path: "repo/web", defaultBranch: "main" }] } };
  // A project with a second repository whose code host is not registered here.
  if (name === "mixed") return { definition: { name: "mixed", repositories: [{ name: "web", url, path: "repo/web", defaultBranch: "main" }, { name: "api", url: "https://gitlab.example/acme/api.git", path: "repo/api", defaultBranch: "main", host: { kind: "gitlab" } }] } };
  return undefined;
} } } as never;
const principal = { provider: "local", personId: "owner", companyId: IMPLICIT_COMPANY_ID, roles: ["owner"] };
const owner = { principal } as never;
const request = (method = "POST", path = "/v1/app/projects/app/answers", body: unknown = { requestId: "request-0001", question: "How long do refunds last?" }) => ({ method, path, headers: {}, body: JSON.stringify(body) });

function make(model = scriptedModel([answer([goodSentence])])) {
  const store = new MemoryDocumentStore();
  return { store, model, routes: createLocalProjectAnswers({ flow, registry, store, model, now: () => T0 }) };
}

describe("the local answer route", () => {

  it("a script token, a caller who is not the owner and a project that is not there all read 'project not found', and nothing is opened", async () => {
    const { routes, model } = make();
    const same = { error: { code: "NOT_FOUND", message: ANSWER_WORDS.projectNotFound } };
    for (const [caller, path] of [[{ principal, scriptToken: { id: "t" } }, undefined], [{ principal: { ...principal, roles: ["developer"] } }, undefined], [owner, "/v1/app/projects/nope/answers"]] as const) {
      const answered = await routes.routes(request("POST", path), caller as never);
      expect(answered?.statusCode).toBe(404);
      expect(JSON.parse(answered!.body)).toEqual(same);
    }
    expect(model.opened).toHaveLength(0);
  });

  it("leaves other paths and methods to other routes, and a bad body is one fixed 400", async () => {
    const { routes } = make();
    expect(await routes.routes(request("GET"), owner)).toBeUndefined();
    expect(await routes.routes(request("POST", "/v1/app/projects/app/setup-agent"), owner)).toBeUndefined();
    expect(await routes.routes(request("POST", "/v1/app/projects/app/answers/x"), owner)).toBeUndefined();
    const bad = await routes.routes(request("POST", undefined, { question: "" }), owner);
    expect(bad?.statusCode).toBe(400);
    expect(JSON.parse(bad!.body)).toEqual({ error: { code: "CONFIG_INVALID", message: ANSWER_WORDS.badRequest } });
  });

  it("a repository whose code host is not registered here is not read and is not deleted: its wiki pages stay", async () => {
    const { routes, store } = make();
    const wiki = createWikiStore({ store, companyId: IMPLICIT_COMPANY_ID, now: () => T0 });
    await wiki.writePage("mixed", page("mixed", { repos: [{ repo: "api", commit: OLD }], claims: [{ claimId: "c0001", text: "api claim text", citations: [{ repo: "api", path: "a.ts", commit: OLD, line: 1, quote: "export const A = 1;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }] }));
    const answered = await routes.routes(request("POST", "/v1/app/projects/mixed/answers"), owner);
    expect(answered?.statusCode).toBe(200);
    expect((await wiki.readIndex("mixed")).map((entry) => entry.pageId)).toEqual(["billing"]);
  });
});
