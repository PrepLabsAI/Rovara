// `rovara record sagemaker`: registers the command. It needs no Rovara sign-in, no project and no deployment: it runs against the customer's own endpoint with the customer's own AWS credentials, and writes one file.
// See `sagemaker.ts` for what the recorder does and never does.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PII_KIND_WORDS, builtinPiiScanner, combinePiiScanners, type PiiScanner } from "@rovara-code/contracts";
import { Option, type Command } from "commander";
import { ReportedFailure, formatSuccess } from "../output.js";
import { INVOKE_FAILURE_WORDS, awsCliInvoker, type SageMakerInvoker } from "./invoker.js";
import { PRESIDIO_URL_PROBLEM_WORDS, presidioScanner, presidioUrl } from "./presidio.js";
import { RECORD_REFUSAL_WORDS, parseRecordInputs, recordSageMakerEndpoint, type InputsProblem, type RecordPolicy, type RecordResult } from "./sagemaker.js";

export interface RecordCommandContext {
  write: (text: string) => void;
  json: (command: Command) => boolean;
  version: string;
  /** Tests supply these; by default the customer's AWS CLI, the system clock and `fetch`. */
  invoker?: (options: { region?: string; profile?: string }) => SageMakerInvoker;
  now?: () => Date;
  fetch?: typeof fetch;
}

const INPUT_PROBLEM_WORDS: Record<InputsProblem, string> = {
  empty: "The input file has no requests.",
  too_large: "The input file is larger than 8 MiB.",
  too_many: "The input file has more than 500 requests.",
  not_json: "The input file is not JSON: use a JSON array, or one JSON object per line.",
  invalid_input: "A request in the input file is not valid (it has one of body, json or bodyBase64, and only the documented fields).",
};

interface RecordSageMakerOptions {
  endpoint: string; inputs: string; out: string; region?: string; profile?: string; contentType: string; accept?: string;
  onFinding: RecordPolicy; allowBinary: boolean; force: boolean; presidioUrl?: string; allowRemotePresidio: boolean;
}

/** The text a refusal is shown with: fixed words, then where each finding is by kind and field. Never what was found. */
export function refusalText(result: Extract<RecordResult, { ok: false }>): string {
  const lines = [RECORD_REFUSAL_WORDS[result.reason]];
  if (result.failure !== undefined) lines.push(INVOKE_FAILURE_WORDS[result.failure]);
  if (result.index !== undefined) lines.push(`Stopped at ${result.reason === "request_findings" || result.reason === "binary_not_allowed" || result.reason === "bad_inputs" ? "input" : "request"} number ${String(result.index + 1)}.`);
  for (const finding of result.findings ?? []) lines.push(`  ${finding.field}: ${PII_KIND_WORDS[finding.kind]}`);
  lines.push("Nothing was written.");
  return lines.join("\n");
}

export function registerRecordCommands(program: Command, context: RecordCommandContext): void {
  const record = program.command("record").description("record real answers into fixture files, on your own computer, with your own credentials; nothing is sent to Rovara");
  record
    .command("sagemaker")
    .description("record your SageMaker endpoint's answers to synthetic requests into a fixture file for Rovara's SageMaker fake, after a personal-data scan; sends requests only to your own endpoint")
    .requiredOption("--endpoint <name>", "the SageMaker endpoint to call, in your own account")
    .requiredOption("--inputs <file>", "a JSON array, or JSON Lines, of synthetic requests: {\"body\": \"...\"}, {\"json\": {...}} or {\"bodyBase64\": \"...\"}, each with optional contentType, accept, customAttributes, targetVariant, targetModel")
    .requiredOption("--out <file>", "the recording file to write (it is never written over an existing file without --force)")
    .option("--region <region>", "the AWS region of the endpoint (default: your AWS CLI's)")
    .option("--profile <profile>", "the AWS CLI profile to use (default: your AWS CLI's)")
    .option("--content-type <type>", "the content type of a request that names none", "application/json")
    .option("--accept <type>", "the accept header of a request that names none")
    .addOption(new Option("--on-finding <policy>", "what to do when an answer holds data that looks personal: refuse the recording, or replace it with a placeholder (a finding in a request always refuses)").choices(["refuse", "redact"]).default("refuse"))
    .option("--allow-binary", "record requests and answers that are not text (they are scanned only as text)", false)
    .option("--force", "replace an existing output file", false)
    .option("--presidio-url <url>", "also scan with a Presidio analyzer you run (for example http://localhost:5002); it must be on this computer")
    .option("--allow-remote-presidio", "allow a Presidio analyzer that is not on this computer (your recorded data is sent to it)", false)
    .action(async (options: RecordSageMakerOptions, command: Command) => {
      const json = context.json(command);
      const text = await readFile(resolve(options.inputs), "utf8").catch(() => undefined);
      if (text === undefined) throw new ReportedFailure("RECORD_INPUTS", "The input file could not be read.");
      const parsed = parseRecordInputs(text);
      if (!parsed.ok) throw new ReportedFailure("RECORD_INPUTS", `${INPUT_PROBLEM_WORDS[parsed.problem]}${parsed.index === undefined ? "" : ` (request number ${String(parsed.index + 1)})`}`);
      const scanners: PiiScanner[] = [builtinPiiScanner];
      if (options.presidioUrl !== undefined) {
        const checked = presidioUrl(options.presidioUrl, options.allowRemotePresidio);
        if (!checked.ok) throw new ReportedFailure("RECORD_PRESIDIO", PRESIDIO_URL_PROBLEM_WORDS[checked.problem]);
        scanners.push(presidioScanner({ url: options.presidioUrl, allowRemote: options.allowRemotePresidio, ...(context.fetch === undefined ? {} : { fetch: context.fetch }) }));
      }
      const invokerOptions = { ...(options.region === undefined ? {} : { region: options.region }), ...(options.profile === undefined ? {} : { profile: options.profile }) };
      let invoker: SageMakerInvoker;
      try { invoker = (context.invoker ?? awsCliInvoker)(invokerOptions); } catch (error) { throw new ReportedFailure("RECORD_OPTIONS", error instanceof RangeError ? error.message : "The options are not valid."); }
      const result = await recordSageMakerEndpoint(
        { endpointName: options.endpoint, inputs: parsed.inputs, out: resolve(options.out), policy: options.onFinding, defaultContentType: options.contentType, ...(options.accept === undefined ? {} : { defaultAccept: options.accept }), allowBinary: options.allowBinary, force: options.force },
        { invoker, scanner: scanners.length === 1 ? builtinPiiScanner : combinePiiScanners(scanners), now: context.now ?? (() => new Date()), version: context.version },
      );
      if (!result.ok) throw new ReportedFailure(`RECORD_${result.reason.toUpperCase()}`, refusalText(result));
      const summary = {
        file: result.out, answers: result.pairs, duplicateRequestsSkipped: result.duplicates, modelErrorsRecorded: result.modelErrors, redactions: result.redactions, scanners: result.scanners,
        next: "Look through the file, then upload it to Rovara. Rovara scans it again and a person confirms samples.",
      };
      context.write(json ? formatSuccess(summary, true) : [
        `Recorded ${String(result.pairs)} ${result.pairs === 1 ? "answer" : "answers"} from endpoint ${options.endpoint} to ${result.out}.`,
        `Scanned with: ${result.scanners}. Redactions: ${String(result.redactions)}. Duplicate requests skipped: ${String(result.duplicates)}. Model errors recorded: ${String(result.modelErrors)}.`,
        `Requests were sent to your endpoint only. Nothing was sent to Rovara.`,
        summary.next,
        "",
      ].join("\n"));
    });
}
