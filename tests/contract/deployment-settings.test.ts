import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { loadDeploymentSettings } from "../../packages/cli/src/deployment.js";

const settings = {
  controlPlaneUrl: "https://agentx.example.test",
  auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" },
};

describe("deployment settings", () => {
  it("loads the one file that serves every project", async () => {
    const path = await settingsFile(settings);
    await expect(loadDeploymentSettings({ path })).resolves.toEqual(settings);
  });

  it("rejects unknown keys, missing settings and a missing file", async () => {
    const unknown = await settingsFile({ ...settings, projectName: "payments" });
    await expect(loadDeploymentSettings({ path: unknown })).rejects.toThrow();

    const incomplete = await settingsFile({ controlPlaneUrl: settings.controlPlaneUrl });
    await expect(loadDeploymentSettings({ path: incomplete })).rejects.toThrow();

    const missing = join(await mkdtemp(join(tmpdir(), "agentx-deployment-")), "deployment.yaml");
    await expect(loadDeploymentSettings({ path: missing })).rejects.toThrow(/not configured/);
  });

  it("requires HTTPS outside explicit loopback test mode", async () => {
    const loopback = await settingsFile({ ...settings, controlPlaneUrl: "http://127.0.0.1:8787" });
    await expect(loadDeploymentSettings({ path: loopback })).rejects.toThrow(/HTTPS/i);
    await expect(loadDeploymentSettings({ path: loopback, allowLoopback: true })).resolves.toMatchObject({
      controlPlaneUrl: "http://127.0.0.1:8787",
    });
  });
});

async function settingsFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-deployment-"));
  const path = join(directory, "deployment.yaml");
  await writeFile(path, YAML.stringify(contents), "utf8");
  return path;
}
