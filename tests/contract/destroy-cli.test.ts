import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { lineReader } from "../../packages/cli/src/destroy/cli.js";
import { destroyProjectFiles } from "../../packages/cli/src/destroy/project-files.js";
import { writeEnvironmentCache } from "../../packages/cli/src/environments/cache.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli, type CliDependencies } from "../../packages/cli/src/main.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { fakeDestroyApi, installedAccount, type FakeAccount } from "../support/destroy-fakes.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { memoryTokenStore } from "../support/setup-fakes.js";

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
}

/** An installed staging environment; every dependency but `leave` is faked. */
async function destroyDeps(input: { caller?: string; account?: FakeAccount; leave?: Array<"confirmLine" | "projectFiles" | "region">; installed?: boolean; home?: string; region?: string } = {}): Promise<{ destroy: NonNullable<CliDependencies["destroy"]>; account: FakeAccount }> {
  const store = new MemoryParameterStore();
  if (input.installed !== false) await writeEnvironmentSettings(store, SETTINGS);
  let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const account = input.account ?? installedAccount();
  const destroy: NonNullable<CliDependencies["destroy"]> = {
    store, api: fakeDestroyApi(account, clock), identity: { get: async () => ({ account: "123456789012", arn: input.caller ?? ADMIN }) },
    confirmLine: async () => "staging", projectFiles: async () => [], tokenStore: memoryTokenStore(), home: input.home ?? "/nonexistent-agentx-home", ...clock,
    ...(input.region === undefined ? {} : { region: input.region }),
  };
  for (const name of input.leave ?? []) delete destroy[name];
  return { destroy, account };
}

describe("agentx destroy", () => {
  it("needs an explicit --env, so it never removes production by default", async () => {
    const io = capture();
    expect(await executeCli(["destroy"], io)).toBe(2);
    expect(io.err.join("")).toContain("agentx destroy requires an explicit --env");
  });

  it("removes the environment after the typed name, and prints the manual steps on stdout", async () => {
    const io = capture();
    const { destroy } = await destroyDeps();
    const code = await executeCli(["--env", "staging", "destroy", "--region", "us-east-1"], { ...io, destroy });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Removed environment staging.");
    expect(io.out.join("")).toContain("https://api.slack.com/apps");
    // Once, on stdout: stderr carries the progress only.
    expect(io.err.join("")).not.toContain("https://api.slack.com/apps");
  });

  it("keeps the data with --keep-data", async () => {
    const io = capture();
    const { destroy } = await destroyDeps();
    expect(await executeCli(["--env", "staging", "--json", "destroy", "--region", "us-east-1", "--keep-data"], { ...io, destroy })).toBe(0);
    const result = (JSON.parse(io.out.join("")) as { data: { kept: string[] } }).data;
    expect(result.kept).toContain("AWS::DynamoDB::Table agentx-staging-control-plane-State-5e");
  });

  it("reads each typed answer from piped stdin, in order (question 11)", async () => {
    const written: string[] = [];
    const reader = lineReader({ stdin: Readable.from(["staging\n123456789012\n"]), stderr: { write: (text: string) => written.push(text) } });
    expect(await reader.ask("Type the name: ")).toBe("staging");
    expect(await reader.ask("Type the account: ")).toBe("123456789012");
    expect(await reader.ask("Anything else: ")).toBe("");
    reader.close();
    expect(written).toEqual(["Type the name: ", "Type the account: ", "Anything else: "]);
  });

  it("destroys with the name piped on stdin, and refuses on empty stdin, deleting nothing (question 11)", async () => {
    const piped = await destroyDeps({ leave: ["confirmLine"] });
    expect(await executeCli(["--env", "staging", "destroy", "--region", "us-east-1"], { ...capture(), destroy: piped.destroy, stdin: Readable.from(["staging\n"]) })).toBe(0);

    const io = capture();
    const empty = await destroyDeps({ leave: ["confirmLine"] });
    expect(await executeCli(["--env", "staging", "destroy", "--region", "us-east-1"], { ...io, destroy: empty.destroy, stdin: Readable.from([]) })).toBe(2);
    expect(io.err.join("")).toContain("you typed nothing, not staging; nothing was removed");
    expect(empty.account.calls).toEqual([]);
  });

  it("refuses the operator role, naming admin credentials (question 7)", async () => {
    const io = capture();
    const { destroy, account } = await destroyDeps({ caller: OPERATOR });
    expect(await executeCli(["--env", "staging", "destroy", "--region", "us-east-1"], { ...io, destroy })).toBe(2);
    expect(io.err.join("")).toContain("agentx destroy needs admin credentials");
    expect(account.calls).toEqual([]);
  });

  it("refuses a region other than the one the environment is installed in", async () => {
    const io = capture();
    const { destroy, account } = await destroyDeps();
    expect(await executeCli(["--env", "staging", "destroy", "--region", "eu-west-1"], { ...io, destroy })).toBe(2);
    expect(io.err.join("")).toContain("environment staging is installed in us-east-1, not eu-west-1; run agentx --env staging destroy --region us-east-1");
    expect(account.calls).toEqual([]);
  });
});

/** A config dir holding staging's project file, and a copy of its header over YAML that does not parse. */
async function projectsWithBrokenFile(): Promise<{ configDir: string; written: string; broken: string }> {
  const configDir = await mkdtemp(join(tmpdir(), "agentx-destroy-projects-"));
  dirs.push(configDir);
  const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: "20", volumeType: "gp3" } as never;
  await writeProjectFile(configDir, { name: "payments", revision: 1 } as unknown as ProjectDefinition, { env: "staging", binding });
  const [name] = (await readdir(configDir)).filter((entry) => entry.endsWith(".yaml"));
  const written = join(configDir, name!);
  const header = (await readFile(written, "utf8")).split("\n").filter((line) => line.startsWith("#")).join("\n");
  const broken = join(configDir, "broken.yaml");
  await writeFile(broken, `${header}\nname: [unclosed\n`);
  return { configDir, written, broken };
}

describe("destroy's project files", () => {
  it("skips a project file it cannot read as YAML, saying so, and keeps it", async () => {
    const { configDir, written, broken } = await projectsWithBrokenFile();
    const lines: string[] = [];
    const found = await destroyProjectFiles({ configDir, env: "staging", write: (line) => lines.push(line) });
    expect(found).toEqual([{ path: written, launchTemplateId: "lt-0123456789abcdef0" }]);
    expect(lines).toEqual([`Skipping ${broken}: it is not valid YAML, so agentx destroy leaves it; delete it by hand if it belongs to staging`]);
  });

  it("removes the environment's readable project files through the command, and leaves the broken one", async () => {
    const { configDir } = await projectsWithBrokenFile();
    const { destroy } = await destroyDeps({ leave: ["projectFiles"] });
    const io = capture();
    expect(await executeCli(["--env", "staging", "--config-dir", configDir, "destroy", "--region", "us-east-1"], { ...io, destroy })).toBe(0);
    expect(await readdir(configDir)).toEqual(["broken.yaml"]);
    expect(io.err.join("")).toContain("Skipping");
  });
});

describe("agentx destroy in the wrong region", () => {
  const nothing = (): FakeAccount => ({ stacks: new Map(), instances: [], volumes: [], tags: new Map(), secrets: [], aliases: [], calls: [] });

  it("refuses when this computer's record of the environment names another region", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-destroy-home-"));
    dirs.push(home);
    const cache = await writeEnvironmentCache(home, SETTINGS);
    const { destroy, account } = await destroyDeps({ installed: false, account: nothing(), home });
    const io = capture();
    expect(await executeCli(["--env", "staging", "destroy", "--region", "eu-west-1"], { ...io, destroy })).toBe(2);
    expect(io.err.join("")).toContain(`this computer's record of environment staging (${cache}) says it is in us-east-1, not eu-west-1; run agentx --env staging destroy --region us-east-1`);
    expect(account.calls).toEqual([]);
    expect(await readFile(cache, "utf8")).toContain("staging");
  });

  it("says it found nothing, naming the account and region, and exits 2 (with no record anywhere)", async () => {
    const { destroy } = await destroyDeps({ installed: false, account: nothing() });
    const io = capture();
    expect(await executeCli(["--env", "staging", "destroy", "--region", "eu-west-1"], { ...io, destroy })).toBe(2);
    const message = "found nothing for environment staging in account 123456789012, region eu-west-1; if it is installed in another region, pass --region <that region>";
    expect(io.out.join("")).toContain(message);
    expect(io.err.join("")).toContain(message);
  });

  it("uses --region over an injected region", async () => {
    const { destroy, account } = await destroyDeps({ region: "us-east-1" });
    const io = capture();
    expect(await executeCli(["--env", "staging", "destroy", "--region", "eu-west-1"], { ...io, destroy })).toBe(2);
    expect(io.err.join("")).toContain("environment staging is installed in us-east-1, not eu-west-1");
    expect(account.calls).toEqual([]);
  });

  it("refuses when no region is configured anywhere", async () => {
    for (const name of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"]) vi.stubEnv(name, undefined);
    vi.stubEnv("AWS_CONFIG_FILE", "/dev/null");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null");
    const { destroy, account } = await destroyDeps();
    const io = capture();
    expect(await executeCli(["--env", "staging", "destroy"], { ...io, destroy })).toBe(2);
    expect(io.err.join("")).toContain("agentx destroy could not find an AWS region in your configuration; pass --region <the environment's region>");
    expect(account.calls).toEqual([]);
  });
});
