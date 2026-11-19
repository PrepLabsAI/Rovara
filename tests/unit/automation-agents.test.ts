// Custom agents on the stores and the ports: what a version holds, what the guardrails and the project's rules say of it, and what an unattended run is frozen with. The rules that matter:
//   1. an agent can never run with more than the project's rules and the guardrails allow (tools, writes, autonomy);
//   2. an unattended run uses a published version of an active agent only;
//   3. a write that depends on what it read is conditional on it (a lost race is a conflict, not an overwrite).
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS } from "@agentx/contracts";
import { writeGuardrails } from "../../packages/broker/src/core/agents/guardrails.js";
import { resolveAgentForAutonomousRun } from "../../packages/broker/src/core/agents/roster.js";
import { resolveAgent } from "../../packages/broker/src/core/agents/store.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, publishAgent, reporterOverlay } from "../support/automation-world.js";

const run = (world: ReturnType<typeof createAutomationWorld>, agentId: string, project = PROJECT) => resolveAgentForAutonomousRun(world.roster, { orgId: COMPANY, project, agentId });

describe("custom agents", () => {
  it("publishes a version and resolves the recipe it runs", async () => {
    const world = createAutomationWorld();
    const { agentId, version } = await publishAgent(world);
    expect(version).toBe(1);
    const recipe = await resolveAgent(world.agents, COMPANY, agentId, 1);
    expect(recipe.steps.map((step) => step.id)).toEqual(["look"]);
    const resolved = await run(world, agentId);
    expect(resolved.ref).toEqual({ agentId, version: 1 });
  });

  it("never runs an unattended run on a draft, an archived agent or an agent with no published version", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    await expect(resolveAgentForAutonomousRun(world.roster, { orgId: COMPANY, project: PROJECT, agentId, version: "draft" })).rejects.toThrow(/published version/u);
    const fresh = await world.agents.create({ orgId: COMPANY, name: "Unpublished", by: OWNER.personId, overlay: reporterOverlay() });
    await expect(run(world, fresh.agentId)).rejects.toThrow(/no published version/u);
    await world.agents.setArchived(COMPANY, agentId, true, OWNER.personId);
    await expect(run(world, agentId)).rejects.toThrow(/archived/u);
  });

  it("refuses a recipe that asks for write access, because this install can't ask a person for each change", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world, reporterOverlay({ tools: [{ connector: { type: "github" }, access: "read_write" }] }), "Writer");
    await expect(run(world, agentId)).rejects.toThrow(/needs a person's approval/u);
  });

  it("refuses a tool grant that the project's action policy denies, and adds the policy's ask rules to the agent's own", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world, reporterOverlay({ tools: [{ connector: { type: "github" }, access: "read", tools: ["get_*"] }], approvals: { alwaysAsk: ["list_things"] } }), "Reader");
    world.projects.set(PROJECT, { actionPolicy: { rules: [{ tool: "get_secret", outcome: "deny", reason: "secrets" }] } });
    await expect(run(world, agentId)).rejects.toThrow(/denies get_secret/u);
    world.projects.set(PROJECT, { actionPolicy: { rules: [{ tool: "delete_branch", outcome: "ask" }] } });
    const frozen = await run(world, agentId);
    // The policy only adds: the agent's own always-ask entry stays, and the project's is joined to it.
    expect(frozen.recipe.approvals.alwaysAsk).toEqual(["list_things", "delete_branch"]);
  });

  it("holds the run's autonomy to the guardrails' ceiling, never above the agent's own", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world, reporterOverlay({ autonomy: "prepare" }), "Preparer");
    await writeGuardrails(world.agents.table, COMPANY, { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "suggest" }, OWNER.personId);
    // The recipe itself is now above the ceiling: it cannot run at all, rather than run lower than it was published.
    await expect(run(world, agentId)).rejects.toThrow(/more than the guardrails allow/u);
  });

  it("refuses a forbidden model and a project that is not registered or is archived", async () => {
    const world = createAutomationWorld();
    const model = { provider: "examplehost", modelId: "big-model-1" };
    const { agentId } = await publishAgent(world, reporterOverlay({ sequence: [{ id: "look", name: "Look", kind: "agent", workspace: "read", settings: { model } }] }), "Modeler");
    await writeGuardrails(world.agents.table, COMPANY, { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [model] }, OWNER.personId);
    await expect(run(world, agentId)).rejects.toThrow(/forbidden here/u);
    const plain = await publishAgent(world, reporterOverlay(), "Plain");
    await expect(run(world, plain.agentId, "elsewhere")).rejects.toThrow(/not a project on this install/u);
    world.projects.set(PROJECT, { archived: true });
    await expect(run(world, plain.agentId)).rejects.toThrow(/archived/u);
  });

  it("gives the agent step the read-only tools at most: a build tool on an agent step is refused when it is saved as a version", async () => {
    const world = createAutomationWorld();
    const overlay = reporterOverlay({ sequence: [{ id: "look", name: "Look", kind: "agent", workspace: "read", settings: { tools: ["bash"] } }] });
    await expect(publishAgent(world, overlay, "Shell")).rejects.toThrow(/can't use bash/u);
  });

  it("writes the guardrails only at the revision it read", async () => {
    const world = createAutomationWorld();
    await writeGuardrails(world.agents.table, COMPANY, { ...DEFAULT_AGENT_GUARDRAILS, requireCrossCompanyReview: true }, OWNER.personId, { expectedRevision: 0 });
    await expect(writeGuardrails(world.agents.table, COMPANY, DEFAULT_AGENT_GUARDRAILS, OWNER.personId, { expectedRevision: 0 })).rejects.toThrow(/changed while you were editing/u);
  });

  it("keeps a name unique and a draft write conditional on its revision", async () => {
    const world = createAutomationWorld();
    const first = await world.agents.create({ orgId: COMPANY, name: "Same", by: OWNER.personId });
    await expect(world.agents.create({ orgId: COMPANY, name: " same ", by: OWNER.personId })).rejects.toThrow(/another agent is called/u);
    await world.agents.saveDraft({ orgId: COMPANY, agentId: first.agentId, overlay: reporterOverlay(), expectedRevision: 1, by: OWNER.personId });
    await expect(world.agents.saveDraft({ orgId: COMPANY, agentId: first.agentId, overlay: reporterOverlay(), expectedRevision: 1, by: OWNER.personId })).rejects.toThrow(/Someone else changed/u);
  });
});
