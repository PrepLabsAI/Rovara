import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = () => readFile(new URL("../../.specify/memory/constitution.md", import.meta.url), "utf8");

describe("constitution 3.0.0 (spec 025 FR-050)", () => {
  it("is version 3.0.0 with a sync impact note naming Principles I, II and III", async () => {
    const text = await read();
    expect(text).toMatch(/\*\*Version\*\*: 3\.0\.0 \| \*\*Ratified\*\*: 2026-09-17 \| \*\*Last Amended\*\*: \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/Sync impact: 2\.1\.0 -> 3\.0\.0/);
    expect(text).toMatch(/Principles modified: I\. .*II\. .*III\./s);
  });

  it("keeps the Slack orchestrator as the only orchestrator model and admits the developer task API", async () => {
    const text = await read();
    expect(text).toContain("The hosted Slack orchestrator is the only AgentX orchestrator model.");
    expect(text).toContain("the developer task API");
    expect(text).toContain("MUST record the requesting developer with every operation");
    expect(text).not.toContain("No other client may drive coding work.");
  });

  it("lets a developer select a project by name through the developer task API (Principle II)", async () => {
    expect(await read()).toContain("or by name through the developer task API when they may use it");
  });

  it("gives developer tasks their own workspaces and keeps personal workspaces retired (Principle III)", async () => {
    const text = await read();
    expect(text).toContain("Every workspace is owned by a Slack thread or by one developer task.");
    expect(text).toContain("reachable only by the developer who started it");
    expect(text).toContain("Personal workspaces not tied to a task stay retired.");
  });

  it("contains no em dash", async () => {
    expect(await read()).not.toContain("—");
  });
});
