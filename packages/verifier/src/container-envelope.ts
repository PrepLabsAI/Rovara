export const CONTAINED_IMAGE = "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9";
export const CONTAINED_SOCKET = "unix:///Users/abhishekgarg/.colima/default/docker.sock";

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
