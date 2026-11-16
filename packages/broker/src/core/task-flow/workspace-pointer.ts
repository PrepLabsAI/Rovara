/** A broken discovery link is an integrity fault, never a source of workspace authority. No stored fields enter this event. */
export function logWorkspacePointerIntegrity(): void {
  console.warn({ component: "broker", event: "workspace.pointer_integrity" });
}
