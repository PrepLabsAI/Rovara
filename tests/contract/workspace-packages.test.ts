import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLACK_ORCHESTRATOR_IMAGE_INPUTS, WORKER_IMAGE_INPUTS } from "../../scripts/release-production.js";

const workspaces = [
  ...readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`),
  "infra",
].sort();

/** npm ci validates every workspace manifest, so each must be copied before it runs. */
function copiedBeforeInstall(dockerfile: string, workspace: string): boolean {
  const copy = dockerfile.indexOf(`COPY ${workspace}/package.json ${workspace}/package.json`);
  const install = dockerfile.indexOf("RUN npm ci");
  return copy >= 0 && install >= 0 && copy < install;
}

describe("workspace packages in release images", () => {
  it.each([
    ["environments/base/Dockerfile", WORKER_IMAGE_INPUTS],
    ["environments/slack/Dockerfile", SLACK_ORCHESTRATOR_IMAGE_INPUTS],
  ] as const)("%s copies every workspace manifest before npm ci", (dockerfile, inputs) => {
    const text = readFileSync(dockerfile, "utf8");
    for (const workspace of workspaces) {
      expect(copiedBeforeInstall(text, workspace), workspace).toBe(true);
      expect(inputs.some((input) => input === `${workspace}/package.json` || input === workspace), workspace).toBe(true);
    }
  });

  it("rejects a manifest copied after npm ci", () => {
    const text = "COPY packages/a/package.json packages/a/package.json\nRUN npm ci --ignore-scripts\nCOPY packages/b/package.json packages/b/package.json\n";
    expect(copiedBeforeInstall(text, "packages/a")).toBe(true);
    expect(copiedBeforeInstall(text, "packages/b")).toBe(false);
  });

  it("includes the gateway", () => {
    expect(workspaces).toContain("packages/gateway");
  });
});
