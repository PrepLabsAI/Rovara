import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evalSpendInputsDigest, attestRovaraOnlyBaseCheckout, type EvalSpendGrant, type EvalBaseRecord } from "@agentx/contracts";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import type { EvalFinalCheckPorts, EvalFinalCheckPlan } from "../../packages/worker/src/verification/eval-final-check.js";
const hash = "b".repeat(64);
export async function createEvalFinalCheckWorld(newPass = true, n = 4) {
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "eval-wire-"));
  const calls: string[] = []; const holds: Array<{ calls: number; costMicros: number; company: string }> = []; const closed: string[] = []; const stages: Array<{ side: string; runs: number; ids: readonly string[] }> = [];
  let approvals = 0; let planned = 0;
  const settings = { imageDigest: "image", route: "customer" };
  const key = { company: "company-a", project: "project-a", baseCommit: "a".repeat(40), codeHash: "c".repeat(64), judgePin: hash, commandFingerprint: hash, catalogRowId: "model", model: "model-a", modelVersion: "v1" };
  const inputs = { evalSetHash: hash, judgePin: hash, commandFingerprint: hash, model: "model-a", modelVersion: "v1", catalogRowId: "model", settingsFingerprint: evalSettingsFingerprint(settings, hash) };
  const plan: EvalFinalCheckPlan = { company: key.company, project: key.project, selection: "eval", inputs, key, settings, evalSetHash: hash, evalConfigured: true, judgePin: hash, baselineJudgePin: hash, subsetSupported: true,
    questions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, category: "ordinary", baseHash: hash, headHash: hash })), maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10 };
  const record: EvalBaseRecord = { schemaVersion: 1, runnerSchemaVersion: 1, recordedOn: "2026-11-13", roundKind: "check_unsealed", measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }], caseCount: n, questions: plan.questions.map(q => ({ id: q.id, samples: Array.from({ length: 3 }, () => ({ pass: true, answer: "old" })) })) };
  const grant: EvalSpendGrant = { company: key.company, project: key.project, selection: "eval", role: "owner", inputsDigest: evalSpendInputsDigest(inputs), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
  const ports: EvalFinalCheckPorts = { roundKind: "check_unsealed", plan: async () => { planned++; return plan; }, approval: { read: async () => { approvals++; return grant; } },
    meter: { reserve: async r => { holds.push({ calls: r.calls, costMicros: r.costMicros, company: r.approval.company }); return { call: async () => { calls.push(r.approval.company); return { class: "ok", calls: 1, costMicros: 10 }; }, close: async () => { closed.push(r.approval.company); } }; } },
    cache: { read: async () => record, write: async () => "stored" }, baselines: { forTask: async () => "unavailable" },
    runner: async r => {
      stages.push({ side: r.side, ids: r.ids, runs: r.runs });
      for (let i = 0; i < r.ids.length * r.runs; i++) await r.call({} as ModelEgressFrame);
      const file = `report-${stages.length}.json`;
      await writeFile(join(root, file), JSON.stringify({ schemaVersion: 1, eval_set_hash: hash, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }], questions: r.ids.map(id => ({ id, samples: Array.from({ length: r.runs }, () => ({ pass: r.side === "old" || newPass, answer: r.side === "old" ? "old" : "new" })) })) }));
      return { report: { root, cwd: ".", argument: file, notBeforeMs: Date.now() - 1000 }, facts: { total: r.ids.length * r.runs, run: r.ids.length * r.runs, notRun: 0, byClass: {}, overrunStop: false }, calls: 0, costMicros: 0, changedPromptCalls: r.side === "new" ? r.ids.length : 0, seconds: 1, attestation: attestRovaraOnlyBaseCheckout({ baseCommit: key.baseCommit }) };
    },
  };
  return { root, cleanup: () => rm(root, { recursive: true, force: true }), ports, plan, grant, record, calls, holds, closed, stages, approvals: () => approvals, planned: () => planned };
}
