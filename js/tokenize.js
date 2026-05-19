// Shared text normalization. Build pipeline and runtime MUST import this same
// module — drift between build-time and query-time tokenization silently
// breaks search matching.

/**
 * Normalize a string into a list of search tokens:
 *   - NFD decompose + strip combining marks (Café → Cafe)
 *   - lowercase
 *   - split on any char that is not a Unicode letter or number
 *   - drop tokens shorter than 2 chars
 *
 * @param {string} s
 * @returns {string[]}
 */
export function normalize(s) {
  if (!s) return [];
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Keyword → category mapping used by the discovery lane (PR 5 fills this in).
 * Kept here so build-time and runtime can use the same source if needed.
 *
 * @type {Map<string, { cat: string, hint?: string }>}
 */
export const CATEGORY_KEYWORDS = new Map();
