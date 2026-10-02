// CI's gate. The checks, the test shards and the release check run as separate jobs; the job called
// `local` waits for all of them and is the one check a pull request needs. GitHub counts a skipped
// job as a pass, so a plain `needs` would let a pull request go green with a job missing: this
// checks each result by name. Node runs this file directly, so it imports only Node's own modules.

export interface GateVerdict { ok: boolean; reason: string }

/** `results` maps each job the gate waited for to its result: success, failure, cancelled or skipped. */
export function gateVerdict(input: { docsOnly: boolean; results: Readonly<Record<string, string>> }): GateVerdict {
  const { docsOnly, results } = input;
  if (results.scope !== "success") return { ok: false, reason: `scope was ${results.scope ?? "missing"}, not success` };
  const heavy = Object.entries(results).filter(([job]) => job !== "scope");
  if (heavy.length === 0) return { ok: false, reason: "no job to judge besides scope" };
  // A Markdown-only change skips every heavy job; any other change needs every one to succeed.
  const expected = docsOnly ? "skipped" : "success";
  for (const [job, result] of heavy) {
    if (result !== expected) return { ok: false, reason: `${job} was ${result}, not ${expected}` };
  }
  return { ok: true, reason: docsOnly ? "Markdown-only change; every heavy job was skipped" : `${heavy.length} jobs succeeded` };
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
  const docsOnly = (needs as Record<string, Need>).scope?.outputs?.docs_only === "true";
  return gateVerdict({ docsOnly, results });
}

// Usage: NEEDS='<toJSON(needs)>' node scripts/ci-gate.ts
if (process.argv[1]?.endsWith("ci-gate.ts")) {
  const verdict = needsVerdict(process.env.NEEDS ?? "");
  console.log(verdict.ok ? `CI passed: ${verdict.reason}.` : `CI did not pass: ${verdict.reason}.`);
  process.exitCode = verdict.ok ? 0 : 1;
}
