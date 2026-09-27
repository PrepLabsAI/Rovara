// Minimal AgentCore-compatible server for the issue #55 probe.
// /ping must answer Healthy or the runtime never becomes invocable.
// /invocations runs the fast phase inline and the slow phase in the background, so neither
// InvokeAgentRuntime nor the probe's own image pulls can trip a request timeout.
// .mjs because this file is copied to a directory with no package.json declaring module type.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, openSync, readFileSync } from "node:fs";

const PROBE_ROOT = process.env.PROBE_ROOT ?? "/mnt/workspace/.probe";
const LOG_PATH = `${PROBE_ROOT}/full.log`;
const PROBE = process.env.PROBE_SCRIPT ?? "/usr/local/bin/probe.sh";
const PORT = Number(process.env.PORT ?? 8080);

let runner;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}

function runPhase(phase) {
  return new Promise((resolve) => {
    const child = spawn(PROBE, [phase], { env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ exitCode: code, output }));
    child.on("error", (error) => resolve({ exitCode: -1, output: `${output}\nspawn failed: ${error.message}` }));
  });
}

function startFullPhase() {
  mkdirSync(PROBE_ROOT, { recursive: true });
  // Appending keeps the record if the phase is started more than once.
  const log = openSync(LOG_PATH, "a");
  runner = spawn(PROBE, ["full"], { env: process.env, stdio: ["ignore", log, log], detached: true });
  runner.unref();
  return runner.pid;
}

createServer((incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/ping") {
    return json(outgoing, 200, { status: "Healthy" });
  }
  if (incoming.method !== "POST" || !incoming.url?.startsWith("/invocations")) {
    return json(outgoing, 404, { error: "not found" });
  }
  let body = "";
  incoming.on("data", (chunk) => { body += chunk; });
  incoming.on("end", async () => {
    let phase = "caps";
    if (body.trim()) {
      try {
        phase = JSON.parse(body).phase ?? "caps";
      } catch {
        return json(outgoing, 400, { error: "payload must be JSON" });
      }
    }
    if (phase === "caps") {
      return json(outgoing, 200, { phase, ...(await runPhase("caps")) });
    }
    if (phase === "start") {
      return json(outgoing, 200, { phase, started: true, pid: startFullPhase(), log: LOG_PATH });
    }
    if (phase === "results") {
      let log;
      try {
        log = readFileSync(LOG_PATH, "utf8");
      } catch {
        return json(outgoing, 200, { phase, running: false, log: "", note: 'no log yet; POST {"phase":"start"} first' });
      }
      return json(outgoing, 200, {
        phase,
        running: runner !== undefined && runner.exitCode === null,
        complete: log.includes("phase=full complete"),
        log,
      });
    }
    return json(outgoing, 400, { error: `unknown phase: ${phase}` });
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`probe listening on ${PORT}`);
});
