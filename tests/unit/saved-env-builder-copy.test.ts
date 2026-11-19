import { describe, expect, it, vi } from "vitest";
import { SAVED_ENV_BUILDER_IMAGE, SAVED_ENV_BUILDER_DIGEST } from "@agentx/contracts";
import { builderCopyPlan, verifyBuilderCopy, main } from "../../scripts/saved-env-builder-copy.js";

const host = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const source = SAVED_ENV_BUILDER_IMAGE;
describe("saved environment builder copy", () => {
  it("copies a pinned index under the worker's existing agentx environment prefix", () => {
    const step = builderCopyPlan(host, "test", source);
    expect(step.source).toBe(`docker.io/${source}`);
    expect(step.pinned).toBe(`${host}/agentx-test/saved-env-builder@sha256:${SAVED_ENV_BUILDER_DIGEST.slice(7)}`);
    expect(step.target).toBe(`${host}/agentx-test/saved-env-builder:sha256-${SAVED_ENV_BUILDER_DIGEST.slice(7)}`);
    for (const bad of ["moby/buildkit:latest", "evil/buildkit@sha256:" + "a".repeat(64), source + "/extra", source.replace("-rootless", ""), source.replace("c825", "ffff")]) expect(() => builderCopyPlan(host, "test", bad)).toThrow();
    for (const env of ["", "../prod", "test/*"]) expect(() => builderCopyPlan(host, env, source)).toThrow();
    expect(() => builderCopyPlan("evil.example", "test", source)).toThrow();
  });
  it("verifies both architecture manifests and their content, refusing a partial copy", () => {
    const step = builderCopyPlan(host, "test", source);
    const child = `sha256:${"b".repeat(64)}`;
    const registry = { digest: (ref: string) => ref.includes(child) ? child : step.digest, manifest: () => JSON.stringify({ manifests: ["arm64", "amd64"].map(architecture => ({ digest: child, platform: { os: "linux", architecture } })) }) };
    expect(verifyBuilderCopy(step, registry).ok).toBe(true);
    expect(verifyBuilderCopy(step, { ...registry, digest: () => "sha256:" + "f".repeat(64) }).ok).toBe(false);
    expect(verifyBuilderCopy(step, { ...registry, manifest: () => "{}" }).ok).toBe(false);
  });
  it("defaults to a network-free plan and prints the worker's existing variable", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(main(["--registry", host, "--env", "test", "--source", source])).toBe(0);
      expect(log.mock.calls[1]![0]).toBe(`AGENTX_SAVED_ENV_BUILDER_IMAGE=${builderCopyPlan(host, "test", source).pinned}`);
    } finally { log.mockRestore(); }
  });
});
