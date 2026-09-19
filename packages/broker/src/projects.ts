import { ProjectDefinitionSchema, agentXError, type ProjectDefinition } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeProject, type ProjectMembership } from "./authorization.js";

export interface RegisteredProject {
  definition: ProjectDefinition;
  registeredBy: string;
  registeredAt: string;
}

export class InMemoryProjectRegistry {
  readonly projects = new Map<string, RegisteredProject>();

  register(
    identity: AuthenticatedIdentity,
    untrustedDefinition: ProjectDefinition,
    memberships: readonly ProjectMembership[],
  ): { project: RegisteredProject; duplicate: boolean } {
    const definition = ProjectDefinitionSchema.parse(untrustedDefinition);
    authorizeProjectAdministrator(identity, definition.name, memberships);
    assertDefinitionContainsReferencesOnly(definition);
    const key = projectKey(definition.name, definition.revision);
    const existing = this.projects.get(key);
    if (existing) {
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
        throw agentXError(
          "PROJECT_REVISION_MISMATCH",
          "a project revision is immutable after registration",
        );
      }
      return { project: structuredClone(existing), duplicate: true };
    }
    const registered: RegisteredProject = {
      definition: structuredClone(definition),
      registeredBy: identity.ownerKey,
      registeredAt: new Date().toISOString(),
    };
    this.projects.set(key, registered);
    return { project: structuredClone(registered), duplicate: false };
  }

  get(name: string, revision: number): RegisteredProject | undefined {
    const project = this.projects.get(projectKey(name, revision));
    return project ? structuredClone(project) : undefined;
  }
}

export function authorizeProjectAdministrator(
  identity: AuthenticatedIdentity,
  project: string,
  memberships: readonly ProjectMembership[],
): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const membership = authorizeProject(identity, project, memberships);
  if (membership.role !== "administrator") {
    throw agentXError("FORBIDDEN", "administrator membership for this project is required");
  }
}

function assertDefinitionContainsReferencesOnly(definition: ProjectDefinition): void {
  for (const repository of definition.repositories) {
    const url = new URL(repository.url);
    if (url.username || url.password) {
      throw agentXError("CONFIG_INVALID", "repository URLs cannot contain embedded credentials");
    }
    if (/secret|password|token/i.test(repository.credentialRef)) {
      throw agentXError(
        "CONFIG_INVALID",
        "credentialRef must be an opaque reference name, not a secret-bearing field",
      );
    }
  }
}

function projectKey(name: string, revision: number): string {
  return `${name}\0${revision}`;
}
