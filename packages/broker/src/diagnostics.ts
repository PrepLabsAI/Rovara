import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeWorkspace } from "./authorization.js";
import type { InMemoryRegistry } from "./registry.js";

export interface BrokerDiagnosticRecord {
  timestamp: string;
  level: "info" | "warning" | "error";
  category: "setup" | "runtime" | "disk" | "authentication" | "interruption";
  correlationId: string;
  workspaceId?: string;
  operationId?: string;
  message: string;
  details?: unknown;
}

export class DiagnosticStore {
  private readonly records = new Map<string, BrokerDiagnosticRecord[]>();

  constructor(private readonly registry: InMemoryRegistry) {}

  async append(workspaceId: string, record: BrokerDiagnosticRecord): Promise<string> {
    const workspace = await this.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    const id = randomUUID();
    const records = this.records.get(workspaceId) ?? [];
    records.push(structuredClone(record));
    this.records.set(workspaceId, records);
    return id;
  }

  async list(identity: AuthenticatedIdentity, workspaceId: string): Promise<BrokerDiagnosticRecord[]> {
    const workspace = await this.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    return structuredClone(this.records.get(workspaceId) ?? []);
  }
}
