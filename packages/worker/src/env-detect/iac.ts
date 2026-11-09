// Infrastructure-as-code detector: which kind the repository uses, so a per-task preview (tier 2) can name its provider. Detection only; nothing is deployed.
import { type Detector, findLine } from "./types.js";

export const detectIac: Detector = async ({ repo }) => {
  const iac: Array<{ value: { provider: "cdk" | "cloudformation" | "terraform"; path: string }; source: { path: string; line: number } }> = [];
  for (const path of repo.paths) {
    const name = path.split("/").at(-1) ?? path;
    if (name === "cdk.json") iac.push({ value: { provider: "cdk", path }, source: { path, line: 1 } });
    else if (name.endsWith(".tf")) iac.push({ value: { provider: "terraform", path }, source: { path, line: 1 } });
    else if (/^(?:template|serverless)\.(?:ya?ml|json)$/u.test(name) || /\.template\.(?:ya?ml|json)$/u.test(name)) {
      const text = await repo.read(path);
      const line = text === undefined ? undefined : findLine(text, /AWSTemplateFormatVersion|Transform:\s{0,40}['"]?AWS::Serverless/u);
      if (line !== undefined) iac.push({ value: { provider: "cloudformation", path }, source: { path, line } });
    }
    if (iac.length >= 20) break;
  }
  return iac.length === 0 ? {} : { iac, notes: ["Infrastructure code was found. A per-task preview environment would deploy it; Rovara proposes the sandbox tier until a maintainer chooses otherwise."] };
};
