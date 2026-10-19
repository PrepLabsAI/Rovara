import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The browser executor image (environments/e2e-executor/Dockerfile) is built only by the
// linux-runtime CI job and by the Rovara runtime; these facts are read from its Dockerfile and the lockfile.
const dockerfile = readFileSync("environments/e2e-executor/Dockerfile", "utf8");
const stages = dockerfile.split(/^(?=FROM )/m).filter((stage) => stage.startsWith("FROM "));
const buildStage = stages[0] ?? "";
const runtimeStage = stages[1] ?? "";
const verifier = JSON.parse(readFileSync("packages/verifier/package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string> }>;
};

function installed(name: string) {
  return lock.packages[`node_modules/${name}`];
}

describe("the browser executor image", () => {
  it("pins the base by digest and the browser stack by exact version", () => {
    expect(dockerfile).toMatch(
      /^FROM public\.ecr\.aws\/docker\/library\/node:22\.23\.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build$/m,
    );
    expect(dockerfile).toContain("playwright-core@1.63.0 install --with-deps chromium");
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("starts every stage from the same pinned base", () => {
    const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
    expect(froms).toHaveLength(2);
    const base = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
    for (const from of froms) expect(from).toContain(base);
  });

  it("provides the verifier manifest and the local archive before a scripts-free npm ci, then builds only what it ships", () => {
    const install = buildStage.indexOf("RUN npm ci --ignore-scripts");
    expect(install).toBeGreaterThan(0);
    const preInstall = buildStage.slice(0, install);
    expect(preInstall).toContain("COPY packages/verifier/package.json packages/verifier/package.json");
    expect(preInstall).toContain("COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz");
    expect(buildStage).toMatch(/RUN npx tsc -b packages\/contracts packages\/verifier --pretty false/);
    expect(buildStage).toContain("RUN npm prune --omit=dev --workspaces");
  });

  it("ships the built contracts and verifier packages and the production node_modules under /opt/agentx", () => {
    expect(runtimeStage).toContain("WORKDIR /opt/agentx");
    expect(runtimeStage).toContain("COPY --from=build /opt/agentx/node_modules ./node_modules");
    expect(runtimeStage).toContain("COPY --from=build /opt/agentx/packages/contracts ./packages/contracts");
    expect(runtimeStage).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
  });

  it("installs Chromium and its system libraries as root into a path the node user can read", () => {
    const user = runtimeStage.search(/^USER node$/m);
    const install = runtimeStage.indexOf("install --with-deps chromium");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(user);
    expect(runtimeStage).not.toMatch(/^USER root$/m);
    expect(runtimeStage).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright$/m);
    expect(runtimeStage).toContain("chmod -R a+rX /ms-playwright");
    expect(runtimeStage).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("does not make the image's default command anything but the executor", () => {
    expect(runtimeStage).toMatch(/^CMD \["node", "\/opt\/agentx\/packages\/verifier\/dist\/executor\/entry\.js"\]$/m);
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m);
  });
});

describe("the executor package closure", () => {
  it("keeps the runner, the web package and the browser driver at exact pins in the verifier's dependencies", () => {
    expect(verifier.dependencies.e2e).toBe("file:../../upstream/e2e-0.20.0.tgz");
    expect(verifier.dependencies["@e2e-dev/web"]).toBe("0.14.0");
    expect(verifier.dependencies["playwright-core"]).toBe("1.63.0");
    for (const name of ["e2e", "@e2e-dev/web", "playwright-core"]) {
      expect(lock.packages["packages/verifier"]?.dependencies?.[name], name).toBe(verifier.dependencies[name]);
    }
  });

  it("installs the pinned versions, none of them as a development-only dependency that npm prune would drop", () => {
    expect(installed("e2e")?.version).toBe("0.20.0");
    expect(installed("@e2e-dev/web")?.version).toBe("0.14.0");
    expect(installed("playwright-core")?.version).toBe("1.63.0");
    for (const name of ["e2e", "@e2e-dev/web", "playwright-core"]) expect(installed(name)?.dev, name).toBeUndefined();
  });
});
