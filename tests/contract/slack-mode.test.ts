import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { slackRequestText, splitSlackMessage } from "../../packages/contracts/src/index.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { lastAssistantText } from "../../packages/cli/src/orchestrator.js";
import { InMemorySecretStore } from "../../packages/cli/src/secret-store.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("retired local Slack mode", () => {
  it("keeps only logout, which removes tokens the local mode stored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-slack-logout-"));
    await writeFile(join(directory, "project-a.yaml"), JSON.stringify(projectDefinition()), "utf8");
    const secretStore = new InMemorySecretStore();
    await secretStore.set("slack:project-a", JSON.stringify({ appToken: "xapp-old", botToken: "xoxb-old" }));
    let output = "";
    const dependencies = {
      tokenStore: new InMemoryTokenStore(),
      slackSecretStore: secretStore,
      stdout: { write(text: string) { output += text; } },
      stderr: { write(text: string) { throw new Error(text); } },
    };
    const globals = ["--project", "project-a", "--config-dir", directory, "--state-dir", directory, "--allow-loopback"];

    expect(await executeCli([...globals, "--json", "slack", "logout"], dependencies)).toBe(0);
    expect(await secretStore.get("slack:project-a")).toBeUndefined();
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { project: "project-a", slackAuthenticated: false } });

    for (const retired of ["run", "configure", "login"]) {
      const errors: string[] = [];
      const exitCode = await executeCli([...globals, "slack", retired], {
        ...dependencies,
        stderr: { write(text: string) { errors.push(text); } },
      });
      expect(exitCode).not.toBe(0);
    }
  });
});

describe("Slack text helpers", () => {
  it("normalizes mentions, extracts assistant text, and bounds Slack messages", () => {
    expect(slackRequestText(" <@UAGENTX01>  do the work ", "UAGENTX01")).toBe("do the work");
    expect(slackRequestText("<@UAGENTX01> do the work")).toBe("do the work");
    expect(lastAssistantText([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "<thinking>hidden</thinking>Answer" }] },
    ])).toBe("Answer");
    expect(() => lastAssistantText([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Your session has expired. Please reauthenticate.",
      },
    ])).toThrow("Your session has expired. Please reauthenticate.");
    const chunks = splitSlackMessage("word ".repeat(2_000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3_500)).toBe(true);
    expect(splitSlackMessage("   ")).toEqual(["AgentX completed the request without returning a textual response."]);
  });
});

function projectDefinition(): ProjectDefinition {
  return {
    schemaVersion: 2,
    name: "project-a",
    revision: 1,
    controlPlaneUrl: "http://127.0.0.1:8787",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
    },
    environment: {
      image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [{
      name: "project-a",
      url: "https://github.com/example/project-a.git",
      path: "repo/project-a",
      defaultBranch: "main",
      credentialRef: "github-agentx-sdlc",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding work to the remote worker.",
  };
}
