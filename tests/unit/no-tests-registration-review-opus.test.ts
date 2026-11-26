// Opus review of N3 (DEC 254zzz495), kept and adapted to the row-attribute design: the fact is not a definition field, so a local registration whose body names it is refused (also on a project that never had one), and what a
// registration stores carries no fact unless the latest revision's own live fact is carried to the row.
import { expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, projectRevisionKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { registerProject } from "../../packages/broker/src/core-host/app/projects.js";

const definition = { name: "demo", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };
const FACT = { at: "2026-11-24T00:00:00.000Z", looked: ["makefile"] };

it("a body fact is refused on the first registration and on a later one, and nothing is stored for it", async () => {
  const store = new MemoryDocumentStore();
  await expect(registerProject(store, IMPLICIT_COMPANY_ID, { ...definition, noAutomatedTests: FACT })).rejects.toThrow();
  expect(await store.get(projectRevisionKey(IMPLICIT_COMPANY_ID, "demo", 1))).toBeUndefined();
  await registerProject(store, IMPLICIT_COMPANY_ID, definition);
  await expect(registerProject(store, IMPLICIT_COMPANY_ID, { ...definition, orchestratorInstructions: "Changed.", noAutomatedTests: FACT })).rejects.toThrow();
  expect((await store.get(projectRevisionKey(IMPLICIT_COMPANY_ID, "demo", 1)))!).not.toHaveProperty("noAutomatedTests");
  expect(await store.get(projectRevisionKey(IMPLICIT_COMPANY_ID, "demo", 2))).toBeUndefined();
});
