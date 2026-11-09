import { z } from "zod";

/** A tool name in which `*` stands for any run of characters, such as `delete_*`. At most 4 `*`,
 * so a pattern's segments stay few enough to match in a bounded number of scans. */
export const ToolPatternSchema = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/)
  .refine((pattern) => (pattern.match(/\*/g)?.length ?? 0) <= 4, "a tool pattern may contain at most 4 *");
