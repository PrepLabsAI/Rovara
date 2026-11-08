import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = () => readFile(new URL("../../.specify/memory/constitution.md", import.meta.url), "utf8");

describe("constitution 5.0.0 (channel adapters)", () => {
  it("is version 5.0.0 with a sync impact note naming the changed principles", async () => {
    const text = await read();
    expect(text).toMatch(/\*\*Version\*\*: 5\.0\.0 \| \*\*Ratified\*\*: 2026-09-17 \| \*\*Last Amended\*\*: 2026-11-08/);
    expect(text).toMatch(/Sync impact: 4\.1\.0 -> 5\.0\.0/);
    expect(text).toContain("specs/062-channel-adapters/");
  });

  it("accepts requests signed by Slack or a registered channel adapter, from a linked actor in a bound space (Principle I)", async () => {
    const text = await read();
    expect(text).toContain("It MUST\naccept only requests that Slack or a registered channel adapter has signed.");
    expect(text).toContain("actor linked to a developer sign-in, in a space bound to a project that adapter is registered for");
    expect(text).toContain("Only an administrator registers a channel adapter");
    expect(text).toContain("MUST NOT receive credentials or run coding work");
    expect(text).toContain("on the task page and MUST be refused from the adapter");
    expect(text).not.toContain("accept only requests that Slack has signed");
  });

  it("keeps one orchestrator model and admits the developer task API", async () => {
    const text = await read();
    expect(text).toContain("The hosted orchestrator is the only AgentX orchestrator model.");
    expect(text).toContain("the developer task API");
    expect(text).toContain("MUST record the requesting developer with every operation");
    expect(text).not.toContain("No other client may drive coding work.");
  });

  it("selects a project by a bound Slack channel, a bound adapter space or by name (Principle II)", async () => {
    const text = await read();
    expect(text).toContain("the Slack channel or adapter space bound to it");
    expect(text).toContain("or by name through the developer task API when they may use it");
  });

  it("gives conversations and developer tasks their own workspaces and keeps personal workspaces retired (Principle III)", async () => {
    const text = await read();
    expect(text).toContain("Every workspace is owned by a conversation or by one developer task.");
    expect(text).toContain("Owner keys of different channels MUST NOT collide.");
    expect(text).toContain("reachable only by the developer who started it");
    expect(text).toContain("Personal workspaces not tied to a task stay retired.");
  });

  it("keeps the human-gated workflow, with adapters as clients (Principle VI)", async () => {
    const text = await read();
    expect(text).toContain("Slack, channel adapters and developer\nMCP are clients, not separate orchestrators.");
    expect(text).toContain("a named human decision gate");
  });

  it("contains no em dash", async () => {
    expect(await read()).not.toContain("—");
  });
});
