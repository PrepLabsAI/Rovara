import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const boot = readFileSync("packages/worker/ec2/boot.sh", "utf8");
const body = (name: string) => boot.slice(boot.indexOf(`\n${name}() {`) + 1).split("\n}\n")[0] + "\n}";

it.each(["empty", "running", "list failure", "stop failure"])("quiesces the dedicated workspace daemon before restore: %s", state => {
  const script = `set -euo pipefail
fail() { echo "refused:$*"; exit 9; }
try_seconds() { echo 60; }
timeout() { shift; "$@"; }
docker() {
  if [[ "$1 $2" == 'ps --quiet' ]]; then
    ${state === "list failure" ? "return 1" : state === "empty" ? ":" : "printf 'container-a\\ncontainer-b\\n'"}
  else
    printf 'stop'; printf '<%s>' "$@"; printf '\\n'
    ${state === "stop failure" ? "return 1" : ":"}
  fi
}
${body("quiesce_workspace_containers")}
quiesce_workspace_containers
echo restored
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const refusal = `quiesces the dedicated workspace daemon before restore: ${state}`;
  expect(result.status, refusal + ": " + result.stderr).toBe(state.endsWith("failure") ? 9 : 0);
  if (state === "running" || state === "stop failure") expect(result.stdout, refusal).toContain("stop<stop><--time><10><container-a><container-b>");
  else expect(result.stdout, refusal).not.toContain("stop<");
  expect(result.stdout.includes("restored"), refusal).toBe(!state.endsWith("failure"));
});

it("restarts the exited restore unit on an in-place boot rerun", () => {
  const prefix = body("main").split('  BOOT_STEP=')[0] + "}\nmain";
  const result = spawnSync("bash", ["-c", `set -euo pipefail
WORKER_UNIT=agentx-worker.service
RESTORE_UNIT=agentx-close-retention-restore.service
systemctl() { if [[ "$1" == is-active ]]; then return 0; else printf '%s\\n' "$*"; fi; }
fail() { exit 9; }
${prefix}`], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n"), "in-place units quiesced").toEqual(["stop agentx-worker.service", "stop agentx-close-retention.service", "stop agentx-close-retention-restore.service", "stop rovara-sandbox-egress.service", "stop rovara-test-services.service"]);
});

it.each([false, true])("emits the container quiescence implementation into the per-boot restore script (overrides: %s)", overrides => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-b1-unit-"));
  try {
    const unit = body("write_worker_unit").replaceAll("/usr/local/libexec", directory).replaceAll("/etc/systemd/system", directory);
    const script = `set -euo pipefail
HOST_RUN=/run/agentx-close-retention-host CLOSE_HELPER_SHA256=fixture
AGENTX_WORKER_IMAGE=fixture AGENTX_WORKSPACE_ID=fixture AGENTX_SESSION_GENERATION=3 AGENTX_VOLUME_ID=fixture
WORKER_UNIT=worker.service RESTORE_UNIT=restore.service FIREWALL_UNIT=firewall.service MOUNT_PATH=/mnt/workspace WORKER_CONTAINER=agentx-worker
${overrides ? "SE_UNIT=gateway.service TS_UNIT=services.service" : "unset SE_UNIT TS_UNIT"}
docker() { :; }
write_worker_launcher() { :; }
${["log", "fail", "try_seconds", "tries", "retry", "registry_login", "pull_image_once", "pull_worker_image", "quiesce_workspace_containers", "initialize_close_retention"].map(body).join("\n")}
${unit}
write_worker_unit fixture fixture
`;
    const generated = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    const gateway = readFileSync("packages/worker/ec2/sandbox-egress.sh", "utf8").match(/SE_UNIT=(rovara-[\w.-]+)/u)![1]!;
    const services = readFileSync("packages/worker/ec2/test-services-stage.sh", "utf8").match(/TS_UNIT=(rovara-[\w.-]+)/u)![1]!;
    expect(readFileSync(join(directory, "restore.service"), "utf8"), "restore precedes gateway and services").toContain(overrides ? "Before=worker.service gateway.service services.service" : `Before=worker.service ${gateway} ${services}`);
    const emitted = readFileSync(join(directory, "agentx-retention-restore"), "utf8").split("RETRY_ATTEMPTS=5")[0]!;
    const result = spawnSync("bash", ["-c", emitted + "\ndocker() { :; }\nquiesce_workspace_containers\necho ready\n"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("ready");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each(["not-found", "active", "failed", "stop failure", "show failure"])("reinstall stops the previous serve unit before starting its replacement: %s", state => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-harness-install-"));
  try {
    writeFileSync(join(directory, "state"), state);
    writeFileSync(join(directory, "helper.sh"), "#!/bin/bash\necho legacy\n");
    const helper = readFileSync("packages/worker/ec2/close-retention.sh", "utf8");
    // Socket readiness has separate coverage; execute the install through systemd-run here.
    const install = (helper.split("  for attempt in")[0]! + "fi\n").replaceAll("/run/agentx-close-retention-host", directory).replaceAll("/run/agentx-close-retention", directory);
    const result = spawnSync("bash", ["-c", `
systemctl() {
  case "$1" in
    show) [[ $(cat "$FIXTURE/state") != 'show failure' ]] || return 8; if [[ $(cat "$FIXTURE/state") == not-found ]]; then echo not-found; else echo loaded; fi;;
    stop) [[ $(cat "$FIXTURE/state") != not-found && $(cat "$FIXTURE/state") != 'stop failure' ]] || return 9; echo not-found > "$FIXTURE/state";;
    *) return 8;;
  esac
}
systemd-run() { [[ $(cat "$FIXTURE/state") == not-found ]] || return 7; echo active > "$FIXTURE/state"; echo STARTED; }
mount() { :; }
mv() { command mv -f "$2" "$3"; }
${install}`, "install-test", "install"], { encoding: "utf8", env: { ...process.env, FIXTURE: directory } });
    expect(result.status, "reinstall stops previous serve unit: " + state + ": " + result.stderr).toBe(state === "stop failure" ? 9 : state === "show failure" ? 8 : 0);
    expect(readFileSync(join(directory, "state"), "utf8").trim(), "reinstall stops previous serve unit").toBe(state.endsWith("failure") ? state : "active");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("clears the pre-run serve unit before the gateway proof starts the worker transaction", async () => {
  const proof = readFileSync("tests/linux/worker-close-retention.test.ts", "utf8");
  const preparation = proof.split("// Artificially slow restore")[1]!.split("\n").slice(1).join("\n").split("readyWorker='close-retention-b1bis-ready'")[0]!;
  let active = false;
  const context = {
    scope: ["workspace", "3", "instance"], image: "image", service: false,
    program: () => "initialize_close_retention instance",
    writeFile: async () => {}, readFile: async () => "ExecStart=/usr/local/libexec/agentx-worker-start\nRestart=always",
    workerArguments: async () => [], resetRuntime: async () => { active = false; },
    cmd: async (...args: string[]) => {
      if (args[0] === "bash") active = true;
      if (args.join(" ") === "systemctl start agentx-worker.service" && active) throw new Error("pre-run serve unit collides with restore install");
    },
  };
  await expect(runInNewContext(`(async () => { ${preparation} })()`, context)).resolves.toBeUndefined();
});

it("quiesces containers before entering the restore extraction boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-b1-order-"));
  try {
    const script = `set -euo pipefail
HOST_RUN=${directory} BOOT_DEADLINE=$((SECONDS+480)) AGENTX_WORKER_IMAGE=fixture
fail() { exit 9; }
try_seconds() { echo 60; }
python3() { :; }
mountpoint() { return 0; }
findmnt() { if [[ "$*" == *FSTYPE* ]]; then echo "tmpfs $HOST_RUN"; else echo nodev,nosuid; fi; }
stat() { echo 0:0:700; }
timeout() { shift; "$@"; }
docker() { case "$1" in ps) echo abc123;; stop) echo STOP >&2;; run) echo EXTRACT >&2; return 1;; esac; }
${["quiesce_workspace_containers", "initialize_close_retention"].map(body).join("\n")}
initialize_close_retention fixture
`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(9);
    expect(result.stderr.trim().split("\n")).toEqual(["STOP", "EXTRACT"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("creates missing host runtime before stat and extraction", () => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-b1bis-create-"));
  try {
    const source = boot.split("<<'HOST'\n")[1]!.split("\nHOST")[0]!.replace("('/run',p)", "(p,)").replace("s.st_uid!=0 or s.st_gid!=0", `s.st_uid!=${process.getuid!()} or s.st_gid!=${process.getgid!()}`);
    const result = spawnSync("python3", ["-", join(directory, "host")], { input: source, encoding: "utf8" });
    expect(result.status, "missing host runtime created: " + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
