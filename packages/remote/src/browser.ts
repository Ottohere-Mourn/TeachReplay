// Browser-target parsing and URL safety for the remote backend.
// Behavior-compatible with the host-harness helpers TeachReplay v0.1
// used inside OpenMausBot (Apache-2.0, server/computer-observation.ts);
// independent implementation so this package keeps zero harness deps.

export interface BrowserTarget {
  id: string;
  title: string;
  /** Safe for a model or log: credentials, query, and fragment removed. */
  url: string;
  /** Internal-only comparison value. */
  comparisonUrl: string;
}

/** Canonical value for navigation checks. Credentials removed; query and
 * fragment remain so two distinct application states cannot verify as
 * the same destination. */
export function normalizeBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Removes credentials, query, and fragment before browser state reaches
 * a model or log. */
export function safeBrowserUrl(value: unknown): string | null {
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.search = "";
  url.hash = "";
  const safe = url.toString();
  return safe.length <= 2_048 ? safe : null;
}

/** Parses Chrome's /json/list response into small, safe targets. */
export function parseBrowserTargets(raw: string): BrowserTarget[] {
  if (raw.length > 1_000_000) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const comparisonUrl = normalizeBrowserUrl(value.url);
      const url = safeBrowserUrl(value.url);
      if (value.type !== "page" || !url || !comparisonUrl || typeof value.id !== "string") return [];
      const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      return [{ id: value.id.slice(0, 100), title, url, comparisonUrl }];
    });
  } catch {
    return [];
  }
}
