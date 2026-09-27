import { describe, expect, it } from "vitest";
import {
  INIT_STEP_IDS, emptyProgress, installAnswersParameterName, installProgressParameterName, readInstallAnswers,
  readInstallProgress, writeInstallAnswers, writeInstallProgress, type InitAnswers,
} from "../../packages/cli/src/init/install-state.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

describe("install state", () => {
  it("names its parameters under the environment's settings prefix", () => {
    expect(installAnswersParameterName("staging")).toBe("/agentx/staging/install/answers");
    expect(installProgressParameterName("staging")).toBe("/agentx/staging/install/progress");
    expect(INIT_STEP_IDS).toEqual(["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service"]);
  });

  it("round-trips answers and progress", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers());
    expect(await readInstallAnswers(store, "staging")).toEqual(sampleAnswers());
    const progress = { ...emptyProgress("staging", T0), steps: { access: { status: "done" as const, at: "2026-09-27T00:00:00.000Z" } } };
    await writeInstallProgress(store, progress);
    expect(await readInstallProgress(store, "staging")).toEqual(progress);
    expect(await readInstallProgress(store, "other")).toBeUndefined();
  });

  it("refuses answers that carry an unknown field, such as a secret someone added", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallAnswers(store, { ...sampleAnswers(), botToken: "xoxb-1" } as InitAnswers)).rejects.toThrow("install answers are invalid");
    expect(store.values.size).toBe(0);
  });

  it("refuses a value larger than a standard SSM parameter, naming the size", async () => {
    const store = new MemoryParameterStore();
    const huge = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: Array.from({ length: 400 }, (_, i) => `group-${i}`) } });
    await expect(writeInstallAnswers(store, huge)).rejects.toThrow(/install answers for environment staging are \d+ bytes, more than SSM's 4096-byte limit/);
    expect(store.values.size).toBe(0);
  });

  it("the largest ordinary answers fit comfortably", async () => {
    const store = new MemoryParameterStore();
    const big = sampleAnswers({
      permissionsBoundaryArn: `arn:aws:iam::123456789012:policy/${"b".repeat(120)}`,
      operatorPrincipalArn: `arn:aws:iam::123456789012:role/${"o".repeat(64)}`,
      images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}`, slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/s@sha256:${"b".repeat(64)}` },
      alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" },
    });
    await writeInstallAnswers(store, big);
    expect(Buffer.byteLength(store.values.get("/agentx/staging/install/answers")!)).toBeLessThan(2048);
  });

  it("explains progress written by a newer agentx", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/install/progress", JSON.stringify({ ...emptyProgress("staging", T0), steps: { "admin-user": { status: "done", at: "2026-09-27T00:00:00.000Z" } } }));
    await expect(readInstallProgress(store, "staging")).rejects.toThrow("install progress for environment staging is invalid or was written by a newer agentx; upgrade agentx and run it again");
  });

  // F22: reading install state refuses when the stored env does not match the requested one, even
  // though the stored value is otherwise a perfectly well-formed answers/progress document (its own
  // `env` field is just a different, equally valid, environment name).
  it("refuses install answers whose own env field names a different environment than requested", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers({ env: "production" }));
    // Copy the value under staging's parameter name, as if it had been restored or copied by hand.
    store.values.set(installAnswersParameterName("staging"), store.values.get(installAnswersParameterName("production"))!);
    await expect(readInstallAnswers(store, "staging")).rejects.toThrow(/staging.*production/);
  });

  it("refuses install progress whose own env field names a different environment than requested", async () => {
    const store = new MemoryParameterStore();
    await writeInstallProgress(store, emptyProgress("production", T0));
    store.values.set(installProgressParameterName("staging"), store.values.get(installProgressParameterName("production"))!);
    await expect(readInstallProgress(store, "staging")).rejects.toThrow(/staging.*production/);
  });
});
