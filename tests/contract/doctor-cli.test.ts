import { describe, expect, it, vi } from "vitest";
import type { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DOCTOR_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";
import { doctorStackReader, realDoctorServices } from "../../packages/cli/src/doctor/aws.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { checkDeveloperSignIn } from "../../packages/cli/src/signin/check.js";
import type * as SignInCheckModule from "../../packages/cli/src/signin/check.js";
import { doctorServices, SECRETS, SETTINGS } from "../support/doctor-fakes.js";
import { fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

vi.mock("../../packages/cli/src/signin/check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SignInCheckModule>();
  return { ...actual, checkDeveloperSignIn: vi.fn(actual.checkDeveloperSignIn) };
});

/** Every fake secret value doctor could read: none may reach stdout or stderr. The private key is
 * checked line by line, since a single line of it would already be a leak. */
const SECRET_VALUES = [
  ...Object.values(SECRETS), TEST_BOT_TOKEN, TEST_SIGNING_SECRET, "ghs_installation-token-value",
  ...TEST_PRIVATE_KEY.split("\n").filter((line) => line.length >= 40),
  ...Object.values(SECRETS).flatMap((raw) => { try { return Object.values(JSON.parse(raw) as Record<string, string>); } catch { return []; } }).filter((value) => value.length >= 16),
];
const expectNoSecret = (io: { out: string[]; err: string[] }) => {
  const output = io.out.join("") + io.err.join("");
  for (const secret of SECRET_VALUES) expect(output).not.toContain(secret);
};
const failingServices = () => doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) }) });

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
    expect(parsed.ok).toBe(true);
    expectNoSecret(io);
  });

  it("with --json and a failed check: exit 2, stdout's document says ok false with the report, stderr's says why", async () => {
    const io = capture();
    const code = await executeCli(["--env", "staging", "--json", "doctor"], { ...io, doctor: { store: await seeded(), services: failingServices } });
    expect(code).toBe(2);
    const report = JSON.parse(io.out.join("")) as { ok: boolean; data: { failed: number } };
    expect(report).toMatchObject({ ok: false, data: { failed: 1 } });
    const error = JSON.parse(io.err.join("")) as { ok: boolean; error: { code: string; message: string } };
    expect(error).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", message: "1 doctor check failed; fix what each one names, then run agentx doctor again" } });
    expectNoSecret(io);
  });

  it("never prints a secret value, passing or failing, in text or JSON", async () => {
    for (const argv of [["--env", "staging", "doctor"], ["--env", "staging", "--json", "doctor"]]) {
      for (const services of [() => doctorServices(), failingServices, () => doctorServices({ secrets: memoryInitSecrets({ ...SECRETS, "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: "not-hex" }) }) })]) {
        const io = capture();
        await executeCli(argv, { ...io, doctor: { store: await seeded(), services } });
        expect(io.out.join("").length).toBeGreaterThan(0);
        expectNoSecret(io);
      }
    }
  });

  it("says what to do when the environment's settings cannot be read (no AWS credentials or region)", async () => {
    const io = capture();
    const store = new MemoryParameterStore();
    store.get = async () => { throw new Error("Region is missing"); };
    const code = await executeCli(["--env", "staging", "doctor"], { ...io, doctor: { store, services: () => doctorServices() } });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("could not read environment staging's settings (Region is missing); sign in to AWS for this account, pass --region if your AWS configuration names none, then run agentx doctor again");
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

  it("calls the real checkDeveloperSignIn with doctor's own store, secrets and Slack client", async () => {
    const store = new MemoryParameterStore();
    const services = realDoctorServices({ settings: SETTINGS, store, fetch: (async () => { throw new Error("no network in tests"); }), home: "/nonexistent-agentx-home", configDir: "/nonexistent-agentx-projects", stderr: { write: () => undefined } });
    vi.mocked(checkDeveloperSignIn).mockClear();
    await services.signIn(SETTINGS);
    expect(vi.mocked(checkDeveloperSignIn)).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(checkDeveloperSignIn).mock.calls[0]!;
    expect(input.env).toBe("staging");
    expect(input.settings).toBe(SETTINGS);
    expect(input.store).toBe(store);
    expect(input.secrets).toBe(services.secrets);
    expect(input.slackApi).toBe(services.slackApi);
  });

  it("never starts drift detection: it only reads the last result (question 5)", async () => {
    const sent: string[] = [];
    const reader = doctorStackReader({ async send(command: unknown) { sent.push((command as object).constructor.name); return { Stacks: [] }; } });
    await reader.describe("agentx-staging-slack");
    expect(sent).toEqual(["DescribeStacksCommand"]);
    expect(DOCTOR_AWS_ACTIONS.filter((action) => /Drift/.test(action))).toEqual([]);
  });
});
