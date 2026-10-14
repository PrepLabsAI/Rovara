import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const base = readFileSync("environments/base/Dockerfile", "utf8");
const slack = readFileSync("environments/slack/Dockerfile", "utf8");
const verifier = JSON.parse(readFileSync("packages/verifier/package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, { dependencies?: Record<string, string>; dev?: boolean; resolved?: string }>;
};

function assertWorkspaceInstallInputs(dockerfile: string): void {
  const install = dockerfile.indexOf("RUN npm ci --ignore-scripts");
  expect(install).toBeGreaterThan(0);
  const preInstall = dockerfile.slice(0, install);
  expect(preInstall).toContain("COPY packages/verifier/package.json packages/verifier/package.json");
  expect(preInstall).toContain("COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz");
}

describe("production verifier package closure", () => {
  it("keeps the pinned E2E runner in the verifier production dependency graph", () => {
    expect(verifier.dependencies.e2e).toBe("file:../../upstream/e2e-0.20.0.tgz");
    expect(lock.packages["packages/verifier"]?.dependencies?.e2e).toBe(verifier.dependencies.e2e);
    expect(lock.packages["node_modules/e2e"]?.resolved).toBe("file:upstream/e2e-0.20.0.tgz");
    expect(lock.packages["node_modules/e2e"]?.dev).toBeUndefined();
  });

  it("provides the local archive and verifier workspace manifest before npm ci in every image context", () => {
    assertWorkspaceInstallInputs(base);
    assertWorkspaceInstallInputs(slack);
  });

  it("builds and ships verifier runtime output in the worker image", () => {
    expect(base).toContain("COPY packages/verifier packages/verifier");
    expect(base).toMatch(/npx tsc -b packages\/contracts packages\/verifier packages\/worker --pretty false/);
    expect(base).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
  });
});
