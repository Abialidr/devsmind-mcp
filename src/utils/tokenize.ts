/**
 * Shared tokenization for search-nodes' fuzzy ranking AND the description-quality gate at
 * commit time. Both need the SAME splitting logic — if the gate accepted a description using
 * one definition of "new word" while search matched using another, a description could pass
 * validation and still be invisible to search. One pipeline, two callers.
 */

/**
 * English function words + generic dev-question filler that carry no search signal on their
 * own. A natural-language query like "where do we handle user login" is mostly this — without
 * filtering it, short tokens like "we"/"do"/"is" substring-match dozens of unrelated
 * identifiers and bury the one real match under noise.
 */
const STOPWORDS = new Set([
  // function words
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing',
  'has', 'have', 'had', 'having', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
  'about', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'then',
  'so', 'not', 'no', 'yes', 'than', 'too', 'very', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'must', 'shall', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'our', 'your', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'just', 'also',
  // generic dev-question / filler words that name no specific thing
  'find', 'get', 'gets', 'set', 'sets', 'use', 'uses', 'used', 'using', 'handle', 'handles',
  'handled', 'handling', 'implement', 'implements', 'implementation', 'code', 'function',
  'method', 'logic', 'thing', 'things', 'something', 'anything', 'page', 'file'
]);

/**
 * Splits camelCase / PascalCase / snake_case / kebab-case / dotted identifiers and paths into
 * lowercase word fragments — "verifyCredentials" -> ["verify","credentials"],
 * "pages/product-detail" -> ["pages","product","detail"]. This is what lets a query token match
 * a WORD inside a compound identifier rather than only a raw substring.
 */
export function splitIdentifier(text: string): string[] {
  if (!text) return [];
  return text
    // camelCase boundary: lower/digit -> Upper ("verifyCredentials" -> "verify Credentials")
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // acronym boundary: a run of Upper followed by Upper+lower ("XMLParser" -> "XML Parser")
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(s => s.toLowerCase())
    .filter(Boolean);
}

/**
 * Light suffix stemming so "logins"/"logged"/"validated" collapse onto the same token as
 * "login"/"validate". Deliberately crude — a handful of suffix rules, no dictionary, no real
 * morphology — good enough to close the common inflection gap between a query and a
 * description without pulling in a stemming dependency.
 */
export function stem(token: string): string {
  if (token.length <= 4) return token; // too short to safely strip anything
  if (token.endsWith('ies') && token.length > 5) return token.slice(0, -3) + 'y';
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('tion') && token.length > 6) return token.slice(0, -4);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 4) return token.slice(0, -1);
  return token;
}

/**
 * Full pipeline for natural-language text — queries, descriptions, reasoning: lowercase, split
 * on non-alphanumeric, drop stopwords and anything under 3 chars, stem. Order matters: filtering
 * short/stop tokens BEFORE stemming means stemming never has to special-case them.
 */
export function tokenizeText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Tokenization for identifiers/paths specifically: split on case/separator boundaries first,
 * THEN run the identical stopword+stem pipeline used for natural-language text, so a query
 * token and an identifier fragment that mean the same thing collapse to the same string.
 */
export function tokenizeIdentifier(text: string): string[] {
  return tokenizeText(splitIdentifier(text).join(' '));
}

export interface DescriptionValidation {
  ok: boolean;
  error?: string;
}

const MIN_DESCRIPTION_LENGTH = 40;

/**
 * Rejects the two laziest failure modes of an AI-written description: too short to carry real
 * information, or merely restating the identifier's own words back. "verifyCredentials" ->
 * "verifies credentials" tokenizes to a subset of the identifier's own tokens — it satisfies
 * any naive length check while adding nothing a search query wouldn't already find via the
 * identifier itself. Rejecting it is what keeps the commit-time gate from being satisfied by
 * pure compliance instead of actual searchable value.
 */
export function validateDescription(description: string, identifierSource: string): DescriptionValidation {
  const trimmed = (description || '').trim();
  if (trimmed.length < MIN_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description too short (${trimmed.length} chars, need at least ${MIN_DESCRIPTION_LENGTH}). Write 1-3 sentences of real purpose, not a label.`
    };
  }
  const identifierTokens = new Set(tokenizeIdentifier(identifierSource));
  const descriptionTokens = new Set(tokenizeText(trimmed));
  const newTokens = Array.from(descriptionTokens).filter(t => !identifierTokens.has(t));
  if (identifierTokens.size > 0 && newTokens.length === 0) {
    return {
      ok: false,
      error: `Description only restates the identifier's own words ("${identifierSource}") — it adds no vocabulary a search query wouldn't already find via the name itself. Describe what it actually DOES and the domain concepts involved, using terms someone might search by.`
    };
  }
  return { ok: true };
}
