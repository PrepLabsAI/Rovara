// Sign in with ChatGPT (#337): a developer connects their own ChatGPT plan, and their tasks run on
// it. These are the developer API's wire shapes for that connection (#338); the CLI (#339) and the
// Slack service (#340) send and read them. Requests are strict; responses are parsed loosely, so a
// newer control plane can add fields.
import { z } from "zod";

/** OpenAI's Sign in with ChatGPT accepts only this local callback for the dynamic client (the spike
 * of 2026-10-11: an https callback is refused). The sign-in therefore ends on the person's own
 * computer: the CLI listens there, and from Slack the person pastes the address it ends on. */
export const CHATGPT_CALLBACK_URL = "http://127.0.0.1:1455/auth/callback";
/** The name OpenAI's consent screen shows ("Use ChatGPT to sign in to Rovara"). */
export const CHATGPT_AGENT_NAME = "Rovara";
/** How long a started connection may take to finish. */
export const CHATGPT_CONNECT_STATE_SECONDS = 10 * 60;
/** The error OpenAI answers when a ChatGPT plan's shared usage limit is reached (#342 falls back on it). */
export const CHATGPT_PLAN_LIMIT_ERROR = "subscription_sharing_usage_limit_exceeded";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** #343: an install's Sign in with ChatGPT is off until an admin turns it on; this model is preferred when a plan allows it. */
export const CHATGPT_DEFAULT_PREFERRED_MODEL = "gpt-6.1-sol";
/** A ChatGPT model ID, as OpenAI's model list names them (gpt-6.1-sol, gpt-5.5). */
export const ChatGptModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, "a model ID such as gpt-6.1-sol");

export const CHATGPT_CONNECTION_STATUSES = ["connected", "limit-reached", "revoked"] as const;
export type ChatGptConnectionStatus = (typeof CHATGPT_CONNECTION_STATUSES)[number];

/** POST /v1/dev/chatgpt/connection: the address to open, and until when it can be finished. */
export const ChatGptConnectStartSchema = z.object({ authorizeUrl: z.string().url(), expiresAt: z.string() });
export type ChatGptConnectStart = z.infer<typeof ChatGptConnectStartSchema>;

/** POST /v1/dev/chatgpt/connection/finish: the address the browser ended on (pasted, from Slack or
 * a CLI that could not listen), or the three values the CLI's own callback received. */
export const ChatGptConnectFinishRequestSchema = z.union([
  z.object({ callbackUrl: z.string().min(1).max(4_096) }).strict(),
  z.object({ code: z.string().min(1).max(2_048), state: z.string().min(1).max(256), clientId: z.string().min(1).max(256) }).strict(),
]);
export type ChatGptConnectFinishRequest = z.infer<typeof ChatGptConnectFinishRequestSchema>;

/** GET /v1/dev/chatgpt/connection, and the answer to finish and to disconnect. */
export const ChatGptConnectionViewSchema = z.object({
  connected: z.boolean(),
  status: z.enum(CHATGPT_CONNECTION_STATUSES).optional(),
  email: z.string().optional(),
  connectedAt: z.string().optional(),
  /** The models this person's plan may use, as OpenAI listed them at the last check. */
  models: z.array(z.string()).optional(),
  /** When a task last changed the status (#342): a limit reached at this time is tried again an hour later. */
  statusAt: z.string().optional(),
}).loose();
export type ChatGptConnectionView = z.infer<typeof ChatGptConnectionViewSchema>;

/** GET /v1/admin/chatgpt (#343): what `rovara doctor` shows about Sign in with ChatGPT, read by the control plane. */
export const ChatGptHealthSchema = z.object({
  enabled: z.boolean(),
  preferredModel: z.string(),
  /** People whose connection works or waits out a limit; a revoked one is not counted. */
  connected: z.number().int().min(0),
  /** False when there were more connections than one read counts; `connected` is then a lower bound. */
  connectedComplete: z.boolean(),
  /** Whether the control plane reached OpenAI's sign-in and API hosts (any HTTP answer counts). */
  reachable: z.object({ auth: z.boolean(), api: z.boolean() }).strict(),
}).loose();
export type ChatGptHealth = z.infer<typeof ChatGptHealthSchema>;
