// Port lane P5 (item K2, review M1/L1/L2): where Bedrock's AWS credential comes from. It is never "whatever the shell has" unless the owner said so:
//   - `profile`: a named AWS profile, read with the shared-config provider;
//   - `roleArn`: a role assumed for a short session (15 minutes), using the default chain only to call AssumeRole;
//   - `ambient`: the default provider chain, which needs `"allowAmbientAwsCredentials": true` in the settings.
// The provider is built once and the credential is cached until a minute before it expires. A failure is remembered as a FIXED sentence (never the SDK's words, which can quote a profile or
// an ARN), so the owner is told what to fix: "AWS credential module missing" is not "sign in to AWS".
export type AwsIdentity = { kind: "profile"; profile: string } | { kind: "role"; roleArn: string } | { kind: "ambient" };

export interface AwsCredentialValue {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  expiration?: Date | undefined;
}

export type AwsCredentialProvider = () => Promise<AwsCredentialValue>;

/** Builds a credential provider from the AWS SDK modules (loaded when first needed). Tests give their own. */
export interface AwsCredentialLoaders {
  profile(profile: string): Promise<AwsCredentialProvider>;
  ambient(): Promise<AwsCredentialProvider>;
  role(roleArn: string, region: string): Promise<AwsCredentialProvider>;
}

export const AWS_MODULE_MISSING = "AWS credential module missing";

export class AwsCredentialSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsCredentialSetupError";
  }
}

async function load<T>(importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch {
    throw new AwsCredentialSetupError(AWS_MODULE_MISSING);
  }
}

export function defaultAwsLoaders(): AwsCredentialLoaders {
  return {
    async profile(profile) {
      const { fromIni } = await load(() => import("@aws-sdk/credential-provider-ini"));
      return fromIni({ profile });
    },
    async ambient() {
      const { defaultProvider } = await load(() => import("@aws-sdk/credential-provider-node"));
      return defaultProvider();
    },
    async role(roleArn, region) {
      const { STSClient, AssumeRoleCommand } = await load(() => import("@aws-sdk/client-sts"));
      const client = new STSClient({ region });
      return async () => {
        const out = await client.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "rovara-bedrock", DurationSeconds: 900 }));
        const got = out.Credentials;
        if (got?.AccessKeyId === undefined || got.SecretAccessKey === undefined) throw new Error("no credentials");
        return { accessKeyId: got.AccessKeyId, secretAccessKey: got.SecretAccessKey, sessionToken: got.SessionToken, expiration: got.Expiration };
      };
    },
  };
}

/** What a failure to get a credential is called to the owner, by identity. */
function failureSentence(identity: AwsIdentity): string {
  switch (identity.kind) {
    case "profile": return "the AWS profile named in your config could not be used";
    case "role": return "the AWS role named in your config could not be assumed";
    case "ambient": return "no AWS credentials were found on this computer";
  }
}

export interface AwsCredentialSource {
  resolve(): Promise<AwsCredentialValue>;
  /** The fixed sentence for why the last `resolve()` failed, or undefined after a success. */
  problem(): string | undefined;
}

const REFRESH_BEFORE_MS = 60_000;
const NO_EXPIRY_CACHE_MS = 30_000;

export function createAwsCredentialSource(identity: AwsIdentity, region: string, options: { loaders?: AwsCredentialLoaders; now?: () => number } = {}): AwsCredentialSource {
  const loaders = options.loaders ?? defaultAwsLoaders();
  const now = options.now ?? Date.now;
  let built: Promise<AwsCredentialProvider> | undefined;
  let cached: { value: AwsCredentialValue; until: number } | undefined;
  let inflight: Promise<AwsCredentialValue> | undefined;
  let problem: string | undefined;
  const build = (): Promise<AwsCredentialProvider> => {
    if (identity.kind === "profile") return loaders.profile(identity.profile);
    if (identity.kind === "role") return loaders.role(identity.roleArn, region);
    return loaders.ambient();
  };
  return {
    problem: () => problem,
    resolve() {
      if (cached !== undefined && cached.until > now()) return Promise.resolve(cached.value);
      // Single flight: calls that find the credential expired at the same time share one refresh (one AssumeRole), not one each.
      inflight ??= (async () => {
        try {
          // Built once. A build that failed (a missing module) is tried again on the next call.
          built ??= build().catch((error: unknown) => { built = undefined; throw error; });
          const value = await (await built)();
          cached = { value, until: value.expiration === undefined ? now() + NO_EXPIRY_CACHE_MS : value.expiration.getTime() - REFRESH_BEFORE_MS };
          problem = undefined;
          return value;
        } catch (error) {
          cached = undefined;
          problem = error instanceof AwsCredentialSetupError ? error.message : failureSentence(identity);
          throw new AwsCredentialSetupError(problem);
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
  };
}
