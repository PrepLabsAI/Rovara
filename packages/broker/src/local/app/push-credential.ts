// Lane L10 (review H1): where a worker's PUSH credential comes from. A clone uses the owner's token by the rules of `github-access.ts`; a push is never the owner's long-lived token. It is
// asked of the code-host adapter registered for the repository (`CodeHost.issueGitCredential`: one repository, expiring, scoped by the adapter's own rules: fine-grained token only unless the owner
// opted in, registered repositories only, push permission checked; lane L11 brings the GitHub adapter). No adapter, or one that cannot give a usable credential, means no push, and the
// publication stops with Retry. A broker-side git relay (the broker pushes, the worker never holds a push credential) is the later fix.
import { workerGitCredentialUsable, agentXError, type GitCredential, type RegistryView } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { RepositoryAccess, RepositoryCredential } from "../../repository-access.js";

/** What a worker is sent for a credential the adapter gave: the legacy wire shapes only (`{token}`, `{username, password}`) and an ssh key; a helper has no wire shape. */
export function workerCredentialOf(credential: GitCredential): RepositoryCredential {
  switch (credential.kind) {
    case "token": return { token: credential.token, ...(credential.username === undefined ? {} : { username: credential.username }) };
    case "basic": return { username: credential.username, password: credential.password };
    case "ssh-key": return { sshPrivateKey: credential.privateKey };
    case "helper": throw agentXError("FORBIDDEN", "this code host's credential cannot be given to a worker");
  }
}

export function withCodeHostPush(input: {
  registry: Pick<RegistryView, "get" | "names">;
  companyId: string;
  clone: (credentialRef: string, repositoryUrl: string, access: RepositoryAccess) => Promise<RepositoryCredential>;
  now?: () => number;
}): (credentialRef: string, repositoryUrl: string, access: RepositoryAccess) => Promise<RepositoryCredential> {
  return async (credentialRef, repositoryUrl, access) => {
    if (access !== "push") return input.clone(credentialRef, repositoryUrl, access);
    // 51 gap: a project cannot name its code host at registration yet, so a repository is on the host registered as `github` (the legacy default).
    let host;
    try {
      host = codeHostForRecord(input.registry as RegistryView, {});
    } catch {
      throw agentXError("FORBIDDEN", "no code host is set up to give a push credential");
    }
    const issued = await host.issueGitCredential({ url: repositoryUrl }, "push", { orgId: input.companyId });
    // Expiring within the hour, and a key only for a service identity.
    const usable = workerGitCredentialUsable(issued, { now: (input.now ?? Date.now)(), actingAs: host.capabilities.perPersonCredentials ? "on-behalf-of" : "service" });
    if (!usable.ok) throw agentXError("FORBIDDEN", "the code host did not give a usable push credential");
    return workerCredentialOf(usable.credential);
  };
}
