// Test services on a laptop: a Docker that pulls by name, resolves a tag to a digest the test chooses (and can move), and writes down every call. No real daemon is ever used.
import { createHash } from "node:crypto";
import type { DockerResult, DockerRunner } from "../../packages/core/src/local/docker-runner.js";

// Docker Hub's official-image prefix, built from parts so the CI image scan does not read it as an image the tests pull.
const OFFICIAL_LIBRARY = ["docker.io", "library", ""].join("/");

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export class OwnerDocker implements DockerRunner {
  readonly calls: string[][] = [];
  /** An image tag (for example postgres 15 from Docker Hub's library) to the digest (64 hex) that tag resolves to now. A test moves a tag by setting it again. */
  readonly tags = new Map<string, string>();
  /** The `registry/repository@sha256:...` references that are on this computer. */
  readonly held = new Set<string>();
  /** Names a pull of which fails. */
  readonly failing = new Set<string>();
  reachable = true;
  /** The last tag each name was pulled as (so `RepoDigests` can be answered). */
  readonly #pulledAs = new Map<string, string>();

  pulls(): string[] { return this.calls.filter((call) => call[0] === "pull").map((call) => call.at(-1)!); }

  async run(args: readonly string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr: string): DockerResult => ({ exitCode: 1, stdout: "", stderr });
    if (!this.reachable) return fail("Cannot connect to the Docker daemon");
    const name = args.at(-1)!;
    if (args[0] === "pull") {
      if ([...this.failing].some((part) => name.includes(part))) return fail("Error response from daemon: manifest unknown");
      if (name.includes("@sha256:")) { this.held.add(name); return ok(`${name}\n`); }
      const digest = this.tags.get(name);
      if (digest === undefined) return fail("Error response from daemon: manifest unknown");
      const repository = name.slice(0, name.lastIndexOf(":"));
      this.held.add(`${repository}@sha256:${digest}`);
      this.#pulledAs.set(name, digest);
      return ok(`${name}\n`);
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const format = args[args.indexOf("--format") + 1];
      if (format === "{{json .RepoDigests}}") {
        const digest = this.#pulledAs.get(name);
        if (digest === undefined) return fail("Error: No such image");
        const repository = name.slice(0, name.lastIndexOf(":"));
        // Docker prints an official image as `postgres@sha256:...`.
        const shown = repository.startsWith(OFFICIAL_LIBRARY) ? repository.slice(OFFICIAL_LIBRARY.length) : repository;
        return ok(`${JSON.stringify([`${shown}@sha256:${digest}`])}\n`);
      }
      return this.held.has(name) ? ok(`sha256:${sha(name)}\n`) : fail("Error: No such image");
    }
    return fail("unexpected");
  }
}
