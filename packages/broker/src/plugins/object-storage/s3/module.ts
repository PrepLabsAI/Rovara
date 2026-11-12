// The ready-made module a plug-in config names for S3 objects: `"module": "@agentx/broker/plugins/object-storage-s3"`.
import { s3ObjectStoragePlugin } from "./plugin.js";

export const plugin = s3ObjectStoragePlugin();
export default plugin;
