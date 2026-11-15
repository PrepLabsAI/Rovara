import { OrgIdSchema } from "../browser-ids.js";

/** A logger bound to a trusted company. Scope fields cannot be supplied by a caller. */
export function companyLog(companyId: string, sink: (entry: Record<string, unknown>) => void): (entry: Record<string, unknown>) => void {
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("invalid company");
  return (entry) => {
    const fields = Object.fromEntries(Object.entries(entry).filter(([key, value]) => key !== "companyId" && (key !== "orgId" || value === companyId)));
    sink({ companyId, ...fields });
  };
}
