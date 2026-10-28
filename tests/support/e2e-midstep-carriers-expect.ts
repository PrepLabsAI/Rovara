import { expect } from "vitest";
import { allOutputText, caseStatusesAll } from "./e2e-executor-output.js";
import { CARRIER_NAMES, STRONG_CARRIERS, caseIdOf, everyPlanted, leaks, ledgerStepOf, spellings, transcriptText, type CarrierName, type CarrierRun } from "./e2e-midstep-carriers.js";

/**
 * What one group of the carrier test must show, however the group was run (the real executor on this machine, or the real executor image on Docker). The cases:
 * - `control`: the page acquires everything mid-step but shows nothing secret. Its last model call (after the clicks) must go through and show "Synced quietly": the sync did not make the
 *   executor refuse everything, so a refusal in the other cases is about what the page shows.
 * - a strong carrier: the page shows the value that carrier just acquired. The call that would have shown it must not be sent: the step fails (`MODEL_PROVIDER_FAILED`, the stop code of a
 *   model call that did not complete) at the first call after the page shows it, and the value is in no transcript and no provider-bound call, in any spelling.
 * - `weak`: the page shows the opaque id. The calls go through, the last one shows `<session>` in its place, and the case passes.
 */
export const SYNC_BUTTON = (name: CarrierName): string => (name === "control" ? "Sync quietly" : `Sync and show ${name}`);

export function expectCarrierGroup(run: CarrierRun): void {
  const why = run.why();
  // Not a credential leak: a value the run learned mid-step is scrubbed or refused, and a weak one never ends the run.
  expect(run.reason, why).not.toBe("credential-leak");
  expect(run.exitCode, why).not.toBe(2);

  // Transcripts are whole: nothing was left out for the budget, and every call that was answered kept its prompt.
  expect(run.transcripts.filter((item) => item.omitted === "budget"), why).toEqual([]);
  for (const item of run.transcripts.filter((candidate) => candidate.outcome === "ok")) {
    expect(item.omitted, why).toBeUndefined();
    expect(item.prompt, why).not.toBeNull();
  }
  expect(run.transcripts.length, why).toBeGreaterThan(0);

  // No planted value, strong or weak, of this run in any spelling: in a worker-side transcript, in a call as the provider received it, or in a file the executor left. (The labels name the value, never print it.)
  expect(leaks(run.sets, run.transcripts.map(transcriptText)), `a planted value is in a transcript\n${why}`).toEqual([]);
  expect(leaks(run.sets, run.providerCalls), `a planted value reached the provider\n${why}`).toEqual([]);
  const output = allOutputText(run.outDir);
  expect(leaks(run.sets, [output]), `a planted value is in the executor's output\n${why}`).toEqual([]);

  const statuses = caseStatusesAll(run.outDir, run.fixture);
  // Every call the provider got is a call the worker answered, and the calls are exactly the ok receipts.
  expect(run.providerCalls.length, why).toBe(run.receipts.filter((item) => item.outcome === "ok").length);

  for (const name of run.names) {
    const caseId = caseIdOf(run, name);
    const receipts = run.receipts.filter((item) => item.caseId === caseId).sort((a, b) => a.callIndex - b.callIndex);
    const transcripts = run.transcripts.filter((item) => item.caseId === caseId).sort((a, b) => a.callIndex - b.callIndex);
    const step = ledgerStepOf(run.outDir, caseId);
    const label = `${name}\n${why}`;
    // Each case clicked its own sync button (the script taps it twice; a strong case ends at the refusal, after one or two taps): the sync under test ran after the step's first model call.
    expect(step!.actions.every((action) => action.tool === "tap" && action.outcome === "ok" && action.name === SYNC_BUTTON(name)), label).toBe(true);
    // The first call, before any click, shows nothing synced and goes through.
    expect(receipts[0], label).toMatchObject({ callIndex: 0, outcome: "ok" });
    expect(transcripts[0]!.prompt, label).toContain("Nothing synced yet");

    if (name === "control" || name === "weak") {
      expect(statuses[`carrier-${name}`], label).toBe("passed");
      expect(step, label).toMatchObject({ verdict: "concluded", stopCode: null });
      expect(step!.actions, label).toHaveLength(2);
      expect(receipts.map((item) => [item.callIndex, item.outcome]), label).toEqual([[0, "ok"], [1, "ok"], [2, "ok"]]);
      // The last call is the one after both clicks: it shows the page as the sync left it.
      const after = transcripts[2]!.prompt!;
      expect(after, label).toContain(name === "control" ? "Synced quietly" : "Synced weak: <session>");
      for (const item of transcripts) expect(item.omitted, label).toBeUndefined();
      if (name === "weak") {
        // Masked, not refused: the placeholder is in the transcript and the value, in any spelling, is not.
        expect(spellings(run.sets.weak!.weak).some((form) => after.includes(form)), label).toBe(false);
      }
    } else {
      expect((STRONG_CARRIERS as readonly string[]).includes(name), label).toBe(true);
      expect(statuses[`carrier-${name}`], label).toBe("failed");
      expect(step, label).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED" });
      // The call that would have shown the value was never answered: at most the first two calls were (the second only if the screen was read before the app printed its result, and then it
      // shows nothing synced), the step ended at the refusal, and anything else the worker saw of this case was refused for a credential.
      const answered = receipts.filter((item) => item.outcome === "ok").map((item) => item.callIndex);
      expect([[0], [0, 1]], label).toContainEqual(answered);
      expect(receipts.filter((item) => item.outcome !== "ok").map((item) => item.outcome), label).toEqual(receipts.filter((item) => item.outcome !== "ok").map(() => "refused-credential-match"));
      expect(transcripts.filter((item) => item.outcome === "ok"), label).toHaveLength(answered.length);
      for (const item of transcripts.filter((candidate) => candidate.outcome === "ok")) expect(item.prompt, label).not.toContain(`Synced ${name}:`);
    }
  }
  // Every case of the group was judged, and the table of names is the one the test was written against.
  expect(run.names.every((name) => (CARRIER_NAMES as readonly string[]).includes(name))).toBe(true);
  expect(everyPlanted(run.sets).length).toBe(run.names.length * 8);
}
