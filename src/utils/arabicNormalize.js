const ARABIC_DIACRITICS_RE = /(?:[\u0610-\u061A]|[\u064B-\u065F]|\u0670|[\u06D6-\u06DC]|[\u06DF-\u06E8]|[\u06EA-\u06ED])/gu;
const ALEF_FORMS_RE = /[أإآٱٲٳٵ]/gu;
const ALEF_MAKSURA_RE = /ى/gu;
const TA_MARBUTA_RE = /ة/gu;
const HAMZA_CARRIERS_RE = /[ؤئ]/gu;
const TATWEEL_RE = /ـ/gu;
const SMALL_WAW_RE = /\u06E5/gu;
const SMALL_YA_RE = /\u06E6/gu;
const ZERO_WIDTH_RE = /(?:\u200B|\u200C|\u200D|\u200E|\u200F|\uFEFF)/gu;
const EASTERN_NUMERALS_RE = /[٠-٩]/gu;
const NON_ARABIC_CONTENT_RE = /[^\p{Script=Arabic}\p{Number}\s]/gu;
const SPACE_RE = /\s+/gu;

const WESTERN_DIGITS = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

const PREFIX_TOKENS = new Set(['و', 'ف', 'ب', 'ل', 'ك', 'س']);

const VARIATION_GROUPS = [
  ['ذلك', 'ذالك'],
  ['هذا', 'هاذا'],
  ['الرحمن', 'الرحمان'],
  ['لكن', 'لاكن'],
  ['اله', 'الاه'],
  ['الهه', 'الهة'],
  ['الصلاه', 'الصلوه', 'الصلوة', 'الصلات'],
  ['صلاه', 'صلوه', 'صلوة', 'صلات'],
  ['الزكاه', 'الزكوه', 'الزكوة'],
  ['الحياه', 'الحيوه'],
  ['رحمه', 'رحمت'],
  ['نعمه', 'نعمت'],
  ['شي', 'شيء', 'شئ'],
  ['ايه', 'ايه', 'ايه'],
  ['الضالين', 'الضالين', 'الضالين'],
  ['يس', 'ياسين'],
  ['طه', 'طاها'],
  ['حم', 'حاميم'],
  ['الم', 'الف لام ميم'],
  ['الر', 'الف لام را'],
];

const variationLookup = new Map();
const variantCache = new Map();

for (const group of VARIATION_GROUPS) {
  const normalizedGroup = Array.from(
    new Set(group.map(value => baseNormalize(value)).filter(Boolean)),
  );

  for (const value of normalizedGroup) {
    variationLookup.set(value, normalizedGroup);
  }
}

function baseNormalize(text) {
  if (!text) return '';

  return String(text)
    .normalize('NFKC')
    .replace(EASTERN_NUMERALS_RE, digit => WESTERN_DIGITS[digit] ?? digit)
    .replace(SMALL_WAW_RE, '')
    .replace(SMALL_YA_RE, '')
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(TATWEEL_RE, '')
    .replace(ALEF_FORMS_RE, 'ا')
    .replace(ALEF_MAKSURA_RE, 'ي')
    .replace(TA_MARBUTA_RE, 'ه')
    .replace(HAMZA_CARRIERS_RE, 'ء')
    .replace(ZERO_WIDTH_RE, '')
    .replace(NON_ARABIC_CONTENT_RE, ' ')
    .replace(SPACE_RE, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const nextDiagonal = previous[j];
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + substitutionCost,
      );
      diagonal = nextDiagonal;
    }
  }

  return previous[b.length];
}

function collapsePrefixTokens(tokens) {
  const collapsed = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (
      PREFIX_TOKENS.has(token) &&
      nextToken &&
      nextToken.length > 1
    ) {
      collapsed.push(`${token}${nextToken}`);
      index += 1;
      continue;
    }

    collapsed.push(token);
  }

  return collapsed;
}

function addGenericVariants(variants, normalized) {
  if (normalized.includes('اء')) {
    variants.add(normalized.replace(/اء/gu, 'ء'));
  }

  if (normalized.includes('ء')) {
    variants.add(normalized.replace(/ء/gu, ''));
    variants.add(normalized.replace(/ء/gu, 'اء'));
  }

  if (normalized.startsWith('ءا')) {
    variants.add(normalized.slice(1));
  }

  if (normalized.startsWith('ا') && !normalized.startsWith('ال')) {
    variants.add(`ء${normalized}`);
  }

  if (normalized.endsWith('يا') && !normalized.includes('ء')) {
    variants.add(`${normalized.slice(0, -1)}ي`);
  }

  if (normalized.startsWith('ال') && normalized.length > 3) {
    variants.add(normalized.slice(2));
  } else if (
    normalized.length >= 3 &&
    !normalized.startsWith('يا') &&
    !normalized.startsWith('ء') &&
    !normalized.startsWith('ال')
  ) {
    variants.add(`ال${normalized}`);
  }
}

/**
 * Normalize Arabic text into a stable comparison form.
 */
export function normalizeArabic(text) {
  return baseNormalize(text);
}

/**
 * Expand a word into Quran-friendly spelling variants.
 */
export function getArabicWordVariants(text) {
  const normalized = baseNormalize(text);
  if (!normalized) return [];

  const cached = variantCache.get(normalized);
  if (cached) return cached;

  const variants = new Set([normalized]);
  const knownGroup = variationLookup.get(normalized);
  if (knownGroup) {
    for (const value of knownGroup) {
      variants.add(value);
    }
  }

  addGenericVariants(variants, normalized);

  const expanded = Array.from(
    new Set(
      Array.from(variants)
        .map(value => baseNormalize(value))
        .filter(Boolean),
    ),
  );

  variantCache.set(normalized, expanded);
  return expanded;
}

/**
 * Loose match: compare after dropping plain alef and expanding common variants.
 */
export function looseMatch(a, b) {
  const stripAlef = value => baseNormalize(value).replace(/ا/gu, '');
  const aVariants = getArabicWordVariants(a);
  const bVariants = getArabicWordVariants(b);

  for (const aVariant of aVariants) {
    for (const bVariant of bVariants) {
      if (aVariant === bVariant || stripAlef(aVariant) === stripAlef(bVariant)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Split Arabic text into comparison tokens.
 * Prefixes like "و الله" are collapsed to "والله" to better match Quran text.
 */
export function splitIntoWords(text) {
  const normalized = baseNormalize(text);
  if (!normalized) return [];

  const tokens = normalized
    .split(/\s+/u)
    .map(token => token.trim())
    .filter(Boolean);

  return collapsePrefixTokens(tokens);
}

function quickReject(a, b) {
  if (!a || !b) return true;

  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return false;
  if (Math.abs(a.length - b.length) / maxLength > 0.5) return true;

  const firstA = a[0];
  const firstB = b[0];
  if (firstA === firstB) return false;

  const aHasArticle = a.length > 3 && a.startsWith('ال');
  const bHasArticle = b.length > 3 && b.startsWith('ال');
  return !(aHasArticle || bHasArticle);
}

/**
 * Soft similarity for ASR drift and Quran spelling variants.
 */
export function arabicSimilarity(a, b) {
  const aVariants = getArabicWordVariants(a);
  const bVariants = getArabicWordVariants(b);
  let best = 0;

  for (const aVariant of aVariants) {
    for (const bVariant of bVariants) {
      if (aVariant === bVariant) return 1;

      if (quickReject(aVariant, bVariant)) continue;

      const maxLength = Math.max(aVariant.length, bVariant.length);
      if (maxLength <= 2) continue;

      const distance = levenshteinDistance(aVariant, bVariant);
      const similarity = 1 - distance / maxLength;
      if (similarity > best) {
        best = similarity;
      }
    }
  }

  return best;
}
