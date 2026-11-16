// Device testing slice 4: what must stay true of the CI job that runs a real iOS simulator and of the fixture it builds. Checks on files (the job is not run here; it runs on a macOS runner).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const read = (path: string) => readFileSync(path, "utf8");
interface Step { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }
interface Job { needs?: unknown; if?: string; "runs-on"?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[] }
const ci = YAML.parse(read(".github/workflows/ci.yml")) as { permissions: Record<string, string>; jobs: Record<string, Job> };
const job = ci.jobs["device-ios"]!;
const runs = job.steps.map((step) => step.run ?? "").join("\n");

describe("the CI job that runs the iOS simulator", () => {
  it("runs on macOS behind the same Markdown-only skip as the other heavy jobs, with its own time limit, read-only permissions, and the one gate waits for it", () => {
    expect(job["runs-on"]).toMatch(/^macos-\d+$/u);
    expect(job.needs).toBe("scope");
    expect(job.if).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(90);
    expect(job.permissions).toBeUndefined();
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.jobs["local"]!.needs).toContain("device-ios");
  });
  it("installs Maestro only with its SHA-256 checked, from its own release host, at the version the device executor image pins, and runs the one macOS test", () => {
    const dockerfile = read("environments/device-executor/Dockerfile");
    const [, version, sha] = /download\/cli-([\d.]+)\/maestro\.zip[\s\S]*?echo "([0-9a-f]{64}) {2}\/tmp\/maestro\.zip"/u.exec(dockerfile)!;
    expect(runs).toContain(`https://github.com/mobile-dev-inc/maestro/releases/download/cli-${version!}/maestro.zip`);
    expect(runs).toContain(`echo "${sha!}  $RUNNER_TEMP/maestro.zip" | shasum -a 256 -c -`);
    expect(runs).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/u);
    expect(job.steps.map((step) => step.run).filter((row) => row?.includes("vitest"))).toEqual(["npx vitest run tests/macos/device-evidence-ios.test.ts"]);
    expect(runs).toContain("xcrun simctl list runtimes");
  });
  it("sets no secret and no cloud credential, and passes no token to the test", () => {
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/secrets\.|aws-actions|configure-aws-credentials|AWS_|role-to-assume|GITHUB_TOKEN/u);
  });
});

describe("the iOS fixture app", () => {
  const build = read("tests/fixtures/device-evidence-ios-app/build.sh");
  const swift = read("tests/fixtures/device-evidence-ios-app/main.swift");
  it("is built by one swiftc call with no project, ad-hoc signed, and keeps everything under ./build", () => {
    expect(build).toContain("set -eu");
    expect(build).toContain("xcrun swiftc -target");
    expect(build).toContain("xcrun codesign --force --sign - build/Fixture.app");
    expect(build).not.toMatch(/curl|wget|sudo|rm -rf \/|~\//u);
    expect(build).toContain('headline=$(cat headline.txt)');
  });
  it("has the rows the test paints: a headline, an email line, a secure field and a button that changes the headline", () => {
    expect(swift).toContain('@HEADLINE@');
    expect(swift).toContain("sam@example.org");
    expect(swift).toContain("isSecureTextEntry = true");
    expect(swift).toContain('"Continue"');
    expect(swift).toContain('"Step two"');
    expect(build).toContain("io.rovara.fixture-app");
  });
});
