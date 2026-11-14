import { readFile, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { specLine, type ProjectCommand } from "@agentx/contracts";
import type { MultiRepoChecks } from "./multi-repo-checks.js";

interface Wiring {
  setup: ProjectCommand[];
  notes: string[];
  command(command: ProjectCommand): ProjectCommand;
}

/** Wiring is generated only in the disposable root. No package manager runs in the host worker. */
export async function wireMultiRepoDependencies(input: MultiRepoChecks, root: string): Promise<Wiring> {
  const setup: ProjectCommand[] = [];
  const notes: string[] = [];
  const maven = new Set<string>();
  let python = false;
  for (const edge of input.dependencies) {
    const consumer = input.repositories.find((repository) => repository.repositoryId === edge.consumer);
    const provider = input.repositories.find((repository) => repository.repositoryId === edge.provider);
    if (consumer === undefined || provider === undefined) throw new Error("multi-repository dependency has no repository");
    const from = join(root, consumer.path);
    const to = join(root, provider.path);
    const path = relative(from, to).split("\\").join("/");
    const command = (executable: string, args: string[]): ProjectCommand => ({ executable, args, cwd: consumer.path, timeoutSeconds: 600 });
    switch (edge.language) {
      case "node": {
        const target = JSON.parse(await readFile(join(to, "package.json"), "utf8")) as { name?: unknown };
        if (typeof target.name !== "string" || !/^(?:@[a-z0-9_-][a-z0-9._-]*\/)?[a-z0-9_-][a-z0-9._-]*$/u.test(target.name)) throw new Error("multi-repository package name is invalid");
        const manifest = JSON.parse(await readFile(join(from, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        const dependencies = Object.assign(Object.create(null) as Record<string, string>, manifest.dependencies);
        dependencies[target.name] = `file:${path}`;
        await writeFile(join(from, "package.json"), `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
        const link = join(from, "node_modules", target.name);
        await mkdir(dirname(link), { recursive: true });
        await symlink(relative(dirname(link), to), link, "dir");
        break;
      }
      case "go": {
        const module = /^module\s+(\S+)\s*$/mu.exec(await readFile(join(to, "go.mod"), "utf8"))?.[1];
        if (module === undefined || !/^[A-Za-z0-9._~/-]+$/u.test(module)) throw new Error("multi-repository Go module is invalid");
        setup.push(command("go", ["mod", "edit", `-replace=${module}=${path}`]));
        break;
      }
      case "gradle": {
        const kotlin = join(from, "settings.gradle.kts");
        const file = await lstat(kotlin).then(() => kotlin, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return join(from, "settings.gradle"); });
        const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
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
    setup, notes: [...new Set(notes)],
    command(command) {
      const env = python ? { ...command.env, PYTHONPATH: [relative(join(root, command.cwd), join(root, ".agentx-python")), command.env?.PYTHONPATH].filter(Boolean).join(":") } : command.env;
      let args = command.args;
      if (["mvn", "mvnw"].includes(basename(command.executable)) && maven.has(command.cwd)) {
        if (args.some((arg) => arg === "-f" || arg.startsWith("--file") || arg === "-pl" || arg.startsWith("--projects"))) throw new Error("multi-repository Maven command already selects a reactor");
        args = ["-f", relative(join(root, command.cwd), join(root, "pom.xml")), "--projects", command.cwd, "--also-make", ...args];
      }
      return { ...command, args, ...(env === undefined ? {} : { env }) };
    },
  };
}
