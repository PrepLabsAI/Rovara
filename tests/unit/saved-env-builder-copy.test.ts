import { describe, expect, it } from "vitest";
import { SAVED_ENV_BUILDER_IMAGE, SAVED_ENV_BUILDER_DIGEST } from "@agentx/contracts";
import { builderCopyPlan } from "../../scripts/saved-env-builder-copy.js";

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
});
