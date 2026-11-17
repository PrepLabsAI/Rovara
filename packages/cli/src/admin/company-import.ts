// DEC 254b (b): an install administrator's preview of copying the install's old company layout into Code's company records (or of its undo).
// The preview reads only. People are named by their opaque id, never an email.
import { CompanyImportPreviewSchema, OrgIdSchema, agentXError, type CompanyImportPreview } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

export function companyImportId(value: string): string {
  if (!OrgIdSchema.safeParse(value).success) throw agentXError("CONFIG_INVALID", "--from-install: give the install's company id, org_ and 20 lowercase letters or digits");
  return value;
}

export async function previewCompanyImport(session: { controlPlaneUrl: string; accessToken: string }, companyId: string, mode: "import" | "undo", fetchImplementation: typeof fetch = fetch): Promise<CompanyImportPreview> {
  const query = new URLSearchParams({ companyId, mode });
  let response: Response;
  try {
    response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/company-import?${query.toString()}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "could not reach AgentX to preview the company import; nothing was written, try again");
  }
  const body = await adminResponseBody(response);
  const { requestId: _requestId, ...rest } = (body ?? {}) as Record<string, unknown>;
  void _requestId;
  const preview = CompanyImportPreviewSchema.safeParse(rest);
  if (!preview.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with a preview this version of the CLI cannot read; upgrade the CLI");
  return preview.data;
}

const REFUSAL: Record<NonNullable<CompanyImportPreview["refusal"]>, string> = {
  no_open_company: "the install has no open company with that id",
  too_many_members: "it has more members than one import copies",
  no_owner: "nobody would be its owner afterwards",
  unreadable: "a record it needs does not read",
  built_in_company: "the built-in company is never imported",
};

/** The preview as lines: what would be written (or removed), what is left as it is and why, and what refuses the run. */
export function describeCompanyImport(preview: CompanyImportPreview): string {
  const undo = preview.mode === "undo";
  const lines = [`${undo ? "Undo of the import of" : "Import of"} company ${preview.companyId}: preview only, nothing was written.`];
  if (preview.refusal !== undefined) lines.push(`Refused: ${REFUSAL[preview.refusal]}.`);
  lines.push(undo
    ? `Company record: ${preview.company === "delete" ? "would be deleted (the import made it, and no member is left)" : "kept"}.`
    : `Company record: ${preview.company === "write" ? "would be written" : "already in Code's records, kept"}.`);
  lines.push(`${undo ? "Would remove" : "Would write"} ${preview.members.length} ${undo ? "imported memberships" : "memberships (with the member mirror)"}:`);
  for (const member of preview.members) lines.push(`  ${member.personId}  ${member.role}`);
  if (preview.skipped.length > 0) {
    lines.push(`Left as they are (${preview.skipped.length}):`);
    for (const entry of preview.skipped) lines.push(`  ${entry.personId}  ${entry.reason.replaceAll("_", " ")}${entry.survivorId === undefined ? "" : ` into ${entry.survivorId}`}`);
  }
  if (preview.refused.length > 0) {
    lines.push(`Refuse the whole run (${preview.refused.length}):`);
    for (const entry of preview.refused) lines.push(`  ${entry.personId}  ${entry.reason.replaceAll("_", " ")}`);
  }
  lines.push(preview.ready ? `Add --apply to ${undo ? "undo it" : "import it"}; it shows the change and asks first.` : "Nothing can be applied until that is fixed.");
  return `${lines.join("\n")}\n`;
}
