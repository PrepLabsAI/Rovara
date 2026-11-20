// Lead 4 N1: the work origin `nightly` is minted ONLY for upkeep AI. The gateway holds a call whose TC-1 token says `src: "nightly"` to the project's monthly upkeep cap (Cloud L4-E contract), and nothing else may
// carry it with a model key. Three places keep that true, each pinned here with its mutant:
//   1. a PERSON's wiki build starter refuses a caller whose origin is `nightly` (createWikiBuildStarter);
//   2. the upkeep starter forces `nightly` itself and starts only as the project's OWN system owner (createUpkeepWikiStarter);
//   3. the token describer gives model access to an origin-`nightly` task only when it is a wiki build (the model-free nightly test run, or any other task marked nightly, gets none).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, systemOwnerIdOf, type OrgId, type Principal } from "@agentx/contracts";
import { createUpkeepWikiStarter, createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { wikiBuildRequestText, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { createHarness, type Harness } from "../support/task-flow-harness.js";
import { API_SHA, area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const company = IMPLICIT_COMPANY_ID as OrgId;
const HEAD = "b".repeat(40);

function system(project: string): Principal {
  return { companyId: company, personId: systemOwnerIdOf(company, project), displayName: `Rovara (project: ${project})`, roles: [], provider: "system" };
}

async function world() {
  const h: Harness = createHarness({ companyId: company });
  await h.registerProject();
  // The hosted access adapter lets a project's system owner start work; the default owner-only access does not (it is the install's job to say so).
  h.deps.access = { ...h.deps.access, checkStart: async () => ({ allowed: true }) } as never;
  h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  const cancelled: string[] = [];
  const cancel = async (request: { taskId: string }) => { cancelled.push(request.taskId); };
  const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 })])]), project: "payments" };
  const base = (starter: WikiBuildDeps["starter"]): WikiBuildDeps => ({
    store: h.store, companyId: company, now: () => h.deps.now!().getTime(), starter, standing: async () => ({ access: "manage" }), modelAccessConfigured: true, aiKey: async () => "connected",
    fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "demo", commit: HEAD }], limitSetting: async () => ({ budgetCents: 700, pageReserveCents: 50 }),
  });
  return { h, cancel, base, cancelled };
}

describe("a person's starter never carries the upkeep origin", () => {
  it("refuses a caller whose origin is nightly when it is made", async () => {
    const w = await world();
    expect(() => createWikiBuildStarter({ flow: w.h.deps, caller: { ...w.h.owner, origin: "nightly" }, cancel: w.cancel })).toThrow(/not valid/u);
    expect(() => createWikiBuildStarter({ flow: w.h.deps, caller: w.h.owner, cancel: w.cancel })).not.toThrow();
  });

});

describe("the upkeep starter: origin nightly, set here, as the project's own system owner only", () => {
  const startOnce = async (w: Awaited<ReturnType<typeof world>>, caller: Principal, project = "payments") => {
    const starter = createUpkeepWikiStarter({ flow: w.h.deps, caller: { principal: caller, origin: "app", client: "test" }, cancel: w.cancel });
    return starter.start({
      requestId: randomUUID(), project, text: wikiBuildRequestText(project), payer: { kind: "project", project }, limits: { pages: 10, budgetCents: 700, wallClockMin: 60, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }],
      pointerItemFor: () => ({ kind: "put", item: { pk: `X#${randomUUID()}`, sk: "RUN" } }), notesItemFor: () => undefined,
    });
  };

  it("refuses a person, and another project's system owner, and a made-up system id", async () => {
    const w = await world();
    await expect(startOnce(w, w.h.owner.principal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startOnce(w, system("other"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startOnce(w, { ...system("payments"), personId: `sysowner_${"0".repeat(64)}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

});

void API_SHA;
