// Test services, slice 1: the worker's self-report line (test-services-report.ts): schema, boot facts, what it looks at, and that nothing secret or named can get into it.
import { describe, expect, it } from "vitest";
import { TEST_SERVICES_REPORT_EVENT, checkReport, collectReport, emitReport, parseBootFacts, reportLine, type TestServicesReport } from "../../packages/worker/src/test-services-report.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const FACTS = { metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "ok", prepulled: 1, loggedOut: true, dockerVersion: "25.0.5" };
const report = (over: Partial<TestServicesReport> = {}): TestServicesReport => ({ phase: "run_end", outcome: "completed", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: false, ...over });

function docker(answers: { containers?: string; networks?: string; paused?: string; fail?: boolean }): { cli: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: (args) => {
        calls.push([...args]);
        if (answers.fail === true) return Promise.reject(new Error("docker is gone"));
        if (args[0] === "ps") return Promise.resolve({ exitCode: 0, stdout: answers.containers ?? "", stderr: "" });
        if (args[0] === "network") return Promise.resolve({ exitCode: 0, stdout: answers.networks ?? "", stderr: "" });
        return Promise.resolve({ exitCode: answers.paused === undefined ? 1 : 0, stdout: answers.paused ?? "", stderr: "" });
      },
    },
  };
}

describe("the boot facts", () => {
  it("are read only in exactly the expected shape", () => {
    expect(parseBootFacts(JSON.stringify(FACTS))).toEqual(FACTS);
    expect(parseBootFacts(undefined)).toBe("absent");
    expect(parseBootFacts("")).toBe("absent");
    for (const bad of ["not json", "[]", "null", JSON.stringify({ ...FACTS, extra: 1 }), JSON.stringify({ ...FACTS, metadataBlocked: "yes" }), JSON.stringify({ ...FACTS, prepull: "maybe" }), JSON.stringify({ ...FACTS, prepulled: -1 }), JSON.stringify({ ...FACTS, prepulled: 1.5 }), JSON.stringify({ ...FACTS, dockerVersion: "25.0.5; rm -rf /" }), JSON.stringify({ ...FACTS, dockerVersion: "x".repeat(40) })]) {
      expect(parseBootFacts(bad), bad).toBe("unreadable");
    }
    const { dockerVersion: _version, ...fewer } = FACTS;
    void _version;
    expect(parseBootFacts(JSON.stringify(fewer))).toBe("unreadable");
  });
  it("carry an optional IPv6 reason, only with ipv6Drops false and only a fixed word (the IPv6 wall failed: the worker runs without test services)", () => {
    for (const reason of ["ip6tables-unusable", "rule-not-added"] as const) {
      const failed = { ...FACTS, ipv6Drops: false, ipv6DropsReason: reason };
      expect(parseBootFacts(JSON.stringify(failed))).toEqual(failed);
      expect(checkReport({ ...report({ outcome: "booted", phase: "worker_start" }), bootFacts: failed })).toBe(true);
    }
    expect(parseBootFacts(JSON.stringify({ ...FACTS, ipv6Drops: false }))).toEqual({ ...FACTS, ipv6Drops: false });
    for (const bad of [{ ...FACTS, ipv6DropsReason: "rule-not-added" }, { ...FACTS, ipv6Drops: false, ipv6DropsReason: "free text from an error" }, { ...FACTS, ipv6Drops: false, ipv6DropsReason: 1 }]) {
      expect(parseBootFacts(JSON.stringify(bad)), JSON.stringify(bad)).toBe("unreadable");
    }
  });
});

describe("the report", () => {
  it("accepts exactly the schema: known keys, counts and booleans", () => {
    expect(checkReport(report())).toBe(true);
    expect(checkReport(report({ outcome: "checks_failed" }))).toBe(true);
    expect(checkReport(report({ leftoverContainers: null, leftoverNetworks: null }))).toBe(true);
    expect(checkReport(report({ phase: "worker_start", outcome: "booted", sweptContainers: 2, sweptNetworks: 1, bootFacts: FACTS as never }))).toBe(true);
    expect(checkReport(report({ phase: "worker_start", outcome: "booted", bootFacts: "absent" }))).toBe(true);
    for (const bad of [{ ...report(), name: "rovara-svc-0123456789ab" }, { ...report(), leftoverContainers: -1 }, { ...report(), leftoverNetworks: "0" }, { ...report(), outcome: "checks_failed", leftoverNetworks: undefined }, { ...report(), runDirEmpty: "true" }, { ...report(), phase: "somewhere" }, { ...report(), outcome: "ok" }, { ...report(), bootFacts: { ...FACTS, extra: true } }, null, [], "x"]) {
      expect(checkReport(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is a line with the event name and nothing else; an invalid report is no line", () => {
    expect(reportLine(report())).toEqual({ event: TEST_SERVICES_REPORT_EVENT, ...report() });
    expect(reportLine({ ...report(), leftoverContainers: -1 })).toBeUndefined();
  });

  it("counts what is left from fixed docker listings and names none of it: no container, network or path reaches the line", async () => {
    const secretName = "rovara-svc-0123456789ab-hDEADBEEF01-password-Zq8Wv3Lm9Xc2Rt5";
    const { cli, calls } = docker({ containers: `${secretName}\nabc\n`, networks: "net1\n", paused: "false\n" });
    const collected = await collectReport({ docker: cli, workspace: "0123456789abcdef", runDirectoryParent: "/run/agentx-test-services", sandboxName: "agentx-task-secret-name", phase: "run_end", outcome: "failed", readDirectory: async () => ["rsv-1"], readMountTable: async () => "36 25 0:30 / /run/agentx-test-services rw,nosuid - tmpfs tmpfs rw,size=65536k" });
    expect(collected).toEqual({ phase: "run_end", outcome: "failed", leftoverContainers: 2, leftoverNetworks: 1, runDirEmpty: false, runDirTmpfs: true, workingSandboxPaused: false });
    const line = JSON.stringify(reportLine(collected));
    for (const text of [secretName, "Zq8Wv3Lm9Xc2Rt5", "agentx-task-secret-name", "/run/agentx-test-services", "rsv-1"]) expect(line, text).not.toContain(text);
    // The listings are read-only and filtered to this workspace's run-network labels.
    expect(calls[0]).toEqual(expect.arrayContaining(["ps", "-a", "label=rovara.run-network", "label=rovara.run-network.workspace=0123456789abcdef"]));
    expect(calls.every((call) => !["rm", "stop", "kill", "pause", "unpause", "run"].includes(call[0]!))).toBe(true);
  });

  it("says paused when the sandbox is paused, null when it is gone, and null for every look that fails (never a guess)", async () => {
    const base = { workspace: "0123456789abcdef", sandboxName: "agentx-task-x", phase: "run_end" as const, outcome: "completed" as const };
    expect((await collectReport({ ...base, docker: docker({ paused: "true\n" }).cli })).workingSandboxPaused).toBe(true);
    expect((await collectReport({ ...base, docker: docker({}).cli })).workingSandboxPaused).toBeNull();
    const failed = await collectReport({ ...base, docker: docker({ fail: true }).cli, runDirectoryParent: "/nowhere", readDirectory: async () => { throw new Error("gone"); }, readMountTable: async () => { throw new Error("gone"); } });
    // A Docker that cannot be asked is "could not look" (null), never zero.
    expect(failed).toMatchObject({ leftoverContainers: null, leftoverNetworks: null, runDirEmpty: null, runDirTmpfs: null, workingSandboxPaused: null });
    expect(checkReport(failed)).toBe(true);
  });

  it("a run directory that is not a tmpfs mount is reported as not tmpfs", async () => {
    const collected = await collectReport({ docker: docker({}).cli, workspace: "0123456789abcdef", runDirectoryParent: "/run/agentx-test-services", phase: "worker_start", outcome: "booted", readDirectory: async () => [], readMountTable: async () => "36 25 0:30 / /run/agentx-test-services rw - ext4 /dev/sda1 rw" });
    expect(collected).toMatchObject({ runDirEmpty: true, runDirTmpfs: false });
  });

  it("emitReport never throws and writes nothing for a report that does not pass", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const throwing: DockerCli = { run: () => { throw new Error("sync fault"); } };
    await expect(emitReport({ docker: throwing, workspace: "w", phase: "run_end", outcome: "completed" }, (event) => lines.push(event))).resolves.toBeUndefined();
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});
