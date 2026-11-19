// Convergence lane A3 (owner decision 72, O2): the S3 `object-storage` module. Opt-in: Code keeps its default (the document store, or the folder adapter) unless the owner's config names this.
// Config entry (one identity is required, as for Bedrock):
//   { "point": "object-storage", "name": "s3", "module": "@agentx/broker/plugins/object-storage-s3",
//     "settings": { "bucket": "my-rovara-objects", "region": "us-west-2", "profile": "rovara-objects", "maxObjectMiB": 256, "expectedBucketOwner": "123456789012" } }
// The identity needs s3:PutObject, s3:PutObjectTagging (a tagged PUT is authorized as both), s3:GetObject, s3:DeleteObject and s3:ListBucket on that bucket, nothing else.
// How long a retention class is kept is the bucket's lifecycle rules, not a setting here. `retentionTags` says which classes are written with which object tag (class -> { key, value });
// a class it does not name gets no tag, so it is kept until deleted. Example: "retentionTags": { "evidence-std": { "key": "<the tag key your rules read>", "value": "evidence-std" } }.
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { PluginModule } from "@agentx/contracts";
import type { AwsCredentialLoaders } from "../../model-provider/bedrock/credentials.js";
import { readPluginSettings } from "../../module-support.js";
import { AwsIdentitySettingsShape, ONE_AWS_IDENTITY, awsCredentialsFor, hasOneAwsIdentity } from "../../aws-identity.js";
import { S3ObjectStorage, type S3ObjectClient, type S3PresignFunction } from "@rovara/aws-adapters/s3";

export const S3_OBJECT_STORAGE_NAME = "s3";

export const S3ObjectStorageSettingsSchema = z.object({
  ...AwsIdentitySettingsShape,
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u, "an S3 bucket name"),
  maxObjectMiB: z.number().int().min(1).max(5_120).optional(),
  expectedBucketOwner: z.string().regex(/^\d{12}$/u, "a 12-digit AWS account id").optional(),
  retentionTags: z.record(
    z.string().regex(/^[A-Za-z0-9+\-=._:/@]{1,128}$/u, "a retention class"),
    z.object({ key: z.string().regex(/^[A-Za-z0-9+\-=._:/@]{1,128}$/u, "an S3 tag key"), value: z.string().regex(/^[A-Za-z0-9+\-=._:/@]{0,256}$/u, "an S3 tag value") }).strict(),
  ).optional(),
}).strict().refine(hasOneAwsIdentity, ONE_AWS_IDENTITY);

export interface S3ObjectStoragePluginOptions {
  /** Replaces the S3 client (tests, or a deployment that builds its own). The settings must still name an identity. */
  client?: S3ObjectClient;
  loaders?: AwsCredentialLoaders;
  /** `getSignedUrl` from `@aws-sdk/s3-request-presigner`, for `presignGet`. */
  presign?: S3PresignFunction;
}

export function s3ObjectStoragePlugin(options: S3ObjectStoragePluginOptions = {}): PluginModule<"object-storage"> {
  return {
    point: "object-storage",
    name: S3_OBJECT_STORAGE_NAME,
    create(context) {
      const settings = readPluginSettings(S3ObjectStorageSettingsSchema, context.settings, `object-storage/${S3_OBJECT_STORAGE_NAME}`);
      const client = options.client ?? new S3Client({
        region: settings.region,
        credentials: awsCredentialsFor(settings, { sessionName: "rovara-objects", ...(options.loaders === undefined ? {} : { loaders: options.loaders }) }),
      });
      return new S3ObjectStorage({
        client,
        bucket: settings.bucket,
        now: () => context.now().getTime(),
        ...(settings.maxObjectMiB === undefined ? {} : { maxObjectBytes: settings.maxObjectMiB * 1_048_576 }),
        ...(settings.expectedBucketOwner === undefined ? {} : { expectedBucketOwner: settings.expectedBucketOwner }),
        ...(settings.retentionTags === undefined ? {} : { retentionTags: settings.retentionTags }),
        ...(options.presign === undefined ? {} : { presign: options.presign }),
      });
    },
  };
}
