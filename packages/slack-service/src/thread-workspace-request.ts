/**
 * The body this service sends to POST /v1/threads/workspace. Each include flag opts in to fields the
 * broker withholds from older services, whose strict parse would reject them. `lazyPreparation` opts
 * in to status `UNPREPARED` and the prepare route (spec 014).
 */
export function threadWorkspaceRequest(requestId: string) {
  return {
    requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
    includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,
  } as const;
}
