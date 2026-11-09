// The fields every org connection shares (Plan 3, ruling R62), kept apart so the connection types of later plans can build on them
// without importing the union that includes them.
import { z } from "zod";

export const CONNECTION_LABEL_MAX = 64;

export const ConnectionLabelSchema = z.string().trim().min(1).max(CONNECTION_LABEL_MAX)
  // eslint-disable-next-line no-control-regex -- a label is one line of plain text
  .refine((label) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(label), "must be one line");

/** A key or token goes in an HTTP header, so it is printable ASCII with no space or line break. */
export const ConnectionSecretText = z.string().regex(/^[\x21-\x7e]{1,8192}$/, "must be 1 to 8192 printable characters with no space");
