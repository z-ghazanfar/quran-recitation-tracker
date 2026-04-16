const ARABIC_DIACRITICS_RE = /(?:[\u0610-\u061A]|[\u064B-\u065F]|\u0670|[\u06D6-\u06DC]|[\u06DF-\u06E8]|[\u06EA-\u06ED])/gu;
const ZERO_WIDTH_RE = /(?:\u200B|\u200C|\u200D|\u200E|\u200F|\uFEFF)/gu;
const NON_ARABIC_CONTENT_RE = /[^\p{Script=Arabic}\p{Number}\s]/gu;
const SPACE_RE = /\s+/gu;

/**
 * Normalize Arabic text for comparison purposes.
 * Used on BOTH the expected word (text_imlaei_simple from quran.com) and the
 * spoken word (from Web Speech API) so they can be compared consistently.
 *
 * text_imlaei_simple is already diacritic-free, so normalization mainly handles:
 *  - Alef variants (أ إ آ ٱ → ا)
 *  - Ta marbuta (ة → ه)
 *  - Alef maqsura (ى → ي)
 *  - Punctuation and transcript artifacts from the browser speech engine
 */
export function normalizeArabic(text) {
  if (!text) return '';

  return text
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/\u0640/gu, '')
    .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
    .replace(/\u0629/gu, '\u0647')
    .replace(/\u0649/gu, '\u064A')
    .replace(/[\u0624\u0626]/gu, '\u0621')
    .replace(ZERO_WIDTH_RE, '')
    .replace(NON_ARABIC_CONTENT_RE, ' ')
    .replace(SPACE_RE, ' ')
    .trim();
}

/**
 * Loose match: strip ALL alef characters from both strings then compare.
 * Handles spelling variants like الرحمن / الرحمان that differ only in
 * whether an optional alef is written (common in Arabic orthography).
 */
export function looseMatch(a, b) {
  const strip = s => s.replace(/\u0627/g, '');
  return strip(a) === strip(b);
}

/**
 * Split an Arabic text string into individual word tokens.
 */
export function splitIntoWords(text) {
  return normalizeArabic(text)
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    let nextDiagonal = prev[0];
    prev[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        nextDiagonal + cost,
      );
      nextDiagonal = temp;
    }
  }

  return prev[b.length];
}

/**
 * Soft similarity helps when the speech engine drops or adds a single letter.
 */
export function arabicSimilarity(a, b) {
  if (!a || !b) return 0;

  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (!na || !nb) return 0;
  if (na === nb || looseMatch(na, nb)) return 1;

  const maxLength = Math.max(na.length, nb.length);
  if (maxLength <= 2) return 0;

  const distance = levenshteinDistance(na, nb);
  return 1 - distance / maxLength;
}
