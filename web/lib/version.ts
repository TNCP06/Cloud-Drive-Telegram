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
