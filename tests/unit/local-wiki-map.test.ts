// Wiki W0 (DEC 254zh): the free file map on `rovara up`. The owner of the install only (no script token); a missing project is PROJECT_NOT_FOUND; the answer is the hosted route's.
import { describe, expect, it } from "vitest";
import { WikiFileMapViewSchema, type PluginKind } from "@agentx/contracts";
import { createLocalWikiMap } from "../../packages/broker/src/local/app/wiki-map.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";

const url = "https://github.com/acme/app.git";
const model = new FakeHostModel({ url, id: "1", fullName: "acme/app", initialFiles: { "src/a/one.ts": "x", "src/a/two.ts": "x", "src/a/three.ts": "x", ".env": "TOKEN=1" } });
const fake = new FakeCodeHost(model);
const github = Object.assign(Object.create(fake) as FakeCodeHost, { kind: "github" as PluginKind });
const registry = { names: () => ["github"], get: () => github } as never;
const flow = { projects: { latest: async (name: string) => (name === "app" ? { definition: { name: "app", repositories: [{ name: "app", url, defaultBranch: "main" }] } } : undefined) } } as never;
const owner = { principal: { roles: ["owner"] } } as never;
const request = (method: string, path = "/v1/app/projects/app/wiki-map") => ({ method, path, headers: {}, body: "" });

describe("local file map route", () => {
  it("lets the owner make a map and read it back, listing nothing secret-shaped", async () => {
    const routes = createLocalWikiMap({ flow, registry, now: () => Date.parse("2026-11-17T12:00:00Z") });
    expect(JSON.parse((await routes.routes(request("GET"), owner))!.body)).toEqual({ status: "none", canManage: true });
    const made = await routes.routes(request("POST"), owner);
    expect(made?.statusCode).toBe(200);
    const view = WikiFileMapViewSchema.parse(JSON.parse(made!.body));
    expect(view.status === "ready" && view.map.repositories[0]).toMatchObject({ status: "ok", files: 3, skipped: { secret: 1 } });
    expect(made!.body).not.toContain(".env");
    expect(JSON.parse((await routes.routes(request("GET"), owner))!.body)).toEqual(JSON.parse(made!.body));
  });

  it("refuses a script token and a caller that is not the owner, in fixed words", async () => {
    const routes = createLocalWikiMap({ flow, registry, now: () => 0 });
    for (const caller of [{ principal: { roles: ["owner"] }, scriptToken: { id: "t" } }, { principal: { roles: ["developer"] } }] as never[]) {
      const answer = await routes.routes(request("POST"), caller);
      expect(answer?.statusCode).toBe(403);
      expect(JSON.parse(answer!.body).error.message).toBe("only the owner of this install can map a project's files");
    }
  });

  it("says the project does not exist, and leaves other paths and methods to other routes", async () => {
    const routes = createLocalWikiMap({ flow, registry, now: () => 0 });
    expect((await routes.routes(request("GET", "/v1/app/projects/nope/wiki-map"), owner))?.statusCode).toBe(404);
    expect(await routes.routes(request("PUT"), owner)).toBeUndefined();
    expect(await routes.routes(request("DELETE"), owner)).toBeUndefined();
    expect(await routes.routes(request("GET", "/v1/app/projects/app/setup-agent"), owner)).toBeUndefined();
  });
});
