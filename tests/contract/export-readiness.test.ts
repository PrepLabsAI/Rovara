import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExportBundle } from "../../packages/cli/src/deploy/export-bundle.js";
import { writeUpgradeBundle } from "../../packages/cli/src/upgrade/export.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease } from "../support/init-fakes.js";
import { readyCoreEngine } from "../support/install-gateway.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ready = { version: 1, admissionVersion: 1, snapshotVersion: 1 };
const answers = {
  env: "staging", region: "us-east-1", account: "123456789012", models: SETTINGS.models,
  identity: { mode: "cognito" as const }, coreEngine: readyCoreEngine,
  github: { appId: "123", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture" },
};

async function bundle(kind: "install" | "upgrade") {
  const parent = await mkdtemp(join(tmpdir(), "providers-export-readiness-"));
  dirs.push(parent);
  const dir = join(parent, "bundle");
  const bin = join(parent, "bin");
  await mkdir(bin);
  const calls = join(parent, "calls");
  await writeFile(calls, "");
  await writeFile(join(bin, "aws"), '#!/bin/sh\nprintf "aws %s %s\\n" "$1" "$2" >> "$EXPORT_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
  const preload = join(parent, "gateway.mjs");
  await writeFile(preload, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
  appendFileSync(process.env.EXPORT_TEST_CALLS, "gateway " + url + " " + options.redirect + "\\n");
  if (process.env.EXPORT_TEST_GATEWAY === "unavailable") throw new Error("private transport details");
  return new Response(process.env.EXPORT_TEST_GATEWAY, { status: Number(process.env.EXPORT_TEST_STATUS || "200") });
};\n`);
  const release = fakeRelease("1.3.0");
  if (kind === "install") await writeExportBundle({ dir, answers, release });
  else await writeUpgradeBundle({
    dir, settings: { ...SETTINGS, access: { artifactBucket: "fixture-bucket", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/fixture", operatorRoleArn: "arn:aws:iam::123456789012:role/fixture-operator", pullThroughPrefix: "fixture" } }, answers: { env: answers.env, region: answers.region, account: answers.account, models: answers.models, identity: answers.identity, github: answers.github }, release,
    parts: ["foundation", "control-plane", "runtime"],
    outputs: Object.fromEntries(Object.entries(allStackOutputs()).map(([name, value]) => [name.replace("agentx-staging-", ""), value])),
    deployed: { "control-plane": { CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" } },
  });
  // Execution must inspect the artifact actually present, even if it changed after export.
  await writeFile(join(dir, "templates/control-plane.template.json"), JSON.stringify({ Outputs: { ModelRunPriceVersion: { Value: "1" } } }));
  async function run(gateway: unknown = { runPrice: ready }, status = 200, commandText?: string) {
    await writeFile(calls, "");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, EXPORT_TEST_CALLS: calls,
      EXPORT_TEST_GATEWAY: typeof gateway === "string" ? gateway : JSON.stringify(gateway), EXPORT_TEST_STATUS: String(status) };
    const command = kind === "install" ? [join(dir, "deploy-access.sh"), "--yes"] : ["-c", commandText ?? (await readFile(join(dir, "README.md"), "utf8")).split("\n").find((line) => line.includes("aws s3 cp"))!];
    const result = spawnSync("bash", command, { cwd: dir, env, encoding: "utf8", timeout: 5000 });
    return { ...result, calls: (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean) };
  }
  return { dir, run, bin };
}

describe.each(["install", "upgrade"] as const)("exported %s execution readiness", (kind) => {
  it.each([{}, { ModelRunPriceVersion: { Value: 1 } }])("qualifies the selected broker before gateway or AWS writes (%j)", async (Outputs) => {
    const h = await bundle(kind);
    await writeFile(join(h.dir, "templates/control-plane.template.json"), JSON.stringify({ Outputs }));
    const result = await h.run("unavailable");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("https://gateway.example");
    expect(result.stderr).toContain("ModelRunPriceVersion=1");
  });

  it.each([
    ["unavailable", 200], ["not-json", 200], [null, 200],
    [{ runPrice: { version: 1, snapshotVersion: 1 } }, 200],
    [{ runPrice: { ...ready, snapshotVersion: 0 } }, 200],
    [{ runPrice: { ...ready, version: "1" } }, 200],
    [{ runPrice: { ...ready, admissionVersion: "1" } }, 200],
    [{ runPrice: { ...ready, snapshotVersion: "1" } }, 200],
    [{ runPrice: { ...ready, snapshotVersion: 1.5 } }, 200],
    [{ runPrice: ready }, 201],
  ])("refuses an unready gateway before AWS writes (%j, %s)", async (body, status) => {
    const h = await bundle(kind);
    const result = await h.run(body, Number(status));
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["gateway https://gateway.example/healthz error"]);
    expect(result.stderr).toContain("https://gateway.example");
    expect(result.stderr).toContain("signed, versioned snapshot");
    expect(result.stderr).not.toContain("private transport details");
  });

  it("refuses with the gateway URL if the execution host cannot run the readiness probe", async () => {
    const h = await bundle(kind);
    await writeFile(join(h.bin, "node"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    const result = await h.run();
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("https://gateway.example");
  });

  it("rechecks a recovered gateway at execution time and permits the first write", async () => {
    const h = await bundle(kind);
    expect((await h.run("unavailable")).status).toBe(1);
    const result = await h.run();
    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe("gateway https://gateway.example/healthz error");
    expect(result.calls[1]).toBe(kind === "install" ? "aws cloudformation create-change-set" : "aws s3 cp");
  });
});

it("guards every exported upgrade write and checks the completed broker before runtime activation", async () => {
  const h = await bundle("upgrade");
  const commands = (await readFile(join(h.dir, "README.md"), "utf8")).split("\n").filter((line) => /aws (s3 cp|cloudformation (create|execute)-change-set)/.test(line));
  expect(commands).toHaveLength(9);
  for (const command of commands) {
    const runtime = command.includes("agentx-staging-runtime") || command.includes("templates/runtime.template.json");
    const result = await h.run("unavailable", 200, command);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(runtime ? ["aws cloudformation describe-stacks"] : ["gateway https://gateway.example/healthz error"]);
    expect(result.stderr).toContain("https://gateway.example");
  }
});
