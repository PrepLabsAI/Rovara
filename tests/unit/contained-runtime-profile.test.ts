import { describe, expect, it } from "vitest";
import { CONTAINED_IMAGE, containedRuntimeProfileForHost } from "../../packages/verifier/src/container-envelope.js";
import { evaluateContainedRuntimePrerequisites } from "../../packages/verifier/src/contained-runtime-readiness.js";

describe("trusted contained runtime profiles", () => {
  it("selects a fixed Linux ARM64 runtime whose Docker paths and storage are shared with the EC2 host", () => {
    const profile = containedRuntimeProfileForHost("linux", "arm64");
    expect(profile).toMatchObject({
      id: "linux-arm64-docker-v1",
      dockerPath: "/usr/local/bin/docker",
      commandPath: "/usr/local/bin:/usr/bin:/bin",
      dockerHost: "unix:///var/run/docker.sock",
      image: CONTAINED_IMAGE,
      stateRoot: "/mnt/agentx-runtime/state",
      candidateScratchRoot: "/mnt/agentx-runtime/candidates",
      evidenceRoot: "/mnt/agentx-runtime/evidence",
      installedRuntimeRoot: "/opt/agentx",
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(process.env.DOCKER_HOST === undefined || profile?.dockerHost !== process.env.DOCKER_HOST).toBe(true);
  });

  it("keeps the established local Mac profile and rejects unsupported hosts", () => {
    const mac = containedRuntimeProfileForHost("darwin", "arm64");
    expect(mac).toMatchObject({
      id: "darwin-arm64-colima-v1",
      dockerPath: "/opt/homebrew/bin/docker",
      dockerHost: "unix:///Users/abhishekgarg/.colima/default/docker.sock",
    });
    expect(containedRuntimeProfileForHost("linux", "x64")).toBeUndefined();
    expect(containedRuntimeProfileForHost("darwin", "x64")).toBeUndefined();
  });

  it("reports missing fixed runtime prerequisites as unavailable", () => {
    expect(evaluateContainedRuntimePrerequisites({
      profileId: "linux-arm64-docker-v1",
      nodeVersion: "v22.23.2",
      privatePathsReady: false,
      pinnedImageReady: true,
    })).toEqual({ status: "unavailable", reason: "private-runtime-paths-unavailable" });
    expect(evaluateContainedRuntimePrerequisites({
      profileId: "linux-arm64-docker-v1",
      nodeVersion: "v22.23.2",
      privatePathsReady: true,
      pinnedImageReady: false,
    })).toEqual({ status: "unavailable", reason: "pinned-contained-image-unavailable" });
    expect(evaluateContainedRuntimePrerequisites({
      profileId: undefined,
      nodeVersion: "v22.23.2",
      privatePathsReady: true,
      pinnedImageReady: true,
    })).toEqual({ status: "unavailable", reason: "unsupported-runtime-host" });
    expect(evaluateContainedRuntimePrerequisites({
      profileId: "linux-arm64-docker-v1",
      nodeVersion: "v22.24.0",
      privatePathsReady: true,
      pinnedImageReady: true,
    })).toEqual({ status: "unavailable", reason: "worker-node-version-mismatch" });
  });
});
