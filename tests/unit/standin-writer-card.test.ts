// L4-E7: the setup card shows the sample-data writer's cost BEFORE the run, inside the run's own limit (the setup cap's wording), on the broker's view; with no AI connected it says to connect one first.
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SetupAgentViewSchema, standInWriterCard } from "@agentx/contracts";
import { type SetupAgentView } from "../../packages/broker/src/core/setup-agent/agent.js";

const none: SetupAgentView = { status: "none", basedOnRevision: 1, limits: { ...SETUP_AGENT_LIMITS_DEFAULT } };

describe("the broker's setup view carries the writer's cost before the run", () => {
  it("is part of the web contract (additive: an older reader that ignores it still reads the view)", () => {
    const parsed = SetupAgentViewSchema.parse({ ...none, standInWriter: standInWriterCard({ connected: true, capCents: 400 }) });
    expect(parsed.standInWriter?.ceilingCents).toBeGreaterThan(0);
    expect(SetupAgentViewSchema.safeParse(none).success).toBe(true);
    expect(SetupAgentViewSchema.safeParse({ ...none, standInWriter: { connected: true, words: "x", extra: 1 } }).success).toBe(false);
  });
});
