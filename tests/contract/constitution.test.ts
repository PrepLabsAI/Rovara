import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = () => readFile(new URL("../../.specify/memory/constitution.md", import.meta.url), "utf8");

describe("constitution 4.1.0 (native task workflow)", () => {
  it("is version 4.1.0 with a sync impact note naming the human-gated workflow boundary", async () => {
    const text = await read();
    expect(text).toMatch(/\*\*Version\*\*: 4\.1\.0 \| \*\*Ratified\*\*: 2026-09-17 \| \*\*Last Amended\*\*: 2026-10-05/);
    expect(text).toMatch(/Sync impact: 4\.0\.0 -> 4\.1\.0/);
    expect(text).toMatch(/Principle added: VI\. Human-gated task workflow/s);
    expect(text).toContain("a named human decision gate");
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
