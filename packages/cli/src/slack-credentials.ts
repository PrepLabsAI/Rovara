import type { SecretStore } from "./secret-store.js";

// The retired local Slack mode stored Socket Mode tokens here; logout still removes them.
export async function deleteSlackCredentials(store: SecretStore, projectName: string): Promise<void> {
  await store.delete(`slack:${projectName}`);
}
