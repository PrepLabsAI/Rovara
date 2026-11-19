// L4-NETG (DEC 254zzz90): scripts/worker-egress-check.sh, the controller's switch-on check, run against a fake host (fake docker, curl, iptables, systemctl, git) that behaves like a correct gateway-mode worker, and then like
// workers with one hole each. Every hole must turn exactly its check into FAIL and the exit status non-zero; a correct worker passes with no FAIL. The real checks run on a real worker; this proves the script judges them right.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("../../scripts/worker-egress-check.sh", import.meta.url).pathname;
const text = readFileSync(script, "utf8").split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
const GW = "172.28.250.2";

/** `leak` names one hole the fake host has. */
function run(leak = "", extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "egress-check-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "worker.env"), `AWS_REGION=us-west-2\nAGENTX_SECRET_THING=do-not-print\nAGENTX_CONTROL_PLANE_URL=https://cp.example.test\nAGENTX_SANDBOX_EGRESS=gateway\nAGENTX_SANDBOX_NETWORK=rovara-snet\nAGENTX_SANDBOX_DNS=${GW}\n`);
  writeFileSync(join(dir, "worker-image"), "123456789012.dkr.ecr.us-west-2.amazonaws.com/w@sha256:" + "a".repeat(64) + "\n");
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // The fake docker. `run`: the probe is the argument after -e; its own arguments follow. It answers like a correct worker unless `leak` says otherwise.
  fake("docker", `leak=${JSON.stringify(leak)}
case "$1" in
  network) echo "bridge|true|true|false" ;;
  inspect) case "$*" in *Destination*) [[ "$*" == *rovara-egw* ]] && echo ro || echo rw ;; *NetworkMode*) echo "rovara-snet|[${GW}]|[NET_RAW]|rovara-snet " ;; *) echo "true|unless-stopped|true|[ALL]|rovara-snet rovara-xnet " ;; esac ;;
  rm) exit 0 ;;
  create) exit 0 ;;
  run)
    probe=""; args=(); seen=0
    for a in "$@"; do
      if [[ $seen == 1 ]]; then probe=$a; seen=2; continue; fi
      [[ $seen == 2 ]] && args+=("$a")
      [[ $a == -e ]] && seen=1
    done
    case "$*" in *"--entrypoint npm"*) echo "3.0.1"; exit 0 ;; *"--entrypoint sh"*) echo "six-1.16.0-py2.py3-none-any.whl"; exit 0 ;; esac
    case "$probe" in
      *'net.connect'*|*'n.connect'*) host=\${args[0]}
        if [[ "$leak" == raw && $host == 1.1.1.1 ]]; then echo open; elif [[ "$leak" == metadata && $host == 169.254.169.254 ]]; then echo open; else echo ENETUNREACH; fi ;;
      *'dns'*) host=\${args[0]}
        case "$host" in
          ghcr.io) [[ "$leak" == registry ]] && echo 140.82.1.1 || echo ENOTFOUND ;;
          s3.*|*.s3.*) [[ "$leak" == s3 ]] && echo ${GW} || echo ENOTFOUND ;;
          registry.npmjs.org|pypi.org|github.com) [[ "$leak" == noallow ]] && echo ENOTFOUND || echo ${GW} ;;
          *) echo ENOTFOUND ;;
        esac ;;
      *'https'*) host=\${args[0]}
        case "$host" in https://1.1.1.1*) [[ "$leak" == doh ]] && echo "status 200" || echo "error ENETUNREACH" ;; https://registry.npmjs.org*) echo "status 200" ;; *) echo "error ECONNRESET" ;; esac ;;
      *'tls'*) echo "error ECONNRESET" ;;
      *) echo unknown ;;
    esac ;;
  *) exit 1 ;;
esac`);
  fake("wrapper", `if [[ -z "\${AGENTX_SANDBOX_NETWORK:-}" ]]; then exit 125; fi\nleak=${JSON.stringify(leak)}\nif [[ "$leak" == devraw && "$*" == *"1.1.1.1"* ]]; then echo open; exit 0; fi\nexec ${join(bin, "docker")} "$@"`);
  fake("curl", `case "$*" in *127.0.0.1:8080*) echo '{"status":"Healthy","invocationFeatures":[]}' ;; *"-w"*) echo 401 ;; *) echo ok ;; esac`);
  fake("iptables", `[[ "${leak}" == nowall && "$*" == *"INPUT -i rvs+"* ]] && exit 1; exit 0`);
  fake("systemctl", "exit 0");
  fake("timeout", 'shift; exec "$@"');
  fake("git", 'echo "0123456789abcdef0123456789abcdef01234567	HEAD"');
  const ran = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}`, WORKER_EGRESS_ENV_FILE: join(dir, "worker.env"), WORKER_EGRESS_IMAGE_FILE: join(dir, "worker-image"), WORKER_EGRESS_WRAPPER: join(bin, "wrapper"), ...extra } });
  const lines = ran.stdout.split("\n");
  return { status: ran.status, out: ran.stdout, err: ran.stderr, fails: lines.filter((l) => l.startsWith("FAIL")), passes: lines.filter((l) => l.startsWith("PASS")), skips: lines.filter((l) => l.startsWith("SKIP")) };
}

describe("scripts/worker-egress-check.sh", () => {
  it("is valid bash, read-only (no write to a workspace, the firewall or the gateway, no AWS call, no secret read) and prints no secret", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
    expect(text).not.toMatch(/(?:^|[\s;|&(])aws\s|secretsmanager|iptables -[IAD]\b|docker (?:network (?:create|rm|connect)|start|stop|kill)|systemctl (?:start|stop|restart|enable)/u);
    const ok = run();
    expect(ok.out).not.toContain("do-not-print");
    expect(ok.out).not.toContain("AGENTX_SECRET_THING");
  });

  it("a correct gateway-mode worker passes every check, with only the three it cannot make left as SKIP, and exits 0", () => {
    const ok = run();
    expect(ok.fails, ok.out).toEqual([]);
    expect(ok.status).toBe(0);
    expect(ok.out).toMatch(/SUMMARY pass=\d+ fail=0 skip=\d+/u);
    expect(ok.out).toContain("RESULT PASS");
    expect(ok.skips.map((line) => line.split(/\s+/u)[1])).toEqual(["X1", "X2", "X3"]);
    // Every group of the PR's switch-on list is exercised: host, sandbox (raw IP, DoH, registries, S3, allowed, private), dev container.
    for (const id of ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "D1", "D2", "D3", "D4", "D5"]) expect(ok.passes.some((line) => line.split(/\s+/u)[1] === id), id).toBe(true);
    expect(ok.passes.length).toBeGreaterThan(40);
  });

  it.each([
    ["raw", "S1"], ["doh", "S2"], ["registry", "S3"], ["s3", "S6"], ["noallow", "S7"], ["metadata", "S9"], ["devraw", "D2"], ["nowall", "H4"],
  ])("a worker with the hole `%s` FAILS its check %s and the whole run (exit 1)", (leak, id) => {
    const bad = run(leak);
    expect(bad.fails.some((line) => line.split(/\s+/u)[1] === id), bad.out).toBe(true);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("RESULT FAIL");
  });

  it("a host that is not in gateway mode fails at once (H1) and the run fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-check-off-"));
    writeFileSync(join(dir, "worker.env"), "AWS_REGION=us-west-2\n");
    writeFileSync(join(dir, "worker-image"), "x@sha256:" + "a".repeat(64) + "\n");
    const ran = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", WORKER_EGRESS_ENV_FILE: join(dir, "worker.env"), WORKER_EGRESS_IMAGE_FILE: join(dir, "worker-image"), WORKER_EGRESS_WRAPPER: "/nonexistent", WORKER_EGRESS_CHECK_QUICK: "1" } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/FAIL\s+H1/u);
  });
});
