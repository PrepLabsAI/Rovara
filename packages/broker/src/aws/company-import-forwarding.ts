// DEC 254b (b): the broker's only way to the sign-in Lambda's company import and undo (developer/company-import.ts). Called only by an install
// administrator's applied admin change (admin-change-plans.ts), with the rows that change's plan read. The broker never writes the sign-in table.
import { agentXError } from "@agentx/contracts";
import type { ChannelMembersInvokeResult } from "./developer-routes.js";
import { CompanyImportEvent, CompanyImportReply, type CompanyImportEventInput } from "../developer/company-import.js";
import type { ImportPlan, UndoPlan } from "./install-company-import.js";

export interface CompanyImportRegistry {
  /** Writes the plan's rows; answers how many people's rows were written and whether the company record was. */
  importCompany(write: ImportPlan["write"], createdBy: string): Promise<{ rows: number; company: boolean }>;
  /** Deletes the plan's rows; answers how many people's rows were deleted and whether the company record was. */
  undoImport(remove: UndoPlan["remove"], createdBy: string): Promise<{ rows: number; company: boolean }>;
}

const UNREACHABLE = "AgentX could not reach its sign-in service, so the company import may have stopped part way; preview again to see what is there";
const conflict = (rows: number) => `a row changed while this ran, so it stopped after ${rows} people; nothing was overwritten. Preview again to see what is there (an undo removes what an import wrote)`;

export function companyImportThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): CompanyImportRegistry {
  const ask = async (request: CompanyImportEventInput): Promise<{ rows: number; company: boolean }> => {
    const parsed = CompanyImportEvent.safeParse(request);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "that company import is not one AgentX can make");
    let answer: ChannelMembersInvokeResult;
    try { answer = await invoke(Buffer.from(JSON.stringify(parsed.data))); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE); }
    if (answer.FunctionError !== undefined || answer.Payload === undefined || answer.Payload.byteLength > 65_536) throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE);
    let reply;
    try { reply = CompanyImportReply.safeParse(JSON.parse(Buffer.from(answer.Payload).toString("utf8"))); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE); }
    if (!reply.success) throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE);
    if (reply.data.ok) return { rows: reply.data.rows, company: reply.data.company };
    // Nothing written: stale. Part written: not "stale" (which reads as nothing applied), but unavailable, naming how far it got.
    if (reply.data.error === "conflict") throw agentXError(reply.data.rows === 0 ? "CHANGE_STALE" : "RUNTIME_UNAVAILABLE", conflict(reply.data.rows));
    throw agentXError("RUNTIME_UNAVAILABLE", UNREACHABLE);
  };
  return {
    importCompany: (write, createdBy) => ask({ kind: "company-import", ...write, createdBy }),
    undoImport: (remove, createdBy) => ask({ kind: "company-import-undo", ...remove, createdBy }),
  };
}
