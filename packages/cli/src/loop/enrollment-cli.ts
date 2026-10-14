import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { ProjectDefinitionSchema, type ProjectDefinition } from "@agentx/contracts";
import { GitHub } from "./github.js";
import { createRegisteredEnrollment } from "./enrollment.js";
import { realExec, type Exec } from "./exec.js";
import { LoopStore } from "./state.js";

/**
 * Record a host-owned native enrollment only from the server's successful registration response and a fresh local
 * GitHub identity check. A mismatch is a visible no-enrollment result; callers must not infer standalone mode.
 */
export async function recordRegisteredLoopEnrollment(input: {
  home: string; env: string; controlPlaneUrl: string; definition: ProjectDefinition; response: unknown;
  cwd?: string; exec?: Exec; now?: Date;
}): Promise<{ recorded: true; repository: string } | { recorded: false; reasonCode: string }> {
  const parsed = registeredResponse(input.response);
  if (parsed === undefined || !isDeepStrictEqual(parsed.definition, ProjectDefinitionSchema.parse(input.definition))) {
    return { recorded: false, reasonCode: "registration_response_unproven" };
  }

  const exec = input.exec ?? realExec;
  const github = new GitHub(exec);
  const cwd = await realpath(input.cwd ?? process.cwd()).catch(() => undefined);
  if (cwd === undefined) return { recorded: false, reasonCode: "source_checkout_unavailable" };
  let repository: string;
  let account: string;
  let repositoryId: number;
  try {
    [repository, account] = await Promise.all([github.repoAt(cwd), github.login()]);
    repositoryId = await github.repositoryId(repository);
  } catch {
    return { recorded: false, reasonCode: "source_identity_unavailable" };
  }

  const matches = parsed.definition.repositories.filter((entry) => repositoryUrlMatches(entry.url, repository));
  if (matches.length !== 1) return { recorded: false, reasonCode: "registered_source_mismatch" };
  const serverProject = input.response as { project: { registeredBy: string } };
  const projectDefinition = parsed.definition;
  const checkoutPath = cwd;
  const hostId = `${hostname()}:${process.platform}:${arch()}`;
  const uid = process.getuid?.() ?? 0;
  const controlPlane = new URL(input.controlPlaneUrl).href.replace(/\/$/u, "");
  const namespace = `${controlPlane}/env/${input.env}/project/${projectDefinition.name}`;
  const sourceBindingRef = `cli-source:v1:${createHash("sha256").update(JSON.stringify([
    serverProject.project.registeredBy, namespace, projectDefinition.name, projectDefinition.revision,
    repository, repositoryId, matches[0]!.url, checkoutPath,
  ])).digest("hex")}`;
  const receipt = createRegisteredEnrollment({
    namespace, hostId, uid, account, project: projectDefinition.name, projectRevision: projectDefinition.revision,
    repository, repositoryId, checkoutPath, sourceBindingRef, now: input.now ?? new Date(),
  });
  await new LoopStore(`${input.home}/.rovara/loop`).saveEnrollment(receipt);
  return { recorded: true, repository };
}

function registeredResponse(value: unknown): { definition: ProjectDefinition } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const project = (value as Record<string, unknown>).project;
  if (project === null || typeof project !== "object" || Array.isArray(project)) return undefined;
  const fields = project as Record<string, unknown>;
  if (typeof fields.registeredBy !== "string" || fields.registeredBy.length === 0) return undefined;
  const definition = ProjectDefinitionSchema.safeParse(fields.definition);
  return definition.success ? { definition: definition.data } : undefined;
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
