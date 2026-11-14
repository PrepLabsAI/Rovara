import { lstat, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { specLine, type ProjectCommand } from "@agentx/contracts";
import { openDirectory, readFileIn } from "./candidate-fs.js";
import { CheckNotRunError } from "./verification/checks.js";
import type { MultiRepoChecks } from "./multi-repo-checks.js";

interface Wiring {
  setup: ProjectCommand[];
  notes: string[];
  generated: Set<string>;
  link(): Promise<void>;
  command(command: ProjectCommand): ProjectCommand;
}

/** Wiring is generated only in the disposable root. No package manager runs in the host worker. */
export async function wireMultiRepoDependencies(input: MultiRepoChecks, root: string, oldCode = false): Promise<Wiring> {
  const setup: ProjectCommand[] = [];
  const notes: string[] = [];
  const maven = new Set<string>();
  let python = false;
  const links: Array<{ path: string; target: string }> = [];
  const generated = new Set<string>();
  const textCache = new Map<string, string>();
  let readBytes = 0;
  const text = async (path: string, optional = false): Promise<string> => {
    const cached = textCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const parent = await openDirectory(dirname(path));
      try {
        const contents = await readFileIn(parent, basename(path), 2 * 1024 * 1024 - readBytes);
        if (contents === undefined && !optional) throw new Error("missing");
        readBytes += contents?.length ?? 0;
        const value = contents?.toString("utf8") ?? "";
        textCache.set(path, value);
        return value;
      } finally { await parent.close(); }
    } catch { throw new Error("multi-repository dependency manifest is unavailable"); }
  };
  for (const edge of input.dependencies) {
    const consumer = input.repositories.find((repository) => repository.repositoryId === edge.consumer);
    const provider = input.repositories.find((repository) => repository.repositoryId === edge.provider);
    if (consumer === undefined || provider === undefined) throw new Error("multi-repository dependency has no repository");
    const from = join(root, consumer.path);
    const to = join(root, provider.path);
    const path = relative(from, to).split("\\").join("/");
    const command = (executable: string, args: string[]): ProjectCommand => ({ executable, args, cwd: consumer.path, timeoutSeconds: 600 });
    const manifests = edge.language === "node" ? ["package.json"] : edge.language === "go" ? ["go.mod"] : [];
    if (oldCode && (await Promise.all([from, to].flatMap((directory) => manifests.map((name) => lstat(join(directory, name)).catch(() => undefined))))).some((file) => file === undefined)) {
      notes.push("tested separately: dependency manifest unavailable on original code");
      continue;
    }
    const generatedNames = edge.language === "node" ? ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] : edge.language === "go" ? ["go.mod", "go.sum"] : [];
    for (const name of generatedNames) generated.add(join(from, name));
    switch (edge.language) {
      case "node": {
        let target: { name?: unknown };
        try {
          const value: unknown = JSON.parse(await text(join(to, "package.json")));
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
          target = value;
        } catch { throw new Error("multi-repository dependency manifest is unavailable"); }
        if (typeof target.name !== "string" || !/^(?:@[a-z0-9_-][a-z0-9._-]*\/)?[a-z0-9_-][a-z0-9._-]*$/u.test(target.name)) throw new Error("multi-repository package name is invalid");
        // Keep the committed manifest/lock pair intact for npm ci. Install first, then link the copied provider.
        const link = join(from, "node_modules", target.name);
        links.push({ path: link, target: to });
        break;
      }
      case "go": {
        const module = /^module\s+(\S+)\s*$/mu.exec(await text(join(to, "go.mod")))?.[1];
        if (module === undefined || !/^[A-Za-z0-9._~/-]+$/u.test(module)) throw new Error("multi-repository Go module is invalid");
        setup.push(command("go", ["mod", "edit", `-replace=${module}=${path}`]));
        break;
      }
      case "gradle": {
        const kotlin = join(from, "settings.gradle.kts");
        const file = await lstat(kotlin).then(() => kotlin, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return join(from, "settings.gradle"); });
        const existing = await text(file, true);
        const literal = JSON.stringify(path).replaceAll("$", "\\$");
        await writeFile(file, `${existing}\nincludeBuild(${literal})\n`);
        break;
      }
      case "maven":
        maven.add(consumer.path); maven.add(provider.path);
        break;
      case "python":
        python = true;
        setup.push(command("python3", ["-m", "pip", "install", "--no-index", "--no-deps", "--no-build-isolation", "--target", relative(from, join(root, ".agentx-python")), path]));
        break;
      default:
        notes.push(`tested separately: no cross-repo wiring for ${specLine(edge.language, 120)}`);
    }
  }
  if (maven.size > 0) {
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    await writeFile(join(root, "pom.xml"), `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>rovara.check</groupId><artifactId>round</artifactId><version>1</version><packaging>pom</packaging><modules>${[...maven].map((path) => `<module>${escape(path)}</module>`).join("")}</modules></project>\n`);
  }
  return {
    setup, notes: [...new Set(notes)], generated,
    async link() {
      for (const link of links) {
        let parent = await openDirectory(root);
        try {
          for (const name of relative(root, dirname(link.path)).split("/")) {
            const next = (await parent.subdirectory(name, true))!;
            await parent.close(); parent = next;
          }
          await rm(parent.entry(basename(link.path)), { recursive: true, force: true });
          await symlink(relative(dirname(link.path), link.target), parent.entry(basename(link.path)), "dir");
        } finally { await parent.close(); }
      }
    },
    command(command) {
      const env = python ? { ...command.env, PYTHONPATH: [relative(join(root, command.cwd), join(root, ".agentx-python")), command.env?.PYTHONPATH].filter(Boolean).join(":") } : command.env;
      let args = command.args;
      const isMaven = ["mvn", "mvnw"].includes(basename(command.executable));
      if (isMaven && !maven.has(command.cwd) && [...maven].some((path) => command.cwd.startsWith(`${path}/`))) throw new CheckNotRunError("multi-repository Maven subfolder wiring is unsupported");
      if (isMaven && maven.has(command.cwd)) {
        if (args.some((arg) => arg === "-f" || arg.startsWith("--file") || arg === "-pl" || arg.startsWith("--projects"))) throw new Error("multi-repository Maven command already selects a reactor");
        args = ["-f", relative(join(root, command.cwd), join(root, "pom.xml")), "--projects", command.cwd, "--also-make", ...args];
      }
      return { ...command, args, ...(env === undefined ? {} : { env }) };
    },
  };
}
