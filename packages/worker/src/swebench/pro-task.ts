import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Scale's SWE-Bench Pro repository, at the commit spec 044 was written against (FR-002). */
export const SWEBENCH_PRO_REPOSITORY = "scaleapi/SWE-bench_Pro-os";
export const SWEBENCH_PRO_COMMIT = "66f92766bba642462d4bbe5479e83f91f9211862";

/** A task's files the runner needs: what the agent reads, its timeouts, and the verifier. */
export interface ProTask {
  /** `instruction.md`: the PR description, requirements and new interfaces the agent works from. */
  instruction: string;
  /** The verifier's own timeout, from `task.toml` `[verifier] timeout_sec`. */
  verifierTimeoutSeconds: number;
  /** The host folder holding `tests/`; mounted at /tests for grading only, never in the agent's container. */
  testsDirectory: string;
  commit: string;
}

export interface ProTaskOptions {
  fetch?: typeof fetch;
  commit?: string;
}

const RAW = "https://raw.githubusercontent.com";

/**
 * Downloads one task's instruction, config and verifier from Scale's repository at the pinned
 * commit, and checks every file against that commit's `v2/SHA256SUMS`. The reference solution and
 * the environment's Dockerfile are never fetched. `directory` must not be inside anything the agent's
 * container mounts: `tests/` holds the hidden tests.
 */
export async function loadProTask(instanceId: string, directory: string, options: ProTaskOptions = {}): Promise<ProTask> {
  const fetchImplementation = options.fetch ?? fetch;
  const commit = options.commit ?? SWEBENCH_PRO_COMMIT;
  const base = `${RAW}/${SWEBENCH_PRO_REPOSITORY}/${commit}/v2`;
  const sums = await text(fetchImplementation, `${base}/SHA256SUMS`, "SWE-Bench Pro's checksums");
  const prefix = `tasks/${instanceId}/`;
  const files = sums.split("\n").flatMap((line) => {
    const match = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (!match || !match[2]!.startsWith(prefix)) return [];
    const path = match[2]!.slice(prefix.length);
    return path === "instruction.md" || path === "task.toml" || path.startsWith("tests/") ? [{ path, sha256: match[1]! }] : [];
  });
  if (!files.some((file) => file.path === "instruction.md") || !files.some((file) => file.path === "tests/test.sh")) {
    throw new Error(`${instanceId} is not a SWE-Bench Pro V2 task at ${commit.slice(0, 12)}`);
  }
  const contents = new Map<string, Buffer>();
  for (const file of files) {
    if (file.path.split("/").some((segment) => segment === ".." || segment === "")) throw new Error(`unsafe task file path ${file.path}`);
    const body = await bytes(fetchImplementation, `${base}/${prefix}${file.path}`, file.path);
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== file.sha256) throw new Error(`${file.path} of ${instanceId} does not match SWE-Bench Pro's checksum`);
    contents.set(file.path, body);
  }
  for (const [path, body] of contents) {
    if (!path.startsWith("tests/")) continue;
    const target = resolve(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return {
    instruction: contents.get("instruction.md")!.toString("utf8"),
    verifierTimeoutSeconds: verifierTimeout(contents.get("task.toml")?.toString("utf8") ?? ""),
    testsDirectory: resolve(directory, "tests"),
    commit,
  };
}

/** `[verifier] timeout_sec` from a task.toml, or Pro's usual 3000 seconds. */
export function verifierTimeout(toml: string): number {
  const section = /^\[verifier\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const value = Number(/^\s*timeout_sec\s*=\s*([0-9.]+)\s*$/m.exec(section)?.[1]);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 3_000;
}

async function bytes(fetchImplementation: typeof fetch, url: string, what: string): Promise<Buffer> {
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download ${what} from ${SWEBENCH_PRO_REPOSITORY}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function text(fetchImplementation: typeof fetch, url: string, what: string): Promise<string> {
  return (await bytes(fetchImplementation, url, what)).toString("utf8");
}
