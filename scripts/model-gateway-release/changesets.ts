// Change sets by name for Code's model gateway deploy step (#1578): preview with --no-execute,
// verify id and template hash, execute by name, wait settled, verify stack ChangeSetId + LastUpdatedTime, tidy/discard.
import { StageError } from "./types.js";
import type { ChangeCounts, ChangeRow, ChangeSetDescription, ChangeSetRecord, Ports } from "./types.js";

const NO_CHANGES = /didn't contain changes|did not contain changes|no updates are to be performed/iu;
const SETTLED = ["UPDATE_COMPLETE", "CREATE_COMPLETE"];
const READY_TO_EXECUTE = [...SETTLED, "REVIEW_IN_PROGRESS"];
const CHANGE_SET_READS = 6;
const CHANGE_SET_POLL_MS = 5_000;
const CLOCK_SKEW_MS = 2 * 60_000;
const VISIBLE_GRACE_SECONDS = 120;
const VISIBLE_POLL_MS = 5_000;

export function countRows(rows: readonly ChangeRow[]): ChangeCounts {
  const counts: ChangeCounts = { add: 0, modify: 0, remove: 0, replace: 0 };
  for (const row of rows) {
    if (row.action === "Add") counts.add += 1;
    else if (row.action === "Modify") counts.modify += 1;
    else if (row.action === "Remove") counts.remove += 1;
    if (row.replacement === "True" || row.replacement === "Conditional") counts.replace += 1;
  }
  return counts;
}

async function readCreatedChangeSet(ports: Ports, stack: string, name: string): Promise<ChangeSetDescription | null> {
  let found = await ports.cfn.describeChangeSet(stack, name);
  for (let read = 1; read < CHANGE_SET_READS && (found === null || found.status === "CREATE_PENDING" || found.status === "CREATE_IN_PROGRESS"); read += 1) {
    await ports.clock.sleep(CHANGE_SET_POLL_MS);
    found = await ports.cfn.describeChangeSet(stack, name);
  }
  return found;
}

export interface PreviewArgs {
  ports: Ports;
  dir: string;
  changeSetName: string;
  stack: string;
  stackId: string;
  context: Record<string, string>;
  parameters: Record<string, string>;
  log: (line: string) => void;
}

export async function previewGatewayChangeSet(args: PreviewArgs): Promise<ChangeSetRecord> {
  try {
    return await previewInner(args);
  } catch (error) {
    await discardChangeSet(args.ports, args.stack, args.changeSetName, args.log);
    throw error;
  }
}

async function previewInner(args: PreviewArgs): Promise<ChangeSetRecord> {
  const { ports, stack, changeSetName } = args;
  await ports.cdk.deployNoExecute({
    dir: args.dir,
    stackId: args.stackId,
    stackName: stack,
    changeSetName,
    context: args.context,
    parameters: args.parameters,
  });
  const found = await readCreatedChangeSet(ports, stack, changeSetName);
  const previewedAt = ports.clock.now().toISOString();
  if (found === null) throw new StageError("CHANGE_SET_MISMATCH", `${stack}: cdk succeeded but change set ${changeSetName} does not exist`);
  if (found.status === "FAILED" && NO_CHANGES.test(found.statusReason ?? "")) {
    args.log(`${stack}: no changes`);
    return {
      part: "gateway", stack, changeSetName, changeSetId: null, noChanges: true,
      status: found.status, executionStatus: found.executionStatus, templateSha256: null,
      rows: [], counts: countRows([]), previewedAt, executedAt: null, finalStatus: null,
    };
  }
  if (found.status !== "CREATE_COMPLETE") {
    throw new StageError("CHANGE_SET_MISMATCH", `${stack}: change set ${changeSetName} is ${found.status} (${found.statusReason ?? "no reason given"})`);
  }
  const templateSha256 = await ports.cfn.templateSha256(stack, changeSetName);
  const counts = countRows(found.rows);
  args.log(`${stack}: change set ${changeSetName} ${found.id.slice(-12)}: +${counts.add} ~${counts.modify} -${counts.remove} replace ${counts.replace}`);
  return {
    part: "gateway", stack, changeSetName, changeSetId: found.id, noChanges: false,
    status: found.status, executionStatus: found.executionStatus, templateSha256,
    rows: found.rows, counts, previewedAt, executedAt: null, finalStatus: null,
  };
}

export async function verifyRecorded(ports: Ports, record: ChangeSetRecord): Promise<string> {
  const live = await ports.cfn.describeChangeSet(record.stack, record.changeSetName);
  if (live === null) {
    const stack = await ports.cfn.describeStack(record.stack);
    if (stack !== null && record.changeSetId !== null && stack.changeSetId === record.changeSetId) {
      return stack.status.endsWith("_IN_PROGRESS") ? "EXECUTE_IN_PROGRESS" : "EXECUTE_COMPLETE";
    }
    throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: change set ${record.changeSetName} cannot be read`);
  }
  if (live.id !== record.changeSetId) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: change set in CloudFormation has a different id`);
  if (live.executionStatus === "EXECUTE_COMPLETE" || live.executionStatus === "EXECUTE_IN_PROGRESS") return live.executionStatus;
  if (live.status !== "CREATE_COMPLETE" || live.executionStatus !== "AVAILABLE") {
    throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: change set is ${live.status}/${live.executionStatus}, not available`);
  }
  const hash = await ports.cfn.templateSha256(record.stack, record.changeSetName);
  if (hash !== record.templateSha256) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: change set template differs from previewed template`);
  return live.executionStatus;
}

export async function verifyExecuted(ports: Ports, record: ChangeSetRecord, settleTimeoutSeconds: number, notBefore: Date): Promise<string> {
  let waitedMs = 0;
  for (;;) {
    const finalStatus = await ports.cfn.waitSettled(record.stack, settleTimeoutSeconds);
    if (!SETTLED.includes(finalStatus)) {
      throw new StageError("DEPLOY_FAILED", `${record.stack} ended as ${finalStatus} (CloudFormation rolled the update back)`);
    }
    const stack = await ports.cfn.describeStack(record.stack);
    if (stack === null) throw new StageError("DEPLOY_FAILED", `${record.stack} cannot be read after execute`);
    if (stack.changeSetId !== record.changeSetId) {
      if (waitedMs < VISIBLE_GRACE_SECONDS * 1000) {
        await ports.clock.sleep(VISIBLE_POLL_MS);
        waitedMs += VISIBLE_POLL_MS;
        continue;
      }
      throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: stack last change set is not the recorded ${record.changeSetName}`);
    }
    if (stack.status !== "CREATE_COMPLETE" && (stack.lastUpdatedTime === null || !(Date.parse(stack.lastUpdatedTime) >= notBefore.getTime() - CLOCK_SKEW_MS))) {
      throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: stack was not updated since execute started (${stack.lastUpdatedTime ?? stack.status})`);
    }
    return finalStatus;
  }
}

export async function executeRecorded(ports: Ports, record: ChangeSetRecord, settleTimeoutSeconds: number, log: (line: string) => void): Promise<ChangeSetRecord> {
  if (record.noChanges) {
    log(`${record.stack}: no changes, nothing to execute`);
    return record;
  }
  const before = await verifyRecorded(ports, record);
  const stack = await ports.cfn.describeStack(record.stack);
  if (before === "AVAILABLE" && (stack === null || !READY_TO_EXECUTE.includes(stack.status))) {
    throw new StageError("REFUSED", `${record.stack} is ${stack?.status ?? "absent"}, not settled: nothing executed`);
  }
  let notBefore = new Date(record.previewedAt);
  if (before === "AVAILABLE") {
    log(`${record.stack}: executing ${record.changeSetName}`);
    notBefore = ports.clock.now();
    await ports.cfn.executeChangeSet(record.stack, record.changeSetName);
  } else {
    log(`${record.stack}: ${record.changeSetName} is already ${before}; waiting for it`);
  }
  const finalStatus = await verifyExecuted(ports, record, settleTimeoutSeconds, notBefore);
  log(`${record.stack}: ${finalStatus}`);
  return { ...record, executedAt: ports.clock.now().toISOString(), finalStatus };
}

export async function tidyChangeSets(ports: Ports, stack: string, thisName: string, log: (line: string) => void): Promise<void> {
  let names: string[];
  try { names = await ports.cfn.listChangeSetNames(stack); } catch { log(`could not list change sets of ${stack}`); return; }
  for (const name of names.filter((n) => n.startsWith("rovara-pipeline-"))) {
    if (name !== thisName) {
      const other = await ports.cfn.describeChangeSet(stack, name);
      if (other === null || other.executionStatus === "AVAILABLE" || other.executionStatus === "EXECUTE_IN_PROGRESS" || other.status === "CREATE_PENDING" || other.status === "CREATE_IN_PROGRESS") {
        continue;
      }
    }
    try { await ports.cfn.deleteChangeSet(stack, name); log(`tidied ${name} on ${stack}`); } catch { log(`could not delete ${name} on ${stack}`); }
  }
}

export async function discardChangeSet(ports: Ports, stack: string, name: string, log: (line: string) => void): Promise<void> {
  try {
    const found = await ports.cfn.describeChangeSet(stack, name);
    if (found === null) return;
    if (found.executionStatus.startsWith("EXECUTE_")) { log(`${stack}: ${name} is ${found.executionStatus}; not deleted`); return; }
    await ports.cfn.deleteChangeSet(stack, name);
    log(`${stack}: deleted unexecuted change set ${name}`);
  } catch {
    log(`${stack}: could not tidy change set ${name}`);
  }
}
