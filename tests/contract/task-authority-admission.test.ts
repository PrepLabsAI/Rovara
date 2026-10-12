import { describe, expect, it } from "vitest";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";

describe("task authority admission", () => {
  it("bounds authority by six seconds and reserves two seconds of Lambda time", () => {
    let now = 1_000;
    const admission = createTaskAuthorityAdmission({ now: () => now, lambdaRemainingMs: 5_000 });

    expect(admission.deadlineAt).toBe(4_000);
    expect(admission.remainingMs()).toBe(3_000);
    admission.close();
    now = 4_000;
    expect(() => admission.assertOpen()).toThrow();
  });

  it("binds one stable UUID to the full guard admission", () => {
    const first = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const second = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const firstId = first.id;
    const secondId = second.id;

    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.id).toBe(firstId);
    expect(secondId).not.toBe(firstId);
  });

  it("refuses a state read when the context reserve leaves no authority budget", () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 2_000 });

    expect(() => admission.admitStateRead()).toThrow();
    expect(admission.remainingStateReads()).toBe(128);
  });

  it("counts state reads before issuance and shares the ceiling across callers", () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });

    for (let index = 0; index < 128; index += 1) admission.admitStateRead();
    expect(admission.remainingStateReads()).toBe(0);
    expect(() => admission.admitStateRead()).toThrow();
  });

  it("counts unique checked identities and Slack usage within one admission", () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });

    admission.admitIdentity("a".repeat(64));
    admission.admitIdentity("a".repeat(64));
    admission.admitIdentity("b".repeat(64));
    admission.recordSlackUsage(3);

    expect(admission.checkedIdentityCount()).toBe(2);
    expect(admission.remainingSlackCalls()).toBe(97);
  });

  it("seals the admission when usage exceeds the remaining Slack budget", () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });

    expect(() => admission.recordSlackUsage(101)).toThrow();
    expect(() => admission.assertOpen()).toThrow();
  });
});
