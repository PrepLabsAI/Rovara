// L4-E34 (E4): the STAND-IN SET VERSION. An eval that runs against stand-ins (a real database loaded from the project's migrations and seeds plus rows Rovara generates, and later answer sets for outside APIs) scores
// differently when the stand-ins change. Both sides of a comparison use one version, and a new version is a new base-cache key, so the old code is measured again (once, under the approved cap) and never compared with a score
// taken against other data. The version is a digest of what the stand-in set was made from: the images, the seeds (their content digests, in load order), the row generator's version and the answer sets.
//
// WHY A NEW VERSION NEEDS NO NEW APPROVAL (DEC 254zzz55 N3). The approved eval spend binds the settings fingerprint WITHOUT the stand-in version (`evalSettingsFingerprintOf` with no third argument is byte-identical to before). The
// version only moves the base-cache identity (`standInSettingsFingerprint`, and the explicit `standInSetVersion` key part), so the re-run is bounded by the approval's own call and cost caps and the monthly meter, exactly like any
// other base run. Nothing here grants spend.
import { canonicalJson } from "./canonical-json.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** The row generator's version. Change it whenever the generator would write different rows for the same schema: every stand-in set made with the old one is then a new version. */
export const STAND_IN_ROW_GENERATOR_VERSION = "rows-v1";

const SET_DOMAIN = "rovara-stand-in-set/v1\n";
const SETTINGS_DOMAIN = "rovara-eval-settings-stand-in/v1\n";
const HEX = /^[a-f0-9]{64}$/u;
/** The most of each kind one set names (a bound, never a silent cut: a longer list is refused). */
export const STAND_IN_SET_LIMITS = Object.freeze({ images: 64, seeds: 256, answerSets: 256 });

/** What a stand-in set was made from. Each seed and answer set is a sha-256 (hex) of its content; an image is its digest reference. */
export interface StandInSetParts {
  readonly images: readonly string[];
  /** Content digests of the seed files and seed commands, in the order they are loaded (order changes the data, so it is part of the version). */
  readonly seeds: readonly string[];
  readonly generatorVersion: string;
  /** Digests of the stored answer sets (an unordered set). */
  readonly answerSets: readonly string[];
}

/** Whether a value is a stand-in set version (a sha-256 in lower-case hex). */
export const isStandInSetVersion = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/**
 * The version of a stand-in set: SHA-256 (hex) over a fixed domain and the canonical JSON of the named parts. Images and answer sets are sets (sorted, repeats removed); seeds keep their order. Throws RangeError naming the part,
 * never its value, for a part that is not what it must be.
 */
export function standInSetVersion(parts: StandInSetParts): string {
  const held = parts as unknown as Record<string, unknown>;
  const list = (name: "images" | "seeds" | "answerSets", plain: RegExp): string[] => {
    const value = held[name];
    if (!Array.isArray(value) || value.length > STAND_IN_SET_LIMITS[name] || value.some(item => typeof item !== "string" || !plain.test(item))) throw new RangeError(`the ${name} are not a valid stand-in set part`);
    return value as string[];
  };
  const images = [...new Set(list("images", /^[A-Za-z0-9._:/@+-]{1,2000}$/u))].sort();
  const seeds = list("seeds", HEX);
  const answerSets = [...new Set(list("answerSets", HEX))].sort();
  const generatorVersion = held["generatorVersion"];
  if (typeof generatorVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{0,39}$/u.test(generatorVersion)) throw new RangeError("the generatorVersion is not a valid stand-in set part");
  return sha256HexOf(new TextEncoder().encode(`${SET_DOMAIN}${canonicalJson({ images, seeds, generatorVersion, answerSets })}`));
}

/**
 * The settings fingerprint of a measurement made against a stand-in set: the approved fingerprint (`evalSettingsFingerprintOf` without a version) bound with the version. With no version it returns the fingerprint unchanged, so
 * every eval without stand-ins keeps its key. Throws RangeError for a fingerprint or a version that is not 64 hex characters.
 */
export function standInSettingsFingerprint(settingsFingerprint: string, version: string | undefined): string {
  if (typeof settingsFingerprint !== "string" || !HEX.test(settingsFingerprint)) throw new RangeError("the settings fingerprint is not valid");
  if (version === undefined) return settingsFingerprint;
  if (!isStandInSetVersion(version)) throw new RangeError("the standInSetVersion is not valid");
  return sha256HexOf(new TextEncoder().encode(`${SETTINGS_DOMAIN}${settingsFingerprint}\n${version}`));
}
