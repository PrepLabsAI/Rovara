import { createHash } from "node:crypto";

/**
 * Where an agent step's evidence lives under the executor's out directory (Task 4.3b). These few names are shared by the executor, which writes the files, and by the host's readback,
 * which reads them; they sit apart from the agent modules so that the host side never imports a module that loads the AI SDK.
 *
 * `agent/<case>/agent-actions.json` is the action ledger of one case, `<case>` being 16 hex of the digest of the case id (the case id is free text). `agent/traces/trace-<16 hex>.json`
 * is a kept replay recording, named by a digest of its cache key.
 */
export const E2E_AGENT_EVIDENCE_DIR = "agent" as const;
export const E2E_AGENT_LEDGER_FILE = "agent-actions.json" as const;
export const agentCaseDirectoryName = (caseId: string): string => createHash("sha256").update(caseId, "utf8").digest("hex").slice(0, 16);
