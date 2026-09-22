import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";

const execFileAsync = promisify(execFile);

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class SystemSecretStore implements SecretStore {
  constructor(private readonly service: string) {}

  async get(key: string): Promise<string | undefined> {
    try {
      const serialized = process.platform === "darwin"
        ? (await execFileAsync(
            "security",
            ["find-generic-password", "-s", this.service, "-a", key, "-w"],
            { maxBuffer: 131_072 },
          )).stdout
        : process.platform === "linux"
          ? (await execFileAsync(
              "secret-tool",
              ["lookup", "service", this.service, "account", key],
              { maxBuffer: 131_072 },
            )).stdout
          : unsupportedPlatform();
      const value = serialized.trim();
      return value.length === 0 ? undefined : value;
    } catch (error) {
      const status = error as Error & { code?: number };
      if (status.code === 44 || status.code === 1) return undefined;
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (value.length === 0) throw agentXError("AUTH_REQUIRED", "cannot store an empty secret");
    if (process.platform === "darwin") {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        key,
        "-w",
        value,
      ]);
      return;
    }
    if (process.platform === "linux") {
      await spawnWithInput(
        "secret-tool",
        ["store", "--label=AgentX secret", "service", this.service, "account", key],
        value,
      );
      return;
    }
    unsupportedPlatform();
  }

  async delete(key: string): Promise<void> {
    if (process.platform === "darwin") {
      await execFileAsync("security", ["delete-generic-password", "-s", this.service, "-a", key])
        .catch(() => undefined);
      return;
    }
    if (process.platform === "linux") {
      await execFileAsync("secret-tool", ["clear", "service", this.service, "account", key])
        .catch(() => undefined);
      return;
    }
    unsupportedPlatform();
  }
}

async function spawnWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function unsupportedPlatform(): never {
  throw agentXError(
    "AUTH_REQUIRED",
    "no supported OS credential store is available; install macOS Keychain or Secret Service",
  );
}
