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

  it("rejects traversal, unknown keys, retired fields and non-HTTPS repositories by default", async () => {
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

    // A file still carrying the retired connection fields is named in the error, not ignored.
    await writeFile(
      join(configDirectory, "payments.yaml"),
      YAML.stringify({
        ...projectConfig(),
        schemaVersion: 2,
        controlPlaneUrl: "https://agentx.example.test",
        auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
        environment: { image: `example.test/agentx@sha256:${"a".repeat(64)}` },
      }),
      "utf8",
    );
    await expect(loadProjectConfig({ projectName: "payments", configDirectory })).rejects.toThrow(
      /schemaVersion, controlPlaneUrl, auth, environment/,
    );

    const loopback = { ...projectConfig() };
    loopback.repositories = [{ ...loopback.repositories[0]!, url: "http://127.0.0.1/payments.git" }];
    await writeFile(join(configDirectory, "payments.yaml"), YAML.stringify(loopback), "utf8");
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
    name: "payments",
    revision: 1,
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
