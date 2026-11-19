// E2: what an install supplies to run the context-source routes. The broker builds the project-sources store and the usage counters from its own table;
// the pieces that reach other systems (the MCP servers, the Team record, the keeper of results, the citations) come in here, so that a deployment that has
// none of them has no sources: the routes then answer an empty list and refuse every call.
import type { ContextSource, CitationStanding, OrgId } from "@agentx/contracts";
import type { CitationRecorder, ContextServerPort, ContextToolsDependencies, ResultKeeper } from "./routes.js";
import type { TeamRecordSearch, TeamRecordSink } from "./team-record.js";

export interface ContextSourcesRuntime {
  servers: ContextServerPort;
  /** Refuses (by throwing) when the person a task belongs to may no longer use it. Required: an install with one owner passes an explicit no-op. */
  requireAuthority: ContextToolsDependencies["requireAuthority"];
  teamSink?: TeamRecordSink;
  teamSearch?: TeamRecordSearch;
  teamRecordAvailable?: boolean;
  citations?: CitationRecorder;
  results?: ResultKeeper;
  standingOf?: (source: ContextSource, structured: unknown) => CitationStanding;
  callTimeoutMs?: number;
  /**
   * Starts the tasks of the package-run servers a stage is about to read (fire and forget, never throws). Call it when a stage that has package-run sources starts, with those sources'
   * server ids. Absent where the install runs no package-run servers.
   */
  prewarm?: (orgId: OrgId, serverIds: readonly string[]) => Promise<number>;
}
