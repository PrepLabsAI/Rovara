// How we work on `rovara up`: the routes the CLI and the MCP tool call, and what the local page reads. The playbook is the file `.rovara/playbook.yaml` in the project's repository (read through the code
// host at the default branch's head); the page and these routes only read it and look at drafts. Changing it is a change to the repository, reviewed like any other: the web editor is Cloud's.
//
// Every GET here only reads: the stored playbook item is brought up to the file when a task starts and when a step is sent, never by a page or a route.
//
// Routes (the owner's session token; a script token never reaches them):
//   GET  /v1/app/projects/{p}/how-we-work     the effective view (`HowWeWorkView`), as Cloud answers it
//   GET  /v1/app/projects/{p}/playbook        the stored playbook (`{ playbook }`)
//   PUT  /v1/app/projects/{p}/playbook        refused in words: Cloud's editor (the server takes GET and POST only, so a POST is refused too)
//   GET  /v1/local/playbook/{p}               the view, the file's state and the stored playbook
//   POST /v1/local/playbook/{p}/check         `{ text }`: what a draft would make, or what is wrong with it; nothing is written
import { AgentXError, HowWeWorkViewSchema, PLAYBOOK_FILE_MAX_BYTES, agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { HowWeWorkPageData } from "../../core/local-pages/views.js";
import type { PlaybookService } from "../../core/playbook/service.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { listProjects } from "./projects.js";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

export const EDIT_THE_FILE = "How we work is a file in the project's repository: edit .rovara/playbook.yaml and open a pull request. The web editor is a Cloud feature.";
const PROJECT = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const APP = new RegExp(`^/v1/app/projects/(${PROJECT})/(how-we-work|playbook)$`, "u");
const LOCAL = new RegExp(`^/v1/local/playbook/(${PROJECT})(?:/(check))?$`, "u");

export interface LocalPlaybookOptions { playbook: PlaybookService; store: DocumentStore; companyId: OrgId }

export interface LocalPlaybook {
  routes(request: BrokerRequest): Promise<BrokerResponse | undefined>;
  /** What the local page reads. */
  page: HowWeWorkPageData;
}

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

export function createLocalPlaybook(options: LocalPlaybookOptions): LocalPlaybook {
  const { playbook } = options;
  const projects = async (): Promise<string[]> => (await listProjects(options.store, options.companyId)).map((project) => project.name).sort();
  return {
    page: {
      projects,
      async state(project) {
        try {
          return await playbook.state(project);
        } catch (error) {
          if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
          throw error;
        }
      },
      preview: (project, draft) => playbook.preview(project, draft),
    },
    async routes(request) {
      const path = request.path.split("?")[0] ?? request.path;
      const app = APP.exec(path);
      const local = LOCAL.exec(path);
      if (app === null && local === null) return undefined;
      try {
        if (app !== null) {
          const project = app[1]!;
          // The local server answers GET and POST only, so the editor's PUT never arrives; a POST is refused in the same words.
          if (app[2] === "playbook" && (request.method === "PUT" || request.method === "POST")) throw agentXError("NOT_AVAILABLE_HERE", EDIT_THE_FILE);
          if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
          const state = await playbook.state(project);
          if (app[2] === "how-we-work") return json(200, HowWeWorkViewSchema.parse(state.view));
          return json(200, { playbook: state.playbook });
        }
        const project = local![1]!;
        if (local![2] === "check") {
          if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
          const text = (bodyOf(request) as { text?: unknown }).text;
          if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > PLAYBOOK_FILE_MAX_BYTES * 2) throw agentXError("CONFIG_INVALID", "text: send the file's text, at most twice the size the file may have");
          return json(200, await playbook.preview(project, text));
        }
        if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
        return json(200, await playbook.state(project));
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
  };
}
