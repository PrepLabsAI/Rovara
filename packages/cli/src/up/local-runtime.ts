// how the CLI and the MCP server reach the `rovara up` running on this computer. `rovara up` writes where it listens (`server.json`, no secret) and the login for its owner routes
// (`session-token`, mode 0600) into its state folder; this reads both, the way `rovara open` does. `--env local` names it: `rovara --env local session start ...`, `rovara --env local mcp`.
import { join } from "node:path";
import { LOCAL_ENVIRONMENT } from "../developer/config.js";
import { agentXError } from "@agentx/contracts";
import { SERVER_FILE_NAME, SESSION_TOKEN_FILE_NAME, defaultStateDirectory, readOwnerFile } from "@agentx/broker/local";

export { LOCAL_ENVIRONMENT };

export const NOT_RUNNING_HERE = "Rovara is not running here. Start it with `rovara up` first.";

export interface LocalRuntimeAddress { url: string; secret: string; stateDirectory: string }

/** Where the running `rovara up` listens and the login for it, or undefined when none is running with this state folder (or its files are not the owner's). */
export async function readLocalRuntime(home: string, stateDirectory?: string): Promise<LocalRuntimeAddress | undefined> {
  const folder = stateDirectory ?? defaultStateDirectory(home);
  const server = await readOwnerFile(join(folder, SERVER_FILE_NAME), { private: false, label: "server file" }).catch(() => undefined);
  const secret = await readOwnerFile(join(folder, SESSION_TOKEN_FILE_NAME), { private: true, label: "session token" }).catch(() => undefined);
  let url: unknown;
  try { url = server === undefined ? undefined : (JSON.parse(server.text) as { url?: unknown }).url; } catch { url = undefined; }
  if (typeof url !== "string" || secret === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return undefined;
  return { url, secret: secret.text.trim(), stateDirectory: folder };
}

/** `readLocalRuntime`, or the error that says to start it. */
export async function requireLocalRuntime(home: string, stateDirectory?: string): Promise<LocalRuntimeAddress> {
  const found = await readLocalRuntime(home, stateDirectory);
  if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_RUNNING_HERE);
  return found;
}
