// Split an archive title into "family" (base name) + version label.
// Used to group multiple versions of the same archive in the UI.
// Example: "ReRudy 0.6.0" -> { family: "ReRudy", version: "v0.6.0" }
//          "Mayfly v0.2 (Reset)" -> { family: "Mayfly (Reset)"-ish, version: "v0.2" }
//          "MythofSlayer Ch.9" -> { family: "MythofSlayer", version: "Ch.9" }

// Version tokens: v/ver/version + number, or X.Y(.Z), or Ch./Ep. + number.
const VER_TOKEN =
  /(v(?:er(?:sion)?)?[ ._]?\d+(?:\.\d+)*[a-z]?|\d+\.\d+(?:\.\d+)*[a-z]?|(?:ch|ep|chapter|episode)\.?\s*\d+)/i;

export interface TitleParts {
  family: string;        // display name
  familyKey: string;     // grouping key (lowercase)
  version: string | null; // version label for display, e.g. "v0.6.0"
}

export function parseTitle(name: string): TitleParts {
  const m = name.match(VER_TOKEN);
  if (!m || m.index == null) {
    const t = name.trim();
    return { family: t, familyKey: t.toLowerCase(), version: null };
  }

  const raw = m[0].trim();
  let version = raw.replace(/^v(?:er(?:sion)?)?[ ._]?/i, "v");
  if (/^\d/.test(version)) version = "v" + version; // "0.6.0" -> "v0.6.0"

  // family = title without the version token; clean up leftover separators.
  let family = (name.slice(0, m.index) + " " + name.slice(m.index + raw.length))
    .replace(/[-_]+/g, " ")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  family = family.replace(/[-_( \[]+$/, "").trim() || name.trim();

  return { family, familyKey: family.toLowerCase(), version };
}

// Map common video quality tokens to vertical pixel height
const QUALITY_MAP: Record<string, number> = {
  "4k": 2160, "2160": 2160, "2160p": 2160,
  "2k": 1440, "1440": 1440, "1440p": 1440,
  "1k": 1080, "1080": 1080, "1080p": 1080, "1080p60": 1080,
  "720": 720, "720p": 720, "720p60": 720,
  "540": 540, "540p": 540,
  "480": 480, "480p": 480,
  "360": 360, "360p": 360,
  "240": 240, "240p": 240,
  "144": 144, "144p": 144,
};

// Matches quality token at the end of title (optionally before video extension or inside brackets/parens)
// Examples: "Youjo Senki S2 - 11.1K" -> 1080p, "Youjo Senki S2 - 11.720.mp4" -> 720p
export const QUALITY_TOKEN =
  /(?:[\s._\-\[\(]+)(2160p?(?:60)?|1440p?(?:60)?|1080p?(?:60)?|720p?(?:60)?|540p?|480p?|360p?|240p?|144p?|4k|2k|1k)(?:[\s._\-\]\)]*)(?:\.(?:mp4|mkv|webm|avi|mov|flv|ts|m4v))?$/i;

export interface MediaQualityParts {
  family: string;
  familyKey: string;
  quality: number | null;
  qualityLabel: string | null;
  version: string | null;
}

export function parseMediaQuality(
  name: string,
  folderId?: number | null,
  fallbackSlug?: string
): MediaQualityParts {
  const m = name.match(QUALITY_TOKEN);
  if (!m || m.index == null) {
    const t = name.trim();
    return {
      family: t,
      familyKey: fallbackSlug ? String(fallbackSlug) : t.toLowerCase(),
      quality: null,
      qualityLabel: null,
      version: null,
    };
  }

  const raw = m[1].toLowerCase();
  const qNum = QUALITY_MAP[raw] ?? null;
  const qLabel = qNum ? `${qNum}p` : raw.toUpperCase();

  let family = name.slice(0, m.index).trim();
  family = family.replace(/[-_( \[]+$/, "").trim() || name.trim();

  const folderScope = folderId != null ? `f${folderId}:` : "root:";
  const familyKey = `${folderScope}${family.toLowerCase()}`;

  return {
    family,
    familyKey,
    quality: qNum,
    qualityLabel: qLabel,
    version: qLabel,
  };
}

