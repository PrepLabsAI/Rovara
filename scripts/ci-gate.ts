// CI's gate. `quick` (the docs-only scope check, the checks and the release check), the test shards and the Linux runtime check run as separate
// jobs; the job called `local` waits for all of them and is the one check a pull request needs. A Markdown-only change leaves those jobs green
// with their heavy steps skipped (each runs the scope check itself), so every job must succeed. GitHub counts a skipped job as a pass, so a plain
// `needs` would let a pull request go green with a job missing: this checks each result by name. Node runs this file directly, so it imports only
// Node's own modules.

export interface GateVerdict { ok: boolean; reason: string }

/** The jobs `local` waits for; each must be in `needs` and succeed. */
export const GATED_JOBS = ["quick", "test", "linux-runtime"] as const;

/** `results` maps each job the gate waited for to its result: success, failure, cancelled or skipped. */
export function gateVerdict(input: { docsOnly: boolean; results: Readonly<Record<string, string>> }): GateVerdict {
  const { docsOnly, results } = input;
  for (const job of GATED_JOBS) {
    if (results[job] === undefined) return { ok: false, reason: `${job} was missing` };
  }
  for (const [job, result] of Object.entries(results)) {
    if (result !== "success") return { ok: false, reason: `${job} was ${result}, not success` };
  }
  return { ok: true, reason: docsOnly ? "Markdown-only change; every job succeeded with its heavy steps skipped" : `${Object.keys(results).length} jobs succeeded` };
}

interface Need { result?: unknown; outputs?: { docs_only?: unknown } }

/** The verdict for the JSON of GitHub's `needs` context (`toJSON(needs)`). */
export function needsVerdict(needsJson: string): GateVerdict {
  let needs: unknown;
  try {
    needs = JSON.parse(needsJson);
  } catch {
    return { ok: false, reason: "the needs context is not JSON" };
  }
  if (typeof needs !== "object" || needs === null) return { ok: false, reason: "the needs context is not an object" };
  const entries = Object.entries(needs as Record<string, Need>);
  const results = Object.fromEntries(entries.map(([job, need]) => [job, String(need?.result)]));
  const docsOnly = (needs as Record<string, Need>).quick?.outputs?.docs_only === "true";
  return gateVerdict({ docsOnly, results });
}

// Usage: NEEDS='<toJSON(needs)>' node scripts/ci-gate.ts
if (process.argv[1]?.endsWith("ci-gate.ts")) {
  const verdict = needsVerdict(process.env.NEEDS ?? "");
  console.log(verdict.ok ? `CI passed: ${verdict.reason}.` : `CI did not pass: ${verdict.reason}.`);
  process.exitCode = verdict.ok ? 0 : 1;
}
