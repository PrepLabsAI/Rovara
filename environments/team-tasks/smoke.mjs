import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { prepareWorkspace } from "/opt/agentx/packages/worker/dist/prepare.js";
import { checkWorkspace } from "./check-workspace.mjs";
const run = promisify(execFile);
const base = "ee25daffed9f59e7c979477c6f0b5a05834c32e3";
const branch = "codex/agentx-demo-baseline";
const wrapper = "/opt/team-tasks/bin/app-env";
const rootPath = "/mnt/workspace/smoke";
const cwd = `${rootPath}/repo/team-tasks`;
assert.notEqual(process.getuid(), 0);
assert.equal(process.version, "v22.23.2");
assert.equal((await run(wrapper, ["node", "--version"])).stdout.trim(), "v24.19.0");
assert.equal((await run(wrapper, ["python3.12", "--version"])).stdout.trim(), "Python 3.12.14");
assert.equal((await run(wrapper, ["uv", "--version"])).stdout.trim(), "uv 0.12.5 (aarch64-unknown-linux-gnu)");
assert.match(process.env.SMOKE_IMAGE ?? "", /^local\/team-tasks@sha256:[a-f0-9]{64}$/);
const project = {
  schemaVersion: 2, name: "team-tasks-image-smoke", revision: 1,
  controlPlaneUrl: "http://127.0.0.1:8787",
  auth: { issuer: "http://127.0.0.1:9000", clientId: "smoke", audience: "smoke" },
  environment: { image: process.env.SMOKE_IMAGE },
  repositories: [{ name: "team-tasks", url: "http://127.0.0.1/fixture.git", path: "repo/team-tasks", defaultBranch: branch, credentialRef: "fixture-only" }],
  setup: [{ cwd: "repo/team-tasks", executable: wrapper, args: ["/opt/team-tasks/bin/prepare-app.sh", base], timeoutSeconds: 900 }],
  readiness: [{ cwd: "repo/team-tasks", executable: wrapper, args: ["make", "baseline"], timeoutSeconds: 900 }],
  orchestratorInstructions: "Synthetic image smoke only. No coding, credentials, publication or independent evidence qualification.",
};
const materializer = async (_repo, destination) => {
  await run("git", ["clone", "--no-checkout", "--branch", branch, "/tmp/baseline.bundle", destination]);
};
await mkdir(rootPath, { recursive: true });
const badRoot = "/mnt/workspace/wrong-base";
await assert.rejects(prepareWorkspace({ rootPath: badRoot, project: { ...project, setup: [{ ...project.setup[0], args: ["/opt/team-tasks/bin/prepare-app.sh", "0".repeat(40)] }] }, materializer }), /BASE_MISMATCH/);
await assert.rejects(access(`${badRoot}/repo/team-tasks/.venv`));
const manifest = await prepareWorkspace({ rootPath, project, materializer });
assert.equal(manifest.complete, true);
assert.equal(manifest.repositories[0].resolvedCommit, base);
assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(), base);
const before = await readFile(`${cwd}/Makefile`, "utf8");
await writeFile(`${cwd}/Makefile`, `${before}\n# smoke retry must preserve this edit\n`);
assert.equal((await prepareWorkspace({ rootPath, project, materializer })).complete, true);
assert.match(await readFile(`${cwd}/Makefile`, "utf8"), /smoke retry must preserve/);
const footprint = await checkWorkspace("/mnt/workspace", 800 * 1024 * 1024);
const worker = spawn(process.execPath, ["/opt/agentx/packages/worker/dist/main.js"], { env: { ...process.env, PORT: "18080" }, stdio: ["ignore", "pipe", "pipe"] });
try {
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    try { healthy = (await fetch("http://127.0.0.1:18080/ping")).ok; } catch { /* startup */ }
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, "worker health endpoint");
} finally { worker.kill("SIGTERM"); }
const receipt = { kind: "local-image-smoke", qualifiedIndependentEvidence: false, architecture: process.arch, uid: process.getuid(), workerNode: process.version, appNode: "v24.19.0", python: "3.12.14", uv: "0.12.5", base, image: process.env.SMOKE_IMAGE, ...footprint, manifest };
await writeFile("/mnt/workspace/smoke-receipt.json", JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
