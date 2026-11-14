import { z } from "zod";

export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "defaultBranch contains unsupported characters")
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value === "@" ||
      value.endsWith(".") ||
      value.endsWith("/") ||
      value.includes("..") ||
      value.includes("//") ||
      value.includes("@{") ||
      segments.some(
        (segment) => segment.startsWith(".") || segment === ".." || segment.endsWith(".lock"),
      )
    ) {
      context.addIssue({ code: "custom", message: "defaultBranch is not a safe Git branch name" });
    }
  });
