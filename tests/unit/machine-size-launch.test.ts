// DEC 254zb (TE-C5 part C): the machine size rows map to exactly one EC2 type each, and nothing else can be launched from a stored row.
import { describe, expect, it } from "vitest";
import {
  MACHINE_SIZE_ROWS,
  MACHINE_LAUNCH_TYPES,
  MACHINE_LAUNCH_INSTANCE_TYPES,
  MACHINE_LAUNCH_AMI_PARAMETERS,
  machineLaunchOf,
} from "../../packages/contracts/src/index.js";
import { AGENTX_PRODUCTION_INSTANCE_TYPE } from "../../infra/lib/production-foundation.js";
import { QUALIFICATION_INSTANCE_TYPE } from "../../packages/contracts/src/qualification-launch.js";

describe("machine size launch table", () => {
  it("maps every listed row, and only those, to one instance type of the row's chip and shape", () => {
    expect(Object.keys(MACHINE_LAUNCH_TYPES).sort()).toEqual(MACHINE_SIZE_ROWS.map((row) => row.id).sort());
    expect(MACHINE_LAUNCH_TYPES).toEqual({
      "arm64-2-8": { instanceType: "m6g.large", chip: "arm64" },
      "arm64-4-16": { instanceType: "m6g.xlarge", chip: "arm64" },
      "arm64-8-32": { instanceType: "m6g.2xlarge", chip: "arm64" },
      "arm64-16-64": { instanceType: "m6g.4xlarge", chip: "arm64" },
      "arm64-32-128": { instanceType: "m6g.8xlarge", chip: "arm64" },
      "x86_64-2-8": { instanceType: "m6i.large", chip: "x86_64" },
      "x86_64-4-16": { instanceType: "m6i.xlarge", chip: "x86_64" },
      "x86_64-8-32": { instanceType: "m6i.2xlarge", chip: "x86_64" },
      "x86_64-16-64": { instanceType: "m6i.4xlarge", chip: "x86_64" },
      "x86_64-32-128": { instanceType: "m6i.8xlarge", chip: "x86_64" },
    });
    for (const row of MACHINE_SIZE_ROWS) expect(MACHINE_LAUNCH_TYPES[row.id]!.chip).toBe(row.chip);
  });

  it("lists the allowed instance types once each, including today's default m6g.large", () => {
    expect([...MACHINE_LAUNCH_INSTANCE_TYPES].sort()).toEqual(["m6g.2xlarge", "m6g.4xlarge", "m6g.8xlarge", "m6g.large", "m6g.xlarge", "m6i.2xlarge", "m6i.4xlarge", "m6i.8xlarge", "m6i.large", "m6i.xlarge"]);
    expect(MACHINE_LAUNCH_INSTANCE_TYPES).toHaveLength(10);
    expect(new Set(MACHINE_LAUNCH_INSTANCE_TYPES).size).toBe(MACHINE_LAUNCH_INSTANCE_TYPES.length);
  });

  // Review A1 L2: the provisioner's IAM allows only these types, so the launch template's own default must be one of them, or every default launch is refused.
  it("includes the launch template's default type and the qualification type, as the 2 vCPU / 8 GiB arm64 row", () => {
    expect(MACHINE_LAUNCH_INSTANCE_TYPES).toContain(AGENTX_PRODUCTION_INSTANCE_TYPE);
    expect(MACHINE_LAUNCH_TYPES["arm64-2-8"]!.instanceType).toBe(AGENTX_PRODUCTION_INSTANCE_TYPE);
    expect(QUALIFICATION_INSTANCE_TYPE).toBe(AGENTX_PRODUCTION_INSTANCE_TYPE);
  });

  it("names the public Amazon Linux 2023 parameter of each chip", () => {
    expect(MACHINE_LAUNCH_AMI_PARAMETERS).toEqual({
      arm64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
      x86_64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
    });
  });

  it("resolves an arm64 row to its type", () => {
    expect(machineLaunchOf("arm64-4-16", { x86: false })).toEqual({ ok: true, machine: { instanceType: "m6g.xlarge", chip: "arm64" } });
  });

  it("resolves an x86 row only when the install can run x86", () => {
    expect(machineLaunchOf("x86_64-8-32", { x86: true })).toEqual({ ok: true, machine: { instanceType: "m6i.2xlarge", chip: "x86_64" } });
    expect(machineLaunchOf("x86_64-8-32", { x86: false })).toEqual({ ok: false, reason: "x86-unavailable" });
  });

  it("resolves the 16 vCPU / 64 GB and 32 vCPU / 128 GB rows of both chips, x86 only when the install can run x86", () => {
    expect(machineLaunchOf("arm64-16-64", { x86: false })).toEqual({ ok: true, machine: { instanceType: "m6g.4xlarge", chip: "arm64" } });
    expect(machineLaunchOf("arm64-32-128", { x86: false })).toEqual({ ok: true, machine: { instanceType: "m6g.8xlarge", chip: "arm64" } });
    expect(machineLaunchOf("x86_64-16-64", { x86: true })).toEqual({ ok: true, machine: { instanceType: "m6i.4xlarge", chip: "x86_64" } });
    expect(machineLaunchOf("x86_64-32-128", { x86: true })).toEqual({ ok: true, machine: { instanceType: "m6i.8xlarge", chip: "x86_64" } });
    expect(machineLaunchOf("x86_64-32-128", { x86: false })).toEqual({ ok: false, reason: "x86-unavailable" });
  });

  it("returns a fresh object, so a caller cannot change the table", () => {
    const first = machineLaunchOf("arm64-2-8", { x86: false });
    if (!first.ok) throw new Error("expected a machine");
    (first.machine as { instanceType: string }).instanceType = "p5.48xlarge";
    expect(machineLaunchOf("arm64-2-8", { x86: false })).toEqual({ ok: true, machine: { instanceType: "m6g.large", chip: "arm64" } });
  });

  it.each([undefined, null, "", "arm64-2-8 ", "ARM64-2-8", "m6g.large", "p5.48xlarge", "m6g.4xlarge", "arm64-64-256", "x86_64-64-256", "arm64-12-48", "m6g.12xlarge", "toString", "__proto__", "constructor", 42, {}, ["arm64-2-8"]])("refuses %j as an unknown size, never guessing", (value) => {
    expect(machineLaunchOf(value, { x86: true })).toEqual({ ok: false, reason: "unknown-size" });
  });
});
