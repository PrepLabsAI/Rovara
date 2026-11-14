import { z } from "zod";

/** Becomes the tool prefix `<name>__<tool>`, so it is short and lowercase. */
export const ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
