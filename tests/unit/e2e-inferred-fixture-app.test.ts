import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateManifest, inferNodeWebRecipe, type E2ESourceSnapshot } from "@agentx/contracts";
import { INFERRED_APP_FILES, INFERRED_FIXTURE_ROOT } from "../support/e2e-inferred-fixture.js";

// The Task 3.3 fixture app is what the Linux test and the journey run: a web app with a start script and a lockfile and no `agentx.e2e` contract.
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.close(() => { done(); }); }))); });

describe("the inferred-recipe fixture app", () => {
  const snapshot = (): E2ESourceSnapshot => {
    const candidate = createCandidateManifest([{ repositoryId: "fixture/inferred", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const sources = ["package.json", "package-lock.json"].map((path) => {
      const bytes = readFileSync(join(INFERRED_FIXTURE_ROOT, path));
      return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), kind: "blob" as const };
    });
    return { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path), sources };
  };

  it("has no project contract, and discovery infers `npm ci` then `npm start` with no port of its own", () => {
    expect(JSON.parse(readFileSync(join(INFERRED_FIXTURE_ROOT, "package.json"), "utf8"))).not.toHaveProperty("agentx");
    const recipe = inferNodeWebRecipe(snapshot());
    expect(recipe).not.toBeNull();
    expect(recipe!.build.map((command) => [command.program, ...command.args])).toEqual([["npm", "ci"]]);
    expect(recipe!.launch).toMatchObject({ kind: "service", start: { program: "npm", args: ["start"] }, health: { path: "/", expectedStatus: 200 } });
    expect(JSON.stringify(recipe)).not.toContain("PORT");
    expect(INFERRED_APP_FILES).toEqual(["package.json", "package-lock.json", "server.mjs"]);
  });

  it("serves the welcome page at / to every visitor, with no admin link, and refuses the admin API", async () => {
    const module = await import(pathToFileURL(join(INFERRED_FIXTURE_ROOT, "server.mjs")).href) as { createApplication(): Server };
    const server = module.createApplication(); servers.push(server);
    await new Promise<void>((done) => { server.listen(0, "127.0.0.1", () => { done(); }); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('data-testid="welcome"');
    expect(html).toContain("You are browsing as a visitor.");
    expect(html).not.toContain("admin-link");
    expect((await fetch(`${base}/api/admin/orders`)).status).toBe(401);
    expect((await fetch(`${base}/api/products`)).status).toBe(200);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
  });
});
