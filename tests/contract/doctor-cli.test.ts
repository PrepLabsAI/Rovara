import { describe, expect, it } from "vitest";
import type { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DOCTOR_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";
import { doctorStackReader, realDoctorServices } from "../../packages/cli/src/doctor/aws.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { doctorServices, SETTINGS } from "../support/doctor-fakes.js";
import { fakeSlackApi } from "../support/init-fakes.js";
import { checkDeveloperSignIn } from "../../packages/cli/src/signin/check.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
}

async function seeded(): Promise<MemoryParameterStore> {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, SETTINGS);
  return store;
}

describe("agentx doctor", () => {
  it("prints every check and exits 0 when nothing fails", async () => {
    const io = capture();
    const code = await executeCli(["--env", "staging", "doctor"], { ...io, doctor: { store: await seeded(), services: () => doctorServices() } });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("agentx doctor: environment staging (release 1.2.3, templates engine, us-east-1)");
  });

  it("exits non-zero when a check fails, naming how many (FR-051)", async () => {
    const io = capture();
    const services = () => doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) }) });
    const code = await executeCli(["--env", "staging", "doctor"], { ...io, doctor: { store: await seeded(), services } });
    expect(code).toBe(2);
    expect(io.out.join("")).toContain("FAIL  slack       bot token: Slack refused the bot token (invalid_auth)");
    expect(io.err.join("")).toContain("1 doctor check failed; fix what each one names, then run agentx doctor again");
  });

  it("prints machine-readable results with --json", async () => {
    const io = capture();
    await executeCli(["--env", "staging", "--json", "doctor"], { ...io, doctor: { store: await seeded(), services: () => doctorServices() } });
    const parsed = JSON.parse(io.out.join("")) as { ok: boolean; data: { env: string; failed: number; checks: unknown[] } };
    expect(parsed.data).toMatchObject({ env: "staging", failed: 0 });
    expect(parsed.data.checks.length).toBeGreaterThan(20);
  });
});

describe("doctorStackReader", () => {
  it("reads status, parameters, outputs and the last drift result, and answers undefined for a missing stack", async () => {
    const client = {
      async send(command: unknown) {
        const name = (command as DescribeStacksCommand).input.StackName;
        if (name === "agentx-staging-gone") throw Object.assign(new Error("Stack with id agentx-staging-gone does not exist"), { name: "ValidationError" });
        return { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [{ ParameterKey: "A", ParameterValue: "1" }], Outputs: [{ OutputKey: "B", OutputValue: "2" }], DriftInformation: { StackDriftStatus: "DRIFTED" } }] };
      },
    };
    const reader = doctorStackReader(client);
    expect(await reader.describe("agentx-staging-slack")).toEqual({ status: "UPDATE_COMPLETE", parameters: { A: "1" }, outputs: { B: "2" }, drift: "DRIFTED" });
    expect(await reader.describe("agentx-staging-gone")).toBeUndefined();
  });
});

describe("doctor's real services (carry-forwards)", () => {
  it("runs agentx signin check's own checks (spec 025 FR-046), not a copy", async () => {
    const store = new MemoryParameterStore();
    const services = realDoctorServices({ settings: SETTINGS, store, fetch: (async () => { throw new Error("no network in tests"); }), home: "/nonexistent-agentx-home", configDir: "/nonexistent-agentx-projects", stderr: { write: () => undefined } });
    // No sign-in settings are stored, so checkDeveloperSignIn answers before any AWS or Slack call.
    expect(await services.signIn(SETTINGS)).toEqual(await checkDeveloperSignIn({ env: "staging", store, secrets: { get: async () => undefined }, settings: SETTINGS, fetch: fetch, slackApi: fakeSlackApi() }));
    expect((await services.signIn(SETTINGS))[0]).toMatchObject({ name: "settings", ok: false });
  });

  it("never starts drift detection: it only reads the last result (question 5)", async () => {
    const sent: string[] = [];
    const reader = doctorStackReader({ async send(command: unknown) { sent.push((command as object).constructor.name); return { Stacks: [] }; } });
    await reader.describe("agentx-staging-slack");
    expect(sent).toEqual(["DescribeStacksCommand"]);
    expect(DOCTOR_AWS_ACTIONS.filter((action) => /Drift/.test(action))).toEqual([]);
  });
});
