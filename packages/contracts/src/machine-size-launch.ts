// DEC 254zb (TE-C5 part C): what each machine size row launches as on Code's own AWS install (EC2 workers, infra/lib/ec2-workers.ts).
// One pinned type per row, of the row's chip and exact vCPU/memory shape. The provisioner's IAM allows only these types (infra/lib/session-lifecycle.ts),
// so a stored row can never become any other instance. m6g.large is the launch template's own default (production-foundation.ts).
import { MACHINE_SIZE_ROWS, type MachineChip } from "./machine-size.js";

export interface MachineLaunch { readonly instanceType: string; readonly chip: MachineChip }

export const MACHINE_LAUNCH_TYPES: Readonly<Record<string, MachineLaunch>> = Object.freeze({
  "arm64-2-8": Object.freeze({ instanceType: "m6g.large", chip: "arm64" }),
  "arm64-4-16": Object.freeze({ instanceType: "m6g.xlarge", chip: "arm64" }),
  "arm64-8-32": Object.freeze({ instanceType: "m6g.2xlarge", chip: "arm64" }),
  "x86_64-2-8": Object.freeze({ instanceType: "m6i.large", chip: "x86_64" }),
  "x86_64-4-16": Object.freeze({ instanceType: "m6i.xlarge", chip: "x86_64" }),
  "x86_64-8-32": Object.freeze({ instanceType: "m6i.2xlarge", chip: "x86_64" }),
});

/** Every type a worker may launch as: the IAM allow-list of the provisioner's RunInstances. */
export const MACHINE_LAUNCH_INSTANCE_TYPES: readonly string[] = Object.freeze(MACHINE_SIZE_ROWS.map((row) => MACHINE_LAUNCH_TYPES[row.id]!.instanceType));

/** The public Amazon Linux 2023 AMI parameter of each chip. arm64 is the launch template's own (EC2_WORKER_AMI_PARAMETER). */
export const MACHINE_LAUNCH_AMI_PARAMETERS: Readonly<Record<MachineChip, string>> = Object.freeze({
  arm64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
  x86_64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
});

export type MachineLaunchResult =
  | { ok: true; machine: MachineLaunch }
  /** `unknown-size`: not one of the listed rows. `x86-unavailable`: an x86 row on an install whose worker image is arm64 only. */
  | { ok: false; reason: "unknown-size" | "x86-unavailable" };

/** The machine a stored row id launches as. The id is untrusted (a stored value): anything but a listed row is refused, never guessed. */
export function machineLaunchOf(rowId: unknown, install: { x86: boolean }): MachineLaunchResult {
  if (typeof rowId !== "string" || !Object.hasOwn(MACHINE_LAUNCH_TYPES, rowId)) return { ok: false, reason: "unknown-size" };
  const launch = MACHINE_LAUNCH_TYPES[rowId]!;
  if (launch.chip === "x86_64" && !install.x86) return { ok: false, reason: "x86-unavailable" };
  return { ok: true, machine: { instanceType: launch.instanceType, chip: launch.chip } };
}
