import { homedir } from "node:os";
import { resolve, join } from "node:path";

export const CONTAINED_IMAGE = "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9";

export type ContainedRuntimeProfile = Readonly<{
  id: "darwin-arm64-colima-v1" | "linux-arm64-docker-v1";
  platform: "darwin" | "linux";
  arch: "arm64";
  dockerPath: string;
  commandPath: string;
  dockerHost: string;
  socketEndpoint: string;
  image: typeof CONTAINED_IMAGE;
  stateRoot: string;
  /** Absent on the established local profile, which keeps its working-directory anchor. */
  candidateScratchRoot?: string;
  /** Fixed location in the released worker image, not the mounted source checkout. */
  installedRuntimeRoot: string;
  /** Present on EC2 only; the boot script provisions it on the workspace EBS volume. */
  evidenceRoot?: string;
}>;

/** Selects only code-pinned hosts. No environment variable or candidate field can select a profile. */
export function containedRuntimeProfileForHost(platform: string, arch: string): ContainedRuntimeProfile | undefined {
  if (platform === "darwin" && arch === "arm64") return Object.freeze({
    id: "darwin-arm64-colima-v1",
    platform,
    arch,
    dockerPath: "/opt/homebrew/bin/docker",
    commandPath: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    dockerHost: "unix:///Users/abhishekgarg/.colima/default/docker.sock",
    socketEndpoint: "unix:///Users/abhishekgarg/.colima/default/docker.sock",
    image: CONTAINED_IMAGE,
    stateRoot: join(homedir(), ".local", "state", "agentx", "contained-candidate-v1"),
    installedRuntimeRoot: resolve(process.cwd()),
  });
  if (platform === "linux" && arch === "arm64") return Object.freeze({
    id: "linux-arm64-docker-v1",
    platform,
    arch,
    dockerPath: "/usr/local/bin/docker",
    commandPath: "/usr/local/bin:/usr/bin:/bin",
    dockerHost: "unix:///var/run/docker.sock",
    socketEndpoint: "unix:///var/run/docker.sock",
    image: CONTAINED_IMAGE,
    stateRoot: "/mnt/agentx-runtime/state",
    candidateScratchRoot: "/mnt/agentx-runtime/candidates",
    installedRuntimeRoot: "/opt/agentx",
    evidenceRoot: "/mnt/agentx-runtime/evidence",
  });
  return undefined;
}

export const CONTAINED_RUNTIME_PROFILE = containedRuntimeProfileForHost(process.platform, process.arch);
/** Empty only on unsupported hosts; the runtime readiness gate withholds the optional feature there. */
export const CONTAINED_SOCKET = CONTAINED_RUNTIME_PROFILE?.dockerHost ?? "";

export type CreateArgsInput = { name: string; cidfile: string; sourcePath: string; sourceDigest: string; nonce: string; entry: string; exportName?: string };

function folded(value: string): string { return value.normalize("NFKC").normalize("NFD").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ").normalize("NFC"); }
function reservedSegment(segment: string): boolean {
  const key = folded(segment);
  return key.startsWith(".env") || key === ".git" || key === ".ssh" || key === ".aws" || key === ".docker"
    || key === ".npmrc" || key === ".pypirc" || key === ".netrc" || key === ".git-credentials"
    || key === "credentials" || key === "credentials.json" || key === "credential" || key === "config.json";
}
function safeEntry(entry: string): boolean {
  if (!entry || [...entry].length > 240 || entry.startsWith("/") || entry.includes("\\") || entry !== entry.normalize("NFC")
    || [...entry].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127; })) return false;
  const segments = entry.split("/");
  return entry.endsWith(".mjs") && segments.every((part) => part && part !== "." && part !== ".." && !reservedSegment(part));
}

export function buildCreateArgs(input: CreateArgsInput): string[] {
  const exportName = input.exportName ?? "default";
  if (!/^agentx-contained-[a-f0-9]{20}$/.test(input.name) || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^[a-f0-9]{48}$/.test(input.nonce)
    || !safeEntry(input.entry) || !/^(default|[A-Za-z_$][A-Za-z0-9_$]{0,63})$/.test(exportName) || [input.cidfile, input.sourcePath].some((path) => !path.startsWith("/") || path.includes(","))) {
    throw new Error("invalid fixed-container allocation input");
  }
  const labels = [
    ["agentx.owner", "contained-candidate-v1"],
    ["agentx.nonce", input.nonce],
    ["agentx.source", input.sourceDigest],
  ];
  return [
    "create", "--pull=never", "--platform=linux/arm64", "--name", input.name, "--cidfile", input.cidfile,
    ...labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--user=65532:65532", "--interactive", "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=256", "--cpus=2", "--memory=4096m", "--memory-swap=4096m", "--init",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m",
    ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_OPTIONS", "NODE_PATH"].flatMap((key) => ["--env", `${key}=`]),
    "--env", `AGENTX_ENTRY=/candidate/${input.entry}`, "--env", `AGENTX_EXPORT=${exportName}`,
    "--mount", `type=bind,src=${input.sourcePath},dst=/candidate,readonly`,
    "--workdir=/candidate", "--entrypoint=node", CONTAINED_IMAGE, "/candidate/.agentx-bootstrap.mjs",
  ];
}

export function isOwnedContainer(labels: unknown, owner: unknown): boolean {
  if (!labels || typeof labels !== "object" || !owner || typeof owner !== "object") return false;
  const actual = labels as Record<string, unknown>;
  const expected = owner as Record<string, unknown>;
  return actual["agentx.owner"] === "contained-candidate-v1"
    && actual["agentx.nonce"] === expected.nonce
    && actual["agentx.source"] === expected.sourceDigest;
}
