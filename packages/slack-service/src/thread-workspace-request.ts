/**
 * The body this service sends to POST /v1/threads/workspace. Each include flag opts in to fields the
 * broker withholds from older services, whose strict parse would reject them. `lazyPreparation` opts
 * in to status `UNPREPARED` and the prepare route (spec 014). `includeSharedTask` opts in to `VIEW_ONLY`
 * and `sharedTask` (spec 025). `includeOpenTaskCount` opts in to the member's open AI-tool task count
 * on a LIMIT_REACHED answer (spec 025 C16).
 */
export function threadWorkspaceRequest(requestId: string) {
  return {
    requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
    includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,
    includeSharedTask: true, includeOpenTaskCount: true,
  } as const;
}
