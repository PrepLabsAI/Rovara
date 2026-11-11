// "How we work" in Rovara Code: where the playbook file is read from. The file is read through the CodeHost port, at the head of the repository's default branch, never from a task's own
// working branch: a task that could change its own rules would be grading itself. It is read from the project's meta repository when it has one (the meta repo is the project), else from its
// first repository.
//
// The read is cached by commit (the same commit is never read twice) and the head by a short time, so a busy project does not spend the host's rate limit on a file nobody changed. An answer is one
// of four words, and the caller decides what each means: `none` (no file: Rovara Code as it is), `ok`, `invalid` (a file that is there and cannot be used) and `unreadable` (the host did not
// answer: try again, never guess).
import {
  AgentXError,
  agentXError,
  PLAYBOOK_FILE_MAX_BYTES,
  PLAYBOOK_FILE_PATH,
  metaRepositoryOf,
  type CodeHost,
  type HostScope,
  type OrgId,
  type PlaybookFile,
  type PlaybookProblem,
  type RegistryView,
} from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { ProjectSource } from "../task-flow/deps.js";
import { parsePlaybookText, playbookDigest } from "./file.js";

export type PlaybookReading =
  | { status: "none"; repository?: string; /** The commit that holds no file: a task pins it, so a file added later does not reach a task that started without one. */ commit?: string }
  | { status: "ok"; file: PlaybookFile; digest: string; commit: string; repository: string; /** The file as it is in the repository (at most the size cap): the page shows it to be edited. */ text: string }
  | { status: "invalid"; problems: PlaybookProblem[]; commit: string; repository: string; text?: string }
  | { status: "unreadable"; reason: string };

export interface PlaybookSource {
  /**
   * The project's playbook: at the head of the default branch now, or, with `commit`, at that exact commit (a task reads the commit it pinned when it started, so one task runs under one playbook).
   * Never throws for a host that fails (that is `unreadable`); a project that is not registered or has no repository reads as `none`.
   */
  read(project: string, options?: { commit?: string }): Promise<PlaybookReading>;
}

export const HOST_UNREADABLE_MESSAGE = "the code host could not be reached just now";
const HEAD_TTL_MS = 10_000;
const COMMITS_KEPT = 32;
const SHA = /^[a-f0-9]{40,128}$/u;

export interface CodeHostPlaybookSourceOptions {
  companyId: OrgId;
  projects: Pick<ProjectSource, "latest">;
  /** Absent: no code host is set up, so there is nowhere to read a file from (every project reads as `none`). */
  codeHosts: RegistryView | undefined;
  now?: () => number;
}

type Parsed = Extract<PlaybookReading, { status: "ok" | "invalid" | "none" }>;

export function createCodeHostPlaybookSource(options: CodeHostPlaybookSourceOptions): PlaybookSource {
  const now = options.now ?? Date.now;
  const heads = new Map<string, { at: number; sha: string }>();
  const parsedByCommit = new Map<string, Parsed>();
  const remember = (key: string, value: Parsed): void => {
    parsedByCommit.delete(key);
    parsedByCommit.set(key, value);
    while (parsedByCommit.size > COMMITS_KEPT) parsedByCommit.delete(parsedByCommit.keys().next().value as string);
  };
  const scope: HostScope = { orgId: options.companyId };

  /**
   * The head of the branch the repository's record names (the owner's `defaultBranch`, the one the meta repository's pin uses), else the host's own default branch when the record's branch is not there. There
   * is no guessing of names: a branch no one named is never read, since it may be stale or open to any writer. When neither can be read the answer is a refusal (the caller says `unreadable`), never "no file".
   * The one exception is a repository the code host refuses outright (its address is not one the host serves, as a foreign site on a GitHub-only host): no rules can live there, so it reads as having no file, the
   * way a project with no code host does.
   */
  async function headOf(host: CodeHost, repository: { url: string; defaultBranch: string }): Promise<string | undefined> {
    const cacheKey = `${repository.url}\n${repository.defaultBranch}`;
    const cached = heads.get(cacheKey);
    if (cached !== undefined && now() - cached.at < HEAD_TTL_MS) return cached.sha;
    const url = repository.url;
    const tryBranch = async (branch: string): Promise<string | undefined> => {
      try {
        const sha = await host.baseBranchHead({ url }, branch, scope);
        if (!SHA.test(sha)) throw agentXError("RUNTIME_UNAVAILABLE", "the code host did not say what the default branch is at");
        return sha;
      } catch (error) {
        // A branch that is not there is the next candidate; any other failure is the host's.
        if (error instanceof AgentXError && (error.code === "NOT_FOUND" || error.code === "CONFIG_INVALID")) return undefined;
        throw error;
      }
    };
    let sha = await tryBranch(repository.defaultBranch);
    if (sha === undefined) {
      let identity: Awaited<ReturnType<CodeHost["repositoryIdentity"]>>;
      try {
        identity = await host.repositoryIdentity({ url }, scope);
      } catch (error) {
        if (error instanceof AgentXError && error.code === "CONFIG_INVALID") return undefined;
        throw error;
      }
      if (identity?.defaultBranch !== undefined && identity.defaultBranch !== repository.defaultBranch) sha = await tryBranch(identity.defaultBranch);
    }
    if (sha === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the repository's default branch could not be found");
    heads.set(cacheKey, { at: now(), sha });
    return sha;
  }

  return {
    async read(project, readOptions) {
      const registered = await options.projects.latest(project);
      // A project that is not registered has no repository to read a file from: the steps of a project that is not there cannot start at all, and a page asking about it says it is not found (service.ts).
      const repository = registered === undefined ? undefined : metaRepositoryOf(registered.definition) ?? registered.definition.repositories[0];
      if (repository === undefined || options.codeHosts === undefined) return { status: "none" };
      try {
        const host = codeHostForRecord(options.codeHosts, repository);
        const commit = readOptions?.commit ?? await headOf(host, repository);
        if (commit === undefined) return { status: "none", repository: repository.name };
        const key = `${repository.url}\n${commit}`;
        const known = parsedByCommit.get(key);
        if (known !== undefined) return known;
        let text: string | undefined;
        try {
          text = await host.fileAtRevision({ url: repository.url }, PLAYBOOK_FILE_PATH, commit, scope, { maxBytes: PLAYBOOK_FILE_MAX_BYTES, timeoutMs: 10_000 });
        } catch (error) {
          // A file over the size cap is refused by the host (CONFIG_INVALID): it is a file that cannot be used, said once per commit.
          if (error instanceof AgentXError && error.code === "CONFIG_INVALID") {
            const refused: Parsed = { status: "invalid", problems: [{ path: "(file)", message: `the file is larger than ${String(PLAYBOOK_FILE_MAX_BYTES)} bytes` }], commit, repository: repository.name };
            remember(key, refused);
            return refused;
          }
          throw error;
        }
        const result: Parsed = text === undefined ? { status: "none", repository: repository.name, commit } : ((): Parsed => {
          const parsed = parsePlaybookText(text);
          return parsed.ok ? { status: "ok", file: parsed.file, digest: playbookDigest(parsed.file), commit, repository: repository.name, text } : { status: "invalid", problems: parsed.problems, commit, repository: repository.name, text };
        })();
        remember(key, result);
        return result;
      } catch (error) {
        // The log names the kind of fault only, never its text (it can quote a repository's address).
        console.log(JSON.stringify({ component: "broker", event: "playbook.read_failed", error: error instanceof Error ? error.name : "unknown" }));
        return { status: "unreadable", reason: HOST_UNREADABLE_MESSAGE };
      }
    },
  };
}

/** A source over fixed text, for a laptop that reads the file from the folder it is run in and for tests: no host, no cache. */
export function fixedPlaybookSource(readings: Record<string, string | undefined> | ((project: string) => string | undefined)): PlaybookSource {
  const textOf = typeof readings === "function" ? readings : (project: string): string | undefined => readings[project];
  return {
    read(project) {
      const text = textOf(project);
      if (text === undefined) return Promise.resolve({ status: "none" });
      const parsed = parsePlaybookText(text);
      const commit = "0".repeat(40);
      return Promise.resolve(parsed.ok ? { status: "ok", file: parsed.file, digest: playbookDigest(parsed.file), commit, repository: "local", text } : { status: "invalid", problems: parsed.problems, commit, repository: "local", text });
    },
  };
}
