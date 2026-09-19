import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";

const execFileAsync = promisify(execFile);

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface TokenStore {
  get(key: string): Promise<StoredTokens | undefined>;
  set(key: string, tokens: StoredTokens): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredTokens>();

  async get(key: string): Promise<StoredTokens | undefined> {
    const value = this.tokens.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async set(key: string, tokens: StoredTokens): Promise<void> {
    this.tokens.set(key, structuredClone(tokens));
  }

  async delete(key: string): Promise<void> {
    this.tokens.delete(key);
  }
}

export class SystemCredentialTokenStore implements TokenStore {
  constructor(private readonly service = "dev.agentx.cli") {}

  async get(key: string): Promise<StoredTokens | undefined> {
    try {
      const serialized =
        process.platform === "darwin"
          ? (
              await execFileAsync(
                "security",
                ["find-generic-password", "-s", this.service, "-a", key, "-w"],
                { maxBuffer: 131_072 },
              )
            ).stdout
          : process.platform === "linux"
            ? (
                await execFileAsync(
                  "secret-tool",
                  ["lookup", "service", this.service, "account", key],
                  { maxBuffer: 131_072 },
                )
              ).stdout
            : unsupportedPlatform();
      return parseStoredTokens(serialized.trim());
    } catch (error) {
      const status = error as Error & { code?: number };
      if (status.code === 44 || status.code === 1) return undefined;
      throw error;
    }
  }

  async set(key: string, tokens: StoredTokens): Promise<void> {
    const serialized = JSON.stringify(parseStoredTokens(JSON.stringify(tokens)));
    if (process.platform === "darwin") {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        key,
        "-w",
        serialized,
      ]);
      return;
    }
    if (process.platform === "linux") {
      await spawnWithInput(
        "secret-tool",
        ["store", "--label=AgentX CLI token", "service", this.service, "account", key],
        serialized,
      );
      return;
    }
    unsupportedPlatform();
  }

  async delete(key: string): Promise<void> {
    if (process.platform === "darwin") {
      await execFileAsync("security", ["delete-generic-password", "-s", this.service, "-a", key]).catch(
        () => undefined,
      );
      return;
    }
    if (process.platform === "linux") {
      await execFileAsync("secret-tool", ["clear", "service", this.service, "account", key]).catch(
        () => undefined,
      );
      return;
    }
    unsupportedPlatform();
  }
}

function parseStoredTokens(serialized: string): StoredTokens {
  const value = JSON.parse(serialized) as Record<string, unknown>;
  if (
    typeof value.accessToken !== "string" ||
    value.accessToken.length === 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
  ) {
    throw agentXError("AUTH_REQUIRED", "credential store contains an invalid AgentX token");
  }
  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
  };
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
