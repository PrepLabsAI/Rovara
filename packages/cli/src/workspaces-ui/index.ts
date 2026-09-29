// Spec 041: `agentx workspaces`. It reads the developer's projects and the workspaces in them from
// the control plane and shows them, on a page served from 127.0.0.1 or, with --no-ui, as text.
import type { DeveloperWorkspacesResult } from "../developer/workspaces.js";
import { workspaceState, workspacesText } from "../developer/workspaces.js";
import { startWorkspacesUiServer } from "./server.js";
import type { UiData } from "./protocol.js";

export interface TextWriter { write(text: string): unknown }

export interface WorkspacesCommandOptions {
  /** Reads the control plane. Called once for text output, and again for each page refresh. */
  read: () => Promise<DeveloperWorkspacesResult>;
  /** False for --no-ui, --json, or a session with no browser: print the list instead of serving it. */
  ui: boolean;
  json: boolean;
  stdout: TextWriter;
  stderr: TextWriter;
  openBrowser?: (url: string) => Promise<void>;
  /** Resolves when the page should stop being served; the default waits for Ctrl-C. */
  waitForExit?: () => Promise<void>;
  /** For tests; the default asks the system for a free port. */
  port?: number;
}

/** The control plane's answer in the shape the page draws, with each state resolved to its word. */
export function uiData(result: DeveloperWorkspacesResult, readAt: string): UiData {
  return {
    env: result.env,
    url: result.url,
    developer: { name: result.workspaces.developer.name },
    projects: result.workspaces.projects,
    workspaces: result.workspaces.workspaces.map((workspace) => ({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      state: workspaceState(workspace),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })),
    notices: result.workspaces.notices,
    readAt,
  };
}

/** Waits for the operator to stop the command. Ctrl-C ends it the way every other command does. */
function untilInterrupted(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runWorkspacesCommand(options: WorkspacesCommandOptions): Promise<void> {
  if (!options.ui) {
    const result = await options.read();
    options.stdout.write(options.json
      ? `${JSON.stringify({ env: result.env, url: result.url, ...result.workspaces }, undefined, 2)}\n`
      : workspacesText(result));
    return;
  }

  // The first read happens before the browser opens, so a sign-in that has ended, or a control
  // plane that cannot be reached, is reported in the terminal rather than only on the page. The
  // page's own first request is answered from it, rather than reading the control plane twice.
  let seeded: UiData | undefined = uiData(await options.read(), new Date().toISOString());
  const server = await startWorkspacesUiServer({
    read: async () => {
      if (seeded !== undefined) {
        const first = seeded;
        seeded = undefined;
        return first;
      }
      return uiData(await options.read(), new Date().toISOString());
    },
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  try {
    options.stderr.write(`Your AgentX workspaces: ${server.url}\nPress Ctrl-C to stop.\n`);
    if (options.openBrowser !== undefined) {
      // A browser that will not open is not a reason to fail: the address is already printed.
      await options.openBrowser(server.url).catch(() => undefined);
    }
    await (options.waitForExit ?? untilInterrupted)();
  } finally {
    await server.close();
  }
}
