// DEC 254zb (TE-C5 part C): the machine size rows map to exactly one EC2 type each, and nothing else can be launched from a stored row.
import { describe, expect, it } from "vitest";
import { MACHINE_LAUNCH_TYPES, MACHINE_LAUNCH_INSTANCE_TYPES, MACHINE_LAUNCH_AMI_PARAMETERS, machineLaunchOf } from "../../packages/contracts/src/index.js";
import { AGENTX_PRODUCTION_INSTANCE_TYPE } from "../../infra/lib/production-foundation.js";
import { QUALIFICATION_INSTANCE_TYPE } from "../../packages/contracts/src/qualification-launch.js";

describe("machine size launch table", () => {

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

  it("resolves an x86 row only when the install can run x86", () => {
    expect(machineLaunchOf("x86_64-8-32", { x86: true })).toEqual({ ok: true, machine: { instanceType: "m6i.2xlarge", chip: "x86_64" } });
    expect(machineLaunchOf("x86_64-8-32", { x86: false })).toEqual({ ok: false, reason: "x86-unavailable" });
  });

  it.each([undefined])("refuses %j as an unknown size, never guessing", (value) => {
    expect(machineLaunchOf(value, { x86: true })).toEqual({ ok: false, reason: "unknown-size" });
  });
});
