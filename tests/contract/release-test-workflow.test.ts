import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { needs?: string | string[]; if?: string; strategy?: { matrix?: Record<string, unknown>; "max-parallel"?: number }; env?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: Record<string, unknown>; env: Record<string, string>; jobs: Record<string, Job> }

const text = () => readFile(".github/workflows/release-test.yml", "utf8");
const workflow = async () => YAML.parse(await text()) as Workflow;
const runs = (wf: Workflow) => Object.values(wf.jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")).join("\n");

describe("the release test workflow (SC-003 to SC-005, question 6)", () => {
  it("runs only by hand, one at a time, with OIDC and read-only contents", async () => {
    const wf = await workflow();
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.concurrency).toEqual({ group: "release-test", "cancel-in-progress": false });
  });

  it("installs with each engine, runs doctor, upgrades from the previous release, and exercises the export path", async () => {
    const wf = await workflow();
    expect(wf.jobs.lane?.strategy?.matrix?.engine).toEqual(["templates", "cdk"]);
    const all = runs(wf);
    expect(all).toMatch(/ init --yes [\s\S]*?--stop-after developer-signin/);
    expect(all).toContain(" doctor --region ");
    expect(all).toContain(" upgrade --yes ");
    expect(all).toContain(" init --export ");
    expect(all).toContain(" init --resume --from-bundle ");
    expect(all).toContain(" config set alerts.slowTurnMinutes 7 --yes");
  });

  it("always tears down every environment it made with agentx destroy, the name piped in", async () => {
    const wf = await workflow();
    expect(wf.jobs.teardown?.if).toBe("always()");
    expect(wf.jobs.teardown?.needs).toEqual(["lane", "export"]);
    expect(runs(wf)).toMatch(/printf '%s\\n%s\\n' "\$env" "\$ACCOUNT" \| node packages\/cli\/dist\/main\.js --env "\$env" destroy --region "\$AWS_REGION"/);
  });

  it("never names production, and passes every secret through an environment variable, never a flag's value", async () => {
    const all = await text();
    expect(all).not.toMatch(/production/i);
    for (const line of runs(await workflow()).split("\n")) expect(line).not.toMatch(/\$\{\{\s*secrets\./);
    expect(all).toContain("--github-private-key-env RT_GITHUB_PRIVATE_KEY");
    expect(all).toContain("--slack-bot-token-env RT_SLACK_BOT_TOKEN");
  });

  it("keeps environment names within 20 characters", async () => {
    expect(await text()).toMatch(/AGENTX_ENV: rt\$\{\{ github\.run_number \}\}/);
  });

  // Rulings F5: init refuses a first --yes run without --admin-email and --channel, before it
  // creates anything. --stop-after developer-signin stops before either is used.
  it("gives the first init --yes the admin email and channel it refuses to start without", async () => {
    const first = runs(await workflow()).split("\n").filter((line) => line.includes(" init --yes "));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("--admin-email release-test@example.com --channel agentx-release-test");
  });

  // Question 6: the release test needs a throwaway account and test apps, so it is off by default.
  it("does nothing, not even a teardown, unless the repository variable turns it on", async () => {
    const wf = await workflow();
    const gate = "vars.AGENTX_ENABLE_RELEASE_TEST == 'true'";
    expect(wf.jobs.images?.if).toBe(gate);
    for (const step of wf.jobs.teardown?.steps ?? []) expect(step.if).toBe(gate);
  });

  // The Elastic IP quota fits one throwaway environment in an account at a time.
  it("never has two environments in the account at once: one install at a time, each destroyed before the next", async () => {
    const wf = await workflow();
    expect(wf.jobs.lane?.strategy?.["max-parallel"]).toBe(1);
    expect(wf.jobs.export?.needs).toEqual(["images", "lane"]);
    for (const name of ["lane", "export"]) {
      const last = wf.jobs[name]?.steps.at(-1);
      expect(last?.if).toBe("always()");
      expect(last?.run).toMatch(/printf '%s\\n%s\\n' "\$env" "\$ACCOUNT" \| node packages\/cli\/dist\/main\.js --env "\$env" destroy --region "\$AWS_REGION"/);
    }
  });

  it("takes AWS credentials only from OIDC, never from long-lived keys", async () => {
    const all = await text();
    expect(all).not.toMatch(/aws-access-key-id|aws-secret-access-key|secrets\.AWS_/i);
    const wf = await workflow();
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials"))) {
        expect(step.with?.["role-to-assume"]).toBe("${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}");
      }
    }
  });

  // Rulings F22: doctor's Slack redirect URL check may fail against the pre-made test Slack app,
  // which cannot list every new environment's callback. Until Task 20 confirms it, the workflow
  // runs doctor with --json and fails on every other failed check, and prints that one for the
  // manual release check.
  it("runs every doctor through the gate that sets aside only the Slack redirect URL check", async () => {
    const wf = await workflow();
    const doctorLines = runs(wf).split("\n").filter((line) => line.includes(" doctor --region "));
    expect(doctorLines.length).toBeGreaterThanOrEqual(4);
    for (const line of doctorLines) {
      expect(line).toContain("node packages/cli/dist/main.js --json --env \"$AGENTX_ENV\" doctor --region \"$AWS_REGION\" > \"$RUNNER_TEMP/doctor.json\" || true");
    }
    const gates = runs(wf).split("\n").filter((line) => line.includes("\"$DOCTOR_GATE\""));
    expect(gates).toHaveLength(doctorLines.length);
    const gate = wf.env.DOCTOR_GATE ?? "";
    // Only Slack's own "not registered" answer; "no Slack client ID is stored" still fails.
    expect(gate).toContain(".group == \"sign-in\" and .name == \"Slack redirect URL\" and (.detail | startswith(\"Slack does not list\"))");
    expect(gate.match(/Slack redirect URL/g)).toHaveLength(1);
  });

  // A cancelled run kills agentx before its finally releases /agentx/<env>/lock, and destroy
  // refuses a locked environment, so each destroy first removes the lock this run left.
  it("removes this run's own lock before every destroy, so a cancelled run is still torn down", async () => {
    const all = await text();
    expect(all).toMatch(/^#.*lock/m);
    const destroySteps = Object.values((await workflow()).jobs).flatMap((job) => job.steps).filter((step) => step.run?.includes(" destroy --region "));
    expect(destroySteps).toHaveLength(3);
    const unlock = 'aws ssm delete-parameter --name "/agentx/$env/lock" --region "$AWS_REGION" 2>/dev/null || true';
    for (const step of destroySteps) {
      const run = step.run ?? "";
      expect(run).toContain(unlock);
      expect(run.indexOf(unlock)).toBeLessThan(run.indexOf(" destroy --region "));
    }
  });

  it("gives the GitHub token only to the step that downloads the previous release", async () => {
    const wf = await workflow();
    for (const job of Object.values(wf.jobs)) expect(job.env?.GH_TOKEN).toBeUndefined();
    const holders = Object.values(wf.jobs).flatMap((job) => job.steps).filter((step) => step.env?.GH_TOKEN !== undefined);
    expect(holders.map((step) => step.name)).toEqual(["Fetch the previous release and build the candidate"]);
    expect(holders[0]?.run).toContain("gh release download");
  });

  it("tells the owner how the rt-<run id> images are cleaned up", async () => {
    expect(await text()).toMatch(/^#.*lifecycle policy.*\n#.*rt-/m);
  });
});
