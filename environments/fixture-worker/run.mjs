// Container entry for the isolated fixture worker.
//
// It reads a tar of the prepared workspace plus one invocation on stdin, runs the REAL
// runTaskInvocation against a deterministic file-editing session, and writes a tar of
// the events, artifacts and result to stdout.
//
// It has no network. Worker callbacks would normally POST to the control plane; here
// the sinks write to the scratch directory instead and the host admits those bytes
// through its real authenticated routes afterwards. The bytes are still produced by the
// real freezer and the real artifact path — nothing in this file manufactures a
// candidate, a bundle or a terminal result.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname);

const { runTaskInvocation } = await import(join(ROOT, "packages/worker/dist/run-task.js"));
const { createFixtureSessionAdapter } = await import(join(ROOT, "packages/host/dist/fixture-worker.js"));

const SCRATCH = process.env.FIXTURE_SCRATCH ?? "/scratch";
const MODE = process.env.FIXTURE_MODE === "defective" ? "defective" : "correct";

/** Untar a stream into a directory using the image's own tar. */
function untar(directory, stream) {
  return new Promise((resolveUntar, rejectUntar) => {
    const child = spawn("tar", ["-x", "-f", "-", "-C", directory], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectUntar);
    child.once("close", (code) => (code === 0 ? resolveUntar() : rejectUntar(new Error(`tar -x failed: ${stderr}`))));
    stream.pipe(child.stdin);
  });
}

function tarTo(directory, paths, stream) {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn("tar", ["-c", "-f", "-", "-C", directory, ...paths], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectTar);
    child.stdout.pipe(stream, { end: false });
    child.once("close", (code) => (code === 0 ? resolveTar() : rejectTar(new Error(`tar -c failed: ${stderr}`))));
  });
}

async function main() {
  const workspace = join(SCRATCH, "workspace");
  const output = join(SCRATCH, "out");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(output, "artifacts"), { recursive: true });

  await untar(SCRATCH, process.stdin);
  const invocation = JSON.parse(await readFile(join(SCRATCH, "invocation.json"), "utf8"));

  const repositoryPath = join(workspace, "repo/app");
  const edits = JSON.parse(await readFile(join(SCRATCH, "edits.json"), "utf8"));

  const events = [];
  const artifacts = [];
  let index = 0;

  const record = {
    // The worker's own event batches, retained verbatim for the host to admit.
    eventSink: async (batch) => {
      for (const event of batch) events.push(event);
    },
    // The real artifact sink contract: the worker verifies this receipt, so the digest
    // and size here must be the ones it computed over the content it sent.
    artifactSink: async (artifact) => {
      const name = `artifact-${String(index).padStart(4, "0")}.json`;
      index += 1;
      await writeFile(join(output, "artifacts", name), JSON.stringify(artifact));
      const sha256 = createHash("sha256").update(artifact.content).digest("hex");
      const receipt = {
        artifactId: artifact.id ?? name,
        sha256,
        sizeBytes: Buffer.byteLength(artifact.content),
      };
      artifacts.push({ file: name, name: artifact.name, receipt });
      return receipt;
    },
  };

  let result;
  let status = "SUCCEEDED";
  let error;
  try {
    result = await runTaskInvocation(invocation, {
      rootPath: workspace,
      model: { provider: "fixture", modelId: "fixture" },
      piAdapter: createFixtureSessionAdapter({ mode: MODE, edits, repositoryPath }),
      eventSink: record.eventSink,
      artifactSink: record.artifactSink,
    });
  } catch (failure) {
    status = "FAILED";
    error = failure instanceof Error ? failure.message : "task failed";
  }

  await writeFile(
    join(output, "terminal.json"),
    JSON.stringify({
      operationId: invocation.operationId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    }),
  );
  await writeFile(join(output, "events.json"), JSON.stringify(events));
  await writeFile(join(output, "artifacts.json"), JSON.stringify(artifacts));

  await tarTo(output, ["."], process.stdout);
  await new Promise((done) => process.stdout.write("", done));
  process.exit(status === "SUCCEEDED" ? 0 : 1);
}

main().catch((failure) => {
  process.stderr.write(`${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}\n`);
  process.exit(70);
});
