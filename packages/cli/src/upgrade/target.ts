// FR-042: which release an upgrade moves to, that it never moves back (question 3), and the
// release's notes. Ruling F31: a prerelease target only from --release <dir>.
import { agentXError } from "@agentx/contracts";
import { RELEASE_REPOSITORY } from "../init/release-fetch.js";
import { isPrereleaseVersion } from "../version.js";

const MAX_NOTE_LINES = 40;

function parts(version: string): { numbers: number[]; pre: string | undefined } {
  const [core = "", ...pre] = version.split("-");
  return { numbers: core.split(".").map((part) => Number(part)), pre: pre.length === 0 ? undefined : pre.join("-") };
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function upgradeDirection(env: string, current: string, target: string): "same" | "newer" {
  const order = compareVersions(current, target);
  if (order === 0) return "same";
  if (order < 0) return "newer";
  throw agentXError("CONFIG_INVALID", `release ${target} is older than ${current}, which environment ${env} runs; agentx upgrade never moves an environment back, because a newer release may have written data an older one cannot read. Upgrade to ${current} or later`);
}

/** Ruling F31: like init, upgrade moves only to published releases, except a tester's --release <dir>. */
export function refusePrereleaseTarget(version: string, source: { fromReleaseDir: boolean }): void {
  if (source.fromReleaseDir || !isPrereleaseVersion(version)) return;
  throw agentXError("CONFIG_INVALID", `release ${version} is a prerelease; agentx upgrade moves an environment only to published releases (x.y.z). Upgrade to a published release, or pass --release <dir> to test a prerelease`);
}

export interface ReleaseNotes { text: string; url: string }

export async function releaseNotes(input: { fetch: typeof fetch; version: string }): Promise<ReleaseNotes | undefined> {
  try {
    const response = await input.fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${input.version}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agentx-cli" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { body?: unknown; html_url?: unknown };
    if (typeof body.body !== "string" || typeof body.html_url !== "string") return undefined;
    return { text: body.body, url: body.html_url };
  } catch {
    return undefined;
  }
}

export function notesText(notes: ReleaseNotes | undefined, version: string): string {
  if (notes === undefined) return `No release notes could be read for ${version}; see https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
  const lines = notes.text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const shown = lines.slice(0, MAX_NOTE_LINES).map((line) => `  ${line}`);
  const rest = lines.length - shown.length;
  return [`Release notes for ${version}:`, ...shown, ...(rest > 0 ? [`  (${rest} more lines at ${notes.url})`] : [])].join("\n");
}
