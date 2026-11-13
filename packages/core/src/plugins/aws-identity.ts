// Convergence lane A3 (owner decision 72, O2): what the generic AWS plug-ins (S3 objects, Secrets Manager secrets) share in their settings: the region and the ONE AWS identity
// the owner named. The identity rule is Bedrock's (review M1): a named profile, a role to assume for 15 minutes, or the default chain only when the owner opted in. The credential is
// built by `createAwsCredentialSource`, so a failure is a fixed sentence that never quotes a profile or an ARN.
import { z } from "zod";
import { createAwsCredentialSource, type AwsCredentialLoaders, type AwsCredentialValue, type AwsIdentity } from "./model-provider/bedrock/credentials.js";

export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u;

/** The identity fields every generic AWS plug-in takes. Exactly one must be set (checked by `refineOneAwsIdentity`). */
export const AwsIdentitySettingsShape = {
  region: z.string().regex(AWS_REGION_PATTERN, "an AWS region such as us-west-2"),
  profile: z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/u, "an AWS profile name").optional(),
  roleArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u, "an IAM role ARN").optional(),
  allowAmbientAwsCredentials: z.literal(true).optional(),
};

export interface AwsIdentitySettings {
  region: string;
  profile?: string | undefined;
  roleArn?: string | undefined;
  allowAmbientAwsCredentials?: true | undefined;
}

export const ONE_AWS_IDENTITY = "name exactly one AWS identity: profile, roleArn, or allowAmbientAwsCredentials: true (the default chain: whatever identity this shell has)";

export function hasOneAwsIdentity(settings: AwsIdentitySettings): boolean {
  return [settings.profile, settings.roleArn, settings.allowAmbientAwsCredentials].filter((value) => value !== undefined).length === 1;
}

export function awsIdentityOf(settings: AwsIdentitySettings): AwsIdentity {
  if (settings.profile !== undefined) return { kind: "profile", profile: settings.profile };
  if (settings.roleArn !== undefined) return { kind: "role", roleArn: settings.roleArn };
  return { kind: "ambient" };
}

/** The shape the AWS SDK's `credentials` option takes (absent fields left out, not undefined). */
export interface AwsSdkCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/** The SDK `credentials` option for the identity: cached until a minute before expiry, single flight, and a fixed sentence on failure. */
export function awsCredentialsFor(settings: AwsIdentitySettings, options: { sessionName: string; loaders?: AwsCredentialLoaders; now?: () => number }): () => Promise<AwsSdkCredential> {
  const source = createAwsCredentialSource(awsIdentityOf(settings), settings.region, {
    sessionName: options.sessionName,
    ...(options.loaders === undefined ? {} : { loaders: options.loaders }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return async () => {
    const value: AwsCredentialValue = await source.resolve();
    return {
      accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey,
      ...(value.sessionToken === undefined ? {} : { sessionToken: value.sessionToken }), ...(value.expiration === undefined ? {} : { expiration: value.expiration }),
    };
  };
}
