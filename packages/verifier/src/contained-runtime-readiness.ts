export type ContainedRuntimePrerequisites = Readonly<{
  profileId: string | undefined;
  nodeVersion: string;
  privatePathsReady: boolean;
  pinnedImageReady: boolean;
}>;

export type ContainedRuntimeReadiness = Readonly<
  | { status: "ready"; profileId: string }
  | { status: "unavailable"; reason: "unsupported-runtime-host" | "worker-node-version-mismatch" | "private-runtime-paths-unavailable" | "pinned-contained-image-unavailable" }
>;

/** Keeps optional verifier readiness separate from general worker health. */
export function evaluateContainedRuntimePrerequisites(input: ContainedRuntimePrerequisites): ContainedRuntimeReadiness {
  if (input.profileId !== "darwin-arm64-colima-v1" && input.profileId !== "linux-arm64-docker-v1") {
    return Object.freeze({ status: "unavailable", reason: "unsupported-runtime-host" });
  }
  if (input.nodeVersion !== "v22.23.2") return Object.freeze({ status: "unavailable", reason: "worker-node-version-mismatch" });
  if (!input.privatePathsReady) return Object.freeze({ status: "unavailable", reason: "private-runtime-paths-unavailable" });
  if (!input.pinnedImageReady) return Object.freeze({ status: "unavailable", reason: "pinned-contained-image-unavailable" });
  return Object.freeze({ status: "ready", profileId: input.profileId });
}
