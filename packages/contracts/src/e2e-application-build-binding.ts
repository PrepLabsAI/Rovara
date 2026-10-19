import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  E2EApplicationApprovalBindingSchema, E2EAppArtifactRefSchema, E2EAppBuildManifestSchema,
  e2eAppBuildManifestDigest, type E2EApplicationApprovalBinding, type E2EAppArtifactRef, type E2EAppBuildManifest,
  type SourceRef,
} from "./e2e-application.js";
import { E2EAppRecipeSchema, type E2EAppRecipe } from "./e2e.js";
import { e2eApplicationMetadataSourceRefs } from "./e2e-application-metadata.js";
import { inspectE2ERepository } from "./e2e-catalog.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const dependencyLockfileName = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|Package\.resolved|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum)$/i;
function parsedRecipe(recipe: unknown, applicationId: string): E2EAppRecipe {
  if (recipe === null || recipe === undefined) throw new Error(`application ${applicationId} has no source-backed launch recipe`);
  const parsed = E2EAppRecipeSchema.parse(recipe);
  const { recipeDigest, ...body } = parsed;
  if (sha256(canonicalJson(body)) !== recipeDigest) throw new Error(`application ${applicationId} recipe digest does not match its canonical recipe body`);
  return parsed;
}
function assertSnapshot(snapshot: E2ESourceSnapshot): ReturnType<typeof inspectE2ERepository> {
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  return inspectE2ERepository(snapshot, snapshot.candidate);
}
function sameRefs(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  return canonicalJson([...left].sort((a, b) => a.path.localeCompare(b.path)))
    === canonicalJson([...right].sort((a, b) => a.path.localeCompare(b.path)));
}
function expectedOutputPlatform(target: ReturnType<typeof inspectE2ERepository>["inspection"]["proposedTargets"][number]): string {
  if (target.kind === "mobile") return target.os;
  if (target.kind === "desktop") return target.os;
  return target.kind;
}

/** Shared pure validation for the exact source, recipe, lock, candidate, and artifact binding. */
export function validateE2EAppBuildBinding(input: {
  finalSnapshot: E2ESourceSnapshot;
  binding: E2EApplicationApprovalBinding;
  manifest: E2EAppBuildManifest;
  artifacts: E2EAppArtifactRef[];
}): { candidateDigest: string; applicationId: string; buildManifestDigest: string; artifactRefs: E2EAppArtifactRef[] } {
  const binding = E2EApplicationApprovalBindingSchema.parse(input.binding);
  const manifest = E2EAppBuildManifestSchema.parse(input.manifest);
  const artifactRefs = input.artifacts.map((item) => E2EAppArtifactRefSchema.parse(item));
  if (new Set(artifactRefs.map((item) => item.artifactId)).size !== artifactRefs.length) throw new Error("artifact references contain duplicate artifact IDs");
  const discovered = assertSnapshot(input.finalSnapshot);
  const approvedApplication = binding.applications.find((application) => application.applicationId === manifest.applicationId);
  const currentApplication = discovered.inspection.applications.find((application) => application.applicationId === manifest.applicationId);
  if (!approvedApplication || !currentApplication) throw new Error(`build manifest application ${manifest.applicationId} is not approved and present in final source`);
  const currentRecipe = parsedRecipe(currentApplication.recipe, manifest.applicationId);
  if (canonicalJson(currentRecipe) !== canonicalJson(approvedApplication.recipe) || manifest.recipeDigest !== approvedApplication.recipe.recipeDigest) {
    throw new Error(`application ${manifest.applicationId} recipe changed after approval; replan is required`);
  }
  const currentRefs = e2eApplicationMetadataSourceRefs(input.finalSnapshot, manifest.applicationId, currentApplication.sourcePaths);
  if (!sameRefs(currentRefs, approvedApplication.sourceRefs)) throw new Error(`application ${manifest.applicationId} source-owned identity or lockfile metadata changed after approval`);
  for (const ref of approvedApplication.sourceRefs) {
    const currentSource = input.finalSnapshot.sources.find((source) => source.path === ref.path && source.kind === "blob");
    if (!currentSource || currentSource.sha256 !== ref.sha256) throw new Error(`approved application source reference changed or is missing: ${ref.path}`);
  }
  const approvedRuntimeRefs = binding.runtimeRefs.filter((ref) => ref.applicationId === manifest.applicationId);
  if (approvedRuntimeRefs.length === 0) throw new Error(`application ${manifest.applicationId} has no approved runtime target`);
  for (const ref of approvedRuntimeRefs) {
    const target = discovered.inspection.proposedTargets.find((candidate) => candidate.targetId === ref.targetId);
    if (!target || target.applicationId !== manifest.applicationId) throw new Error(`approved target ${ref.targetId} no longer identifies application ${manifest.applicationId}`);
    if (!sameRefs(ref.sourceRefs, approvedApplication.sourceRefs) || ref.recipeDigest !== approvedApplication.recipe.recipeDigest) {
      throw new Error(`approved target ${ref.targetId} application source or recipe identity changed`);
    }
  }
  const expectedLocks = (refs: readonly SourceRef[]) => refs.filter((ref) => dependencyLockfileName.test(ref.path.slice(ref.path.lastIndexOf("/") + 1)));
  if (!sameRefs(manifest.lockfileRefs, expectedLocks(approvedApplication.sourceRefs))) throw new Error("build manifest lockfile references differ from the exact approved lockfile set");
  if (manifest.candidateDigest !== input.finalSnapshot.candidate.digest || manifest.repository.repositoryId !== input.finalSnapshot.candidate.repositories[0]?.repositoryId
    || manifest.repository.commitSha !== input.finalSnapshot.commitSha || manifest.repository.treeSha !== input.finalSnapshot.treeSha) {
    throw new Error("build manifest candidate and repository identity do not match the complete final protected source");
  }
  if (manifest.manifestDigest !== e2eAppBuildManifestDigest(manifest)) throw new Error("build manifest digest does not match its canonical content");
  const expectedArtifacts = manifest.outputs.map((output) => ({ ...output, buildManifestDigest: manifest.manifestDigest }));
  if (canonicalJson([...artifactRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))
    !== canonicalJson([...expectedArtifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))) {
    throw new Error("artifact references do not match the exact build manifest output identities and hashes");
  }
  const assignedTargets = approvedRuntimeRefs.map((ref) => discovered.inspection.proposedTargets.find((target) => target.targetId === ref.targetId)!);
  for (const output of manifest.outputs) {
    const outputIdentityMatches = assignedTargets.some((target) => expectedOutputPlatform(target) === output.platform
      && output.appId === ("appId" in target ? target.appId : manifest.applicationId));
    if (!outputIdentityMatches) throw new Error(`build output ${output.artifactId} does not match a source-owned application platform and app ID`);
  }
  for (const target of assignedTargets) {
    if (!manifest.outputs.some((output) => expectedOutputPlatform(target) === output.platform
      && output.appId === ("appId" in target ? target.appId : manifest.applicationId))) {
      throw new Error(`build manifest has no output for approved application target ${target.targetId}`);
    }
  }
  return { candidateDigest: input.finalSnapshot.candidate.digest, applicationId: manifest.applicationId,
    buildManifestDigest: manifest.manifestDigest, artifactRefs: expectedArtifacts };
}
