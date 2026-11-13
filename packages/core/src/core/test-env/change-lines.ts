// Setup wizard (E4): what a second person is shown when they confirm a test environment. A confirmation is only worth something if the person sees what they are confirming, so the card lists every value that
// changes as `where: before -> after`, built by the broker from the stored proposal and the stored approved revision (never from the asker's words). Every value is one plain line: hidden characters are shown
// as codes and a long value is cut. What matters most to a reviewer (where tests call out to, who they sign in as, when and how long they run) comes first.
import { formatCommandLine, redactText, type TestEnvironmentBody } from "@rovara-code/contracts";
import { shownLine } from "./shown-line.js";

/** The most change lines a card carries; the rest are counted. */
export const TEST_ENV_DIFF_MAX = 60;
const LINE_MAX = 300;

/** Paths that decide what an environment can reach or cost come first. A dependency's seeds, init files and variables are among them: they are commands and files that run with the dependency's network access. */
const FIRST = ["tier", "services", "dependencies", "shared", "preview", "accounts", "capture", "nightly", "roundBudgetMin", "prodDeny", "data", "selection", "repos"];

const isCommand = (value: unknown): value is { cwd: string; executable: string; args: string[]; timeoutSeconds: number; env?: Record<string, string> } =>
  typeof value === "object" && value !== null && typeof (value as { executable?: unknown }).executable === "string" && Array.isArray((value as { args?: unknown }).args);
const identity = (item: unknown, index: number): string => {
  if (typeof item === "object" && item !== null) for (const key of ["id", "name", "profileId", "repositoryId"]) { const value = (item as Record<string, unknown>)[key]; if (typeof value === "string") return value; }
  return String(index);
};

function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (value === undefined || value === null) return;
  if (isCommand(value)) { const env = Object.entries(value.env ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, text]) => `${name}=${text}`);
    out.set(path, `${value.cwd}: ${formatCommandLine(value)} (up to ${String(value.timeoutSeconds)} seconds)${env.length === 0 ? "" : ` with ${env.join(" ")}`}`); return; }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) { out.set(path, value.map(String).join(", ")); return; }
    value.forEach((item, index) => flatten(item, `${path}[${identity(item, index)}]`, out));
    return;
  }
  if (typeof value === "object") { for (const [key, inner] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) flatten(inner, path === "" ? key : `${path}.${key}`, out); return; }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out.set(path, String(value));
}

const rank = (path: string): number => { const at = FIRST.findIndex((head) => path === head || path.startsWith(`${head}.`) || path.startsWith(`${head}[`)); return at === -1 ? FIRST.length : at; };

/** Every change from `previous` (none: the first revision) to `next`, as `where: before -> after` lines, most sensitive first, at most `TEST_ENV_DIFF_MAX`. */
export function testEnvChangeLines(previous: TestEnvironmentBody | undefined, next: TestEnvironmentBody): string[] {
  const before = new Map<string, string>(), after = new Map<string, string>();
  flatten(previous, "", before); flatten(next, "", after);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  const lines = changed.slice(0, TEST_ENV_DIFF_MAX).map((path) => shownLine(redactText(`${path}: ${before.get(path) ?? "(none)"} → ${after.get(path) ?? "(none)"}`), LINE_MAX));
  return changed.length > TEST_ENV_DIFF_MAX ? [...lines, `and ${String(changed.length - TEST_ENV_DIFF_MAX)} more changes`] : lines;
}
