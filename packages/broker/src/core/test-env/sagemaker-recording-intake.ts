// SageMaker endpoints (design: SageMaker endpoint shim, lane SM5): what Rovara does with a recording file a customer uploads. The recorder scanned it in the customer's environment; Rovara does not rely on that. The
// file is read against the format, every request and every answer in it is scanned AGAIN (the built-in personal-data scanner, then the synthetic-data guard that also finds secrets and names of production), and a
// finding refuses the file with a kind and a field, never the text. A person then confirms samples. Pure: nothing is stored here, and the caller decides where an accepted file goes.
import {
  SAGEMAKER_RECORDING_MAX_BYTES,
  builtinPiiScanner,
  rescanSageMakerRecording,
  sageMakerDocumentTexts,
  sageMakerRecordingSamples,
  type PiiScanner,
  type SageMakerFixtureDocument,
  type SageMakerRecordingFile,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import { scanText } from "@agentx/verifier";

export type SageMakerIntakeRefusal = "too_large" | "not_json" | "invalid" | "findings" | "scan_failed";
export const SAGEMAKER_INTAKE_REFUSAL_WORDS: Record<SageMakerIntakeRefusal, string> = {
  too_large: "The recording file is larger than a recording may be.",
  not_json: "The recording file is not JSON.",
  invalid: "This is not a Rovara SageMaker recording file, or it does not match the format.",
  findings: "The recording holds data that looks personal, a secret, or a name of production, so it was not accepted.",
  scan_failed: "The scan could not finish, so the recording was not accepted.",
};

export interface SageMakerIntakeFinding {
  /** A personal-data kind from the scanner, or a kind from the synthetic-data guard. */
  kind: string;
  /** The field, such as `rules[3].response.body`: never what was found. */
  path: string;
}

export type SageMakerIntake =
  | {
      ok: true;
      file: SageMakerRecordingFile;
      /** The fixture document the front serves, and its digest (the pin the approved plan holds). */
      document: SageMakerFixtureDocument;
      digest: string;
      /** Bodies that were not text: the scan read them as bytes only, so a person looks at them. */
      binaryBodies: number;
      /** The first pairs, as short lines, for the person who confirms samples. */
      samples: Array<{ index: number; request: string; answer: string }>;
    }
  | { ok: false; reason: SageMakerIntakeRefusal; findings: SageMakerIntakeFinding[] };

/**
 * Reads an uploaded recording and scans it again. `deny` is the company's production list (the same one the fixture store uses), so a recording that names production is refused here as any fixture would be.
 * `scanner` defaults to the built-in scanner; the caller may pass a stronger one. Never throws.
 */
export async function intakeSageMakerRecording(raw: string, deny: TestEnvProdDeny, scanner: PiiScanner = builtinPiiScanner): Promise<SageMakerIntake> {
  if (Buffer.byteLength(raw, "utf8") > SAGEMAKER_RECORDING_MAX_BYTES) return { ok: false, reason: "too_large", findings: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: "not_json", findings: [] }; }
  try {
    const rescan = await rescanSageMakerRecording(value, scanner);
    const findings: SageMakerIntakeFinding[] = rescan.ok ? [] : rescan.findings.map((entry) => ({ kind: entry.kind, path: entry.path }));
    if (!rescan.ok && rescan.reason === "invalid") return { ok: false, reason: "invalid", findings: [] };
    // The synthetic-data guard looks for what the personal-data scanner does not: secrets and names of production (hosts, ARNs, accounts on the company's list).
    const file = rescan.ok ? rescan.file : undefined;
    if (file !== undefined) {
      for (const item of sageMakerDocumentTexts(file.fixtures)) {
        for (const kind of scanText(item.text, deny)) if (findings.length < 100) findings.push({ kind, path: item.path });
      }
    }
    if (findings.length > 0 || !rescan.ok || file === undefined) return { ok: false, reason: "findings", findings };
    return { ok: true, file, document: file.fixtures, digest: rescan.digest, binaryBodies: rescan.binaryBodies, samples: sageMakerRecordingSamples(file) };
  } catch {
    return { ok: false, reason: "scan_failed", findings: [] };
  }
}
