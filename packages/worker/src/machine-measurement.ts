import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { machineMeasurementRequest, validPeakMemory, type MachineChip } from "@agentx/contracts";
import { proveEnvironment, type ProveInput, type ProvePorts } from "./prove.js";

/** Read the sandbox's cgroup v2 peak, never the worker host's. A fresh sandbox cgroup bounds this measurement's lifetime.
 * The setup executor supplies the trusted cgroup directory. Symlinks, missing files and malformed readings are unknown.
 * A fixed-size read also handles cgroup pseudo-files whose stat size is zero. */
export async function readCgroupPeakMemoryMiB(cgroupDirectory: string): Promise<number | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const directory = resolve(cgroupDirectory);
    if (await realpath(directory) !== directory) return undefined;
    file = await open(join(directory, "memory.peak"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return undefined;
    const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^\d{1,16}$/u.test(text)) return undefined;
    const bytes = Number(text), mib = bytes / 1048576;
    return Number.isSafeInteger(bytes) && validPeakMemory(mib) ? mib : undefined;
  } catch { return undefined; }
  finally { await file?.close().catch(() => undefined); }
}

/** Single setup integration point, intentionally not called by production yet. Call while the fresh sandbox cgroup exists;
 * Prove samples after the full suite and before ports.release. Gate AND worker advertisement are required. */
export function proveWithMachineMeasurement(ports: ProvePorts, input: Omit<ProveInput, "measureMachine" | "machineChip">, measurement: { machineSize: boolean; workerFeatures: readonly string[]; machineChip: MachineChip; cgroupDirectory: string }) {
  return proveEnvironment({ ...ports, peakMemory: () => readCgroupPeakMemoryMiB(measurement.cgroupDirectory) }, {
    ...input, ...machineMeasurementRequest(measurement.machineSize, measurement.workerFeatures), machineChip: measurement.machineChip,
  });
}
