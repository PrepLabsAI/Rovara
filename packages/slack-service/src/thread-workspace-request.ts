/**
 * The body this service sends to POST /v1/threads/workspace. Each include flag opts in to fields the
 * broker withholds from older services, whose strict parse would reject them.
 */
export function threadWorkspaceRequest(requestId: string) {
  return {
    requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
    includeAllConnectorTypes: true, includeRecoverableOperations: true,
  } as const;
}
