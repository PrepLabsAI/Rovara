import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLACK_ORCHESTRATOR_IMAGE_INPUTS, WORKER_IMAGE_INPUTS } from "../../scripts/release-production.js";

const workspaces = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("workspace packages in release images", () => {
  it.each([
    ["environments/base/Dockerfile", WORKER_IMAGE_INPUTS],
    ["environments/slack/Dockerfile", SLACK_ORCHESTRATOR_IMAGE_INPUTS],
  ] as const)("%s copies every workspace manifest before npm ci", (dockerfile, inputs) => {
    const text = readFileSync(dockerfile, "utf8");
    for (const name of workspaces) {
      expect(text).toContain(`COPY packages/${name}/package.json packages/${name}/package.json`);
      expect(inputs.some((input) => input === `packages/${name}/package.json` || input === `packages/${name}`)).toBe(true);
    }
  });

  it("includes the gateway", () => {
    expect(workspaces).toContain("gateway");
  });
});
