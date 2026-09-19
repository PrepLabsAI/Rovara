import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../packages/cli/src/config.js";
import { createFixtureDirectory } from "../fixtures/index.js";

describe("local project selection", () => {
  it("loads only the named strict YAML definition", async () => {
    const configDirectory = await createFixtureDirectory("agentx-config-");
    await writeFile(join(configDirectory, "payments.yaml"), YAML.stringify(projectConfig()), "utf8");

    const loaded = await loadProjectConfig({ projectName: "payments", configDirectory });
    expect(loaded.name).toBe("payments");
    expect(loaded.revision).toBe(1);
  });

  it("rejects traversal, unknown keys and non-HTTPS control planes by default", async () => {
    const configDirectory = await createFixtureDirectory("agentx-config-");
    await expect(
      loadProjectConfig({ projectName: "../payments", configDirectory }),
    ).rejects.toThrow();

    await writeFile(
      join(configDirectory, "payments.yaml"),
      YAML.stringify({ ...projectConfig(), arbitraryExtension: "./execute-me.js" }),
      "utf8",
    );
    await expect(loadProjectConfig({ projectName: "payments", configDirectory })).rejects.toThrow();

    await writeFile(
      join(configDirectory, "payments.yaml"),
      YAML.stringify({ ...projectConfig(), controlPlaneUrl: "http://127.0.0.1:8787" }),
      "utf8",
    );
    await expect(loadProjectConfig({ projectName: "payments", configDirectory })).rejects.toThrow(/HTTPS/i);
    await expect(
      loadProjectConfig({ projectName: "payments", configDirectory, allowLoopback: true }),
    ).resolves.toMatchObject({ name: "payments" });
  });

  it("rejects a config symlink that escapes the selected directory", async () => {
    const root = await createFixtureDirectory("agentx-config-root-");
    const configDirectory = join(root, "configs");
    await mkdir(configDirectory);
    await writeFile(join(root, "outside.yaml"), YAML.stringify(projectConfig()), "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(root, "outside.yaml"), join(configDirectory, "payments.yaml"));
    await expect(loadProjectConfig({ projectName: "payments", configDirectory })).rejects.toThrow(
      /outside/i,
    );
  });
});

function projectConfig() {
  return {
    schemaVersion: 2,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
    },
    environment: {
      image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [
      {
        name: "payments",
        url: "https://git.example.test/payments.git",
        path: "repo/payments",
        defaultBranch: "main",
        credentialRef: "payments-readwrite",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding remotely.",
  };
}
