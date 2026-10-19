import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type WebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { collectHostRun } from "./e2e-actual-run-proof.js";
import { blockedHosts, readReport } from "./e2e-executor-output.js";
import { runProbe, type ProbeOptions, type ProbeRun } from "./linux-runtime.js";
import type { OrdersProbeName } from "./e2e-orders-executor-fixture.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
/** The outside host the egress probes try to reach; the qualification oracle requires exactly this one to be recorded as blocked. */
const OUTSIDE_URL = "https://probe.example.com/ping";

type ProbePlan = Readonly<{ probe: OrdersProbeName; options: ProbeOptions }>;

/** How each required qualification probe is driven through the fixture app; the oracle in contracts judges the outcome, not this table. */
function planFor(probeId: string): ProbePlan {
  switch (probeId) {
    case "web-csv-positive-v1": return { probe: "web-csv-positive-v1", options: { defect: null } };
    case "web-csv-negative-v1": return { probe: "web-csv-positive-v1", options: { defect: "extra-order.json" } };
    case "web-egress-denial-v1": return { probe: "web-egress-denial-v1", options: { defect: null, appEnv: { FIXTURE_EGRESS_PROBE_URL: OUTSIDE_URL } } };
    case "api-state-positive-v1": return { probe: "api-state-positive-v1", options: { defect: null } };
    case "api-egress-denial-v1": return { probe: "api-egress-denial-v1", options: { defect: null, appEnv: { INVENTORY_ORIGIN: "https://probe.example.com" } } };
    case "build-imds-denial-v1": {
      // The build command and its expected exit code come from the installed probe asset, so the probe the qualifier records is the one that ran.
      const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === probeId)!;
      if (asset.probe.oracle.kind !== "build-command-failure") throw new Error("the IMDS probe asset has no build command");
      return { probe: "web-csv-positive-v1", options: { defect: null, recipeBuild: [asset.probe.oracle.build] } };
    }
    default: throw new Error(`no probe plan for ${probeId}`);
  }
}

/** The worker's own join after close: the host's actual run and protected inputs through the real collector. */
async function collectLikeTheWorker(r: ProbeRun) {
  const inputs = await r.host.readCollectionInputs(new AbortController().signal);
  const original = process.execPath;
  process.execPath = r.run.actualRun!.runnerToolchain.execPath;
  try { return collectHostRun(r.run.actualRun!, inputs, r.fixture.plan); } finally { process.execPath = original; }
}

/**
 * Runs one qualification probe through the production Docker host and the real collector, and reports only what happened.
 * Judging the outcome is the qualifier's job; this reads the verdict, the failed assertions, the blocked hosts and the upstream
 * report's retry, skip and flaky counts straight from the run's own evidence.
 */
export async function observeWebApiProbe(probeId: string): Promise<WebApiProbeObservation> {
  const plan = planFor(probeId);
  const r = await runProbe(plan.probe, plan.options);
  const diagnostics = r.host.readDiagnostics(r.fixture.plan.runId);
  if (r.run.unavailableReason !== null || r.run.actualRun === null) {
    const buildExit = /exit code (\d+)/.exec(diagnostics.buildLogTail)?.[1];
    return { collectorStatus: null, runUnavailableReason: r.run.unavailableReason ?? "unavailable", failedAssertionKinds: [], blockedHosts: [],
      buildExitCode: buildExit === undefined ? null : Number(buildExit), attempts: 1, skipped: 0, flaky: 0, evidenceDigest: sha(canonicalJson({ probeId, diagnostics })) };
  }
  const collected = await collectLikeTheWorker(r);
  const status = collected.unavailableReason === null ? collected.qualification?.status ?? "UNKNOWN" : "UNKNOWN";
  const scenario = r.fixture.compiled.bundle.scenarios[0]!;
  const failedAssertionKinds = (collected.qualification?.result?.cases ?? []).flatMap((verdict) => verdict.assertionReceipts
    .filter((receipt) => receipt.status === "failed").map((receipt) => scenario.assertions[receipt.assertionIndex]!.kind));
  const outDir = r.outDir;
  const report = outDir === null ? null : readReport(outDir);
  return { collectorStatus: status === "PASS" || status === "FAILED" ? status : "UNKNOWN", runUnavailableReason: null, failedAssertionKinds,
    blockedHosts: outDir === null ? [] : blockedHosts(outDir), buildExitCode: null,
    attempts: Math.max(1, ...(report?.run.results.map((result) => result.attempts.length) ?? [1])),
    skipped: report?.run.summary.skipped ?? 0, flaky: report?.run.summary.flaky ?? 0,
    evidenceDigest: sha(outDir === null ? canonicalJson({ probeId, diagnostics }) : readFileSync(join(outDir, "report.json"))) };
}
