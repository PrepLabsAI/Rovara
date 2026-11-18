// DEC 254zb (TE-C5 part C): the size a workspace's next worker launches as, read from its project's stored choice (core/test-env/machine-size.ts).
//
// Switch `ROVARA_MACHINE_SIZE_RUN` (exactly "1", and the choice switch `ROVARA_MACHINE_SIZE` on): off, nothing is read and every worker launches as the launch template
// says, exactly as before. `ROVARA_MACHINE_SIZE_X86` (exactly "1") says this install's worker image runs on x86; until a release carries an amd64 image it stays off and an
// x86 choice launches the default size, with the task told why.
//
// Whose choice: the workspace's own record names its company and project (the same strongly consistent read the session lifecycle already trusts); the choice row is read
// under that company's project key and must name the same company and project. Any fault reads as "no choice": a worker always starts, at the default size.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, machineLaunchOf, type DocumentKey, type DocumentStore, type MachineLaunch, type OrgId, type StoredDocument } from "@agentx/contracts";
import { machineSizeRunEnabled, machineSizeX86Enabled, readMachineChoice } from "../../core/test-env/machine-size.js";
import { readWorkspaceMeta } from "./workspace-company.js";

export { MACHINE_SIZE_RUN_VARIABLE, MACHINE_SIZE_X86_VARIABLE, machineSizeRunEnabled } from "../../core/test-env/machine-size.js";

/** What the next launch uses: a chosen machine, or the default size with the fixed reason the task is told (none when nothing was chosen). */
export type MachinePick =
  | { machine: MachineLaunch; fallback?: undefined }
  | { machine?: undefined; fallback?: "x86-unavailable" };

type Reader = Pick<DynamoDBDocumentClient, "send">;

/** Only `get`, strongly consistent: everything readMachineChoice uses. Anything else is refused. */
function getOnlyStore(documentClient: Reader, tableName: string): DocumentStore {
  const refuse = () => { throw new Error("read only"); };
  return new Proxy({}, {
    get(_target, name) {
      if (name === "get") return async (key: DocumentKey): Promise<StoredDocument | undefined> => ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as unknown as { Item?: StoredDocument }).Item;
      if (name === "indexes") return [];
      return refuse;
    },
  }) as DocumentStore;
}

export interface MachinePickDependencies {
  documentClient: Reader;
  tableName: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A fixed event name, never the error's text. */
  log?: (event: "machine_size.pick_failed") => void;
}

/**
 * The size picker the session manager uses before each provisioning, or undefined while the switch is off (the session manager then launches exactly as before).
 * Never throws: a workspace, company, project or choice that cannot be read is "no choice".
 */
export function machineSizePicker(dependencies: MachinePickDependencies): ((workspaceId: string) => Promise<MachinePick>) | undefined {
  const env = dependencies.env ?? process.env;
  if (!machineSizeRunEnabled(env)) return undefined;
  const x86 = machineSizeX86Enabled(env);
  const store = getOnlyStore(dependencies.documentClient, dependencies.tableName);
  const now = dependencies.now ?? Date.now;
  return async (workspaceId) => {
    try {
      const meta = await readWorkspaceMeta(dependencies.documentClient, dependencies.tableName, workspaceId);
      const owner = meta === undefined ? undefined : ownerOf(meta.item);
      if (owner === undefined) return {};
      const rowId = await readMachineChoice({ store, now, env }, owner.companyId, owner.project);
      if (rowId === undefined) return {};
      const launch = machineLaunchOf(rowId, { x86 });
      if (launch.ok) return { machine: launch.machine };
      return launch.reason === "x86-unavailable" ? { fallback: "x86-unavailable" } : {};
    } catch {
      dependencies.log?.("machine_size.pick_failed");
      return {};
    }
  };
}

/** The company and project a workspace record names. Both must be present and well formed; a record whose `orgId` names another company is nobody's. */
function ownerOf(item: Record<string, unknown>): { companyId: OrgId; project: string } | undefined {
  const company = OrgIdSchema.safeParse(item["companyId"]);
  const project = item["projectName"];
  if (!company.success || (item["orgId"] !== undefined && item["orgId"] !== company.data)) return undefined;
  if (typeof project !== "string" || project === "") return undefined;
  return { companyId: company.data, project };
}

/** The SessionManager option for a picker: nothing at all while the switch is off, so the manager is built exactly as before. */
export function optionalPicker(pick: ((workspaceId: string) => Promise<MachinePick>) | undefined): { pickMachine?: (workspaceId: string) => Promise<MachinePick> } {
  return pick === undefined ? {} : { pickMachine: pick };
}
