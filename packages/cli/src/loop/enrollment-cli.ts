import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { ProjectDefinitionSchema, type ProjectDefinition } from "@agentx/contracts";
import { developerAccessToken } from "../developer/session.js";
import { GitHub } from "./github.js";
import { createRegisteredEnrollment, createRegisteredPendingEnrollment, PublicationJoinRequestSchema, type PublicationJoinTransport } from "./enrollment.js";
import { realExec, type Exec } from "./exec.js";
import { LoopStore } from "./state.js";
import type { TokenStore } from "../token-store.js";

/** The publication join uses the existing developer sign-in and its control-plane access token. */
export function createDeveloperPublicationJoinTransport(input: { home: string; env: string | (() => string); tokenStore: TokenStore; fetch: typeof fetch }): PublicationJoinTransport {
  const sessionFor = async (projectName: string, expectedAuthorityNamespace: string) => {
    const env = typeof input.env === "function" ? input.env() : input.env;
    const session = await developerAccessToken({ home: input.home, tokenStore: input.tokenStore, fetch: input.fetch }, env);
    const baseUrl = new URL(session.entry.url).href.replace(/\/$/u, "");
    const actualAuthorityNamespace = `${baseUrl}/env/${session.env}/project/${projectName}`;
    if (expectedAuthorityNamespace !== actualAuthorityNamespace) throw new Error("registered_authority_namespace_mismatch");
    return { session, baseUrl };
  };
  return {
    async load(request, expectedAuthorityNamespace) {
      const parsed = PublicationJoinRequestSchema.parse(request);
      const { session, baseUrl } = await sessionFor(parsed.subject.projectName, expectedAuthorityNamespace);
      const response = await input.fetch(`${baseUrl}/v1/dev/tasks/${encodeURIComponent(parsed.taskRef)}/e2e-publication-context`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!response.ok) throw new Error(`publication context request refused with HTTP ${response.status}`);
      return response.json();
    },
    async loadTask(taskRef, expectedAuthorityNamespace, projectName) {
      const { session, baseUrl } = await sessionFor(projectName, expectedAuthorityNamespace);
      if (!/^[0-9a-f-]{36}$/iu.test(taskRef)) throw new Error("task selector is invalid");
      const response = await input.fetch(`${baseUrl}/v1/dev/tasks/${encodeURIComponent(taskRef)}`, {
        method: "GET", headers: { authorization: `Bearer ${session.accessToken}` },
      });
      if (!response.ok) throw new Error(`native task read refused with HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 1_000_000) throw new Error("native task response exceeds the existing bounded view limit");
      const raw: unknown = JSON.parse(text);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("native task response is invalid");
      const fields = raw as Record<string, unknown>;
      if (Object.keys(fields).some((key) => key !== "task" && key !== "requestId") ||
          (fields.requestId !== undefined && (typeof fields.requestId !== "string" || fields.requestId.length === 0 || fields.requestId.length > 200)) ||
          fields.task === undefined) throw new Error("native task response envelope is invalid");
      return { task: fields.task };
    },
  };
}

/**
 * Record a host-owned native enrollment only from the server's successful registration response and a fresh local
 * GitHub identity check. A mismatch is a visible no-enrollment result; callers must not infer standalone mode.
 */
export async function recordRegisteredLoopEnrollment(input: {
  home: string; env: string; controlPlaneUrl: string; definition: ProjectDefinition; response: unknown;
  cwd?: string; exec?: Exec; now?: Date;
}): Promise<{ recorded: true; repository: string } | { recorded: false; reasonCode: string }> {
  const parsed = registeredResponse(input.response);
  if (parsed === undefined) {
    return { recorded: false, reasonCode: "registration_response_unproven" };
  }

  const exec = input.exec ?? realExec;
  const github = new GitHub(exec);
  const projectDefinition = parsed.definition;
  const hostId = `${hostname()}:${process.platform}:${arch()}`;
  const uid = process.getuid?.() ?? 0;
  const controlPlane = new URL(input.controlPlaneUrl).href.replace(/\/$/u, "");
  const namespace = `${controlPlane}/env/${input.env}/project/${projectDefinition.name}`;
  const pending = createRegisteredPendingEnrollment({
    namespace, hostId, uid, registeredBy: parsed.registeredBy, project: projectDefinition.name,
    projectRevision: projectDefinition.revision,
    sources: projectDefinition.repositories.map((entry) => ({ name: entry.name, repository: repositoryFromUrl(entry.url), repositoryUrl: entry.url })),
    now: input.now ?? new Date(),
  });
  const store = new LoopStore(`${input.home}/.rovara/loop`);
  const savedPending = await store.savePendingEnrollment(pending);
  if (!isDeepStrictEqual(projectDefinition, ProjectDefinitionSchema.parse(input.definition))) {
    return { recorded: false, reasonCode: "registration_response_unproven" };
  }

  const cwd = await realpath(input.cwd ?? process.cwd()).catch(() => undefined);
  if (cwd === undefined) return { recorded: false, reasonCode: "source_checkout_unavailable" };
  let repository: string;
  let account: string;
  let commonGitDir: string;
  try {
    [repository, account, commonGitDir] = await Promise.all([github.repoAt(cwd), github.login(), github.commonGitDir(cwd)]);
  } catch {
    return { recorded: false, reasonCode: "source_identity_unavailable" };
  }

  const matches = parsed.definition.repositories.filter((entry) => repositoryUrlMatches(entry.url, repository));
  if (matches.length !== 1) return { recorded: false, reasonCode: "registered_source_mismatch" };
  let repositoryId: number;
  try { repositoryId = await github.repositoryId(repository); }
  catch { return { recorded: false, reasonCode: "source_identity_unavailable" }; }
  const checkoutPath = cwd;
  const sourceBindingRef = `cli-source:v1:${createHash("sha256").update(JSON.stringify([
    parsed.registeredBy, namespace, projectDefinition.name, projectDefinition.revision,
    repository, repositoryId, matches[0]!.url, checkoutPath, commonGitDir,
  ])).digest("hex")}`;
  const receipt = createRegisteredEnrollment({
    namespace, hostId, uid, account, project: projectDefinition.name, projectRevision: projectDefinition.revision,
    repository, repositoryId, checkoutPath, commonGitDir, sourceBindingRef, now: input.now ?? new Date(),
  });
  await store.promotePendingEnrollment(savedPending.enrollmentId, repository, receipt);
  return { recorded: true, repository };
}

function registeredResponse(value: unknown): { definition: ProjectDefinition; registeredBy: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const project = (value as Record<string, unknown>).project;
  if (project === null || typeof project !== "object" || Array.isArray(project)) return undefined;
  const fields = project as Record<string, unknown>;
  if (typeof fields.registeredBy !== "string" || fields.registeredBy.length === 0) return undefined;
  const definition = ProjectDefinitionSchema.safeParse(fields.definition);
  return definition.success ? { definition: definition.data, registeredBy: fields.registeredBy } : undefined;
}

function repositoryFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const slug = url.pathname.replace(/^\//u, "").replace(/\.git$/iu, "").replace(/\/$/u, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug) ? slug : undefined;
  } catch { return undefined; }
}

function repositoryUrlMatches(value: string, repository: string): boolean {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return false;
    const path = url.pathname.replace(/^\//u, "").replace(/\.git$/iu, "").replace(/\/$/u, "");
    return path.toLowerCase() === repository.toLowerCase();
  } catch {
    return false;
  }
}
