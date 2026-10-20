import type { SourceRef } from "./e2e-application.js";
import type { E2ESourceSnapshot } from "./e2e-source.js";

const dependencyLockfileName = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|Package\.resolved|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum)$/i;
const applicationIdentityName = /(?:^|\/)(?:AndroidManifest\.xml|Info\.plist|[^/]+\.xcodeproj\/project\.pbxproj|[^/]+\.xcworkspace\/contents\.xcworkspacedata|[^/]+\.csproj|[^/]+\.sln|CMakeLists\.txt|meson\.build)$/i;
const buildMetadataName = /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|Podfile|project\.yml|Package\.swift|Cargo\.toml|go\.mod)$/i;

/** An application with neither a source-owned package.json nor a native project identity file: its identity cannot be established, which is not a malformed source. */
export class E2EApplicationIdentityMissingError extends Error {}

export function e2eApplicationMetadataSourcePaths(appSourcePaths: readonly string[], sourcePaths: readonly string[], applicationId: string): string[] {
  const packagePaths = appSourcePaths.filter((path) => /(^|\/)package\.json$/i.test(path));
  if (packagePaths.length > 1) throw new Error(`application ${applicationId} has ambiguous source-owned package identity`);
  const packagePath = packagePaths[0];
  const identityPaths = appSourcePaths.filter((path) => applicationIdentityName.test(path));
  if (packagePath === undefined && identityPaths.length === 0) throw new E2EApplicationIdentityMissingError(`application ${applicationId} has no source-owned package or native project identity metadata`);
  const appDirectory = packagePath === undefined ? undefined : packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/")) : ".";
  const nativeRoots = identityPaths.map((path) => {
    const androidProject = /^(.*?)(?:\/src\/main\/)AndroidManifest\.xml$/i.exec(path);
    if (androidProject) return androidProject[1] || ".";
    const projectMatch = /^(.*?)(?:\/[^/]+\.xcodeproj)\/project\.pbxproj$/i.exec(path);
    if (projectMatch) return projectMatch[1] || ".";
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  });
  const withinRoot = (path: string, root: string) => root === "." || path === root || path.startsWith(root + "/");
  const relatedSourcePaths = sourcePaths.filter((path) => {
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const lockOrBuildMetadataApplies = (root: string) => directory === root || (root !== "." && (directory === "." || root.startsWith(`${directory}/`)));
    return (appDirectory !== undefined && lockOrBuildMetadataApplies(appDirectory))
      || nativeRoots.some((root) => lockOrBuildMetadataApplies(root) || withinRoot(path, root));
  });
  const authorityPaths = relatedSourcePaths.filter((path) => dependencyLockfileName.test(path.slice(path.lastIndexOf("/") + 1))
    || buildMetadataName.test(path) || applicationIdentityName.test(path));
  const paths = [...new Set([...(packagePath === undefined ? [] : [packagePath]), ...identityPaths, ...authorityPaths])].sort((left, right) => left.localeCompare(right));
  if (paths.length > 128) throw new Error(`application ${applicationId} metadata source references exceed the supported limit`);
  return paths;
}

function sourceRef(snapshot: E2ESourceSnapshot, path: string): SourceRef {
  const source = snapshot.sources.find((item) => item.path === path && item.kind === "blob");
  if (!source) throw new Error(`selected application metadata source is missing: ${path}`);
  return { path: source.path, sha256: source.sha256 };
}

export function e2eApplicationMetadataSourceRefs(snapshot: E2ESourceSnapshot, applicationId: string, appSourcePaths: readonly string[]): SourceRef[] {
  const paths = e2eApplicationMetadataSourcePaths(appSourcePaths, snapshot.sources.map((source) => source.path), applicationId);
  const packagePath = paths.find((path) => /(^|\/)package\.json$/i.test(path));
  if (packagePath !== undefined) {
    const packageBytes = snapshot.sources.find((item) => item.path === packagePath)?.bytes;
    if (!packageBytes) throw new Error(`application ${applicationId} package identity source is missing`);
    try {
      const packageValue: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes));
      if (packageValue === null || typeof packageValue !== "object" || Array.isArray(packageValue)) throw new Error("invalid package JSON object");
    } catch { throw new Error(`application ${applicationId} package identity is not valid UTF-8 JSON`); }
  }
  return paths.map((path) => sourceRef(snapshot, path));
}
