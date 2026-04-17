import {
  arabicSimilarity,
  getArabicWordVariants,
  normalizeArabic,
} from './arabicNormalize.js';

export const DEFAULTS = {
  similarityThreshold: 0.78,
  shortTokenLen: 5,
  maxLevForShortToken: 1,
  maxAlignmentExpectedWindow: 8,
};

function toVariantList(token) {
  if (Array.isArray(token)) {
    return token.map(value => normalizeArabic(value)).filter(Boolean);
  }

  return getArabicWordVariants(token);
}

export function normalizeToken(token) {
  return toVariantList(token);
}

export function normalizeWords(words) {
  return (words ?? []).map(normalizeToken);
}

export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 0; i < a.length; i += 1) {
    current[0] = i + 1;

    for (let j = 0; j < b.length; j += 1) {
      const substitutionCost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + substitutionCost,
      );
    }

    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

export function quickReject(a, b) {
  if (!a || !b) return true;

  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return false;
  if (Math.abs(a.length - b.length) / maxLength > 0.5) return true;

  if (a.charAt(0) === b.charAt(0)) return false;

  const aHasArticle = a.length > 3 && a.startsWith('ال');
  const bHasArticle = b.length > 3 && b.startsWith('ال');
  return !(aHasArticle || bHasArticle);
}

export function isApproximateMatch(expectedToken, recognizedToken, options = {}) {
  const similarityThreshold = options.similarityThreshold ?? DEFAULTS.similarityThreshold;
  const shortTokenLen = options.shortTokenLen ?? DEFAULTS.shortTokenLen;
  const maxLevForShortToken = options.maxLevForShortToken ?? DEFAULTS.maxLevForShortToken;

  const expectedVariants = toVariantList(expectedToken);
  const recognizedVariants = toVariantList(recognizedToken);

  for (const expected of expectedVariants) {
    for (const recognized of recognizedVariants) {
      if (!expected || !recognized) continue;
      if (expected === recognized) return true;
      if (quickReject(expected, recognized)) continue;

      const distance = levenshteinDistance(expected, recognized);
      const minLength = Math.min(expected.length, recognized.length) || 1;
      const maxLength = Math.max(expected.length, recognized.length) || 1;
      const lengthGap = maxLength - minLength;

      if (lengthGap >= 2) continue;

      if (1 - distance / minLength >= similarityThreshold) {
        return true;
      }

      const sameFirst = expected.charAt(0) === recognized.charAt(0);
      const sameLast =
        expected.length > 2 &&
        recognized.length > 2 &&
        expected.charAt(expected.length - 1) === recognized.charAt(recognized.length - 1);

      if (
        maxLength <= shortTokenLen &&
        distance <= maxLevForShortToken &&
        lengthGap <= 1 &&
        sameFirst
      ) {
        return true;
      }

      const directSimilarity = arabicSimilarity(expected, recognized);
      if (directSimilarity >= Math.max(similarityThreshold, 0.82) && sameFirst && sameLast) {
        return true;
      }
    }
  }

  return false;
}

function getCanonicalToken(token) {
  const variants = toVariantList(token);
  return variants[0] ?? '';
}

export function alignAndReveal(recognizedWords, expectedWords, options = {}) {
  const expectedWindow = Math.min(
    Math.max(4, options.maxAlignmentExpectedWindow ?? DEFAULTS.maxAlignmentExpectedWindow),
    expectedWords.length,
  );
  const expected = expectedWords.slice(0, expectedWindow);
  const recognized = recognizedWords;
  const rows = recognized.length + 1;
  const cols = expected.length + 1;

  if (expected.length === 0 || recognized.length === 0) {
    return {
      matchedIndices: [],
      revealIndices: [],
      anchorIndices: [],
      firstMatchedIndex: -1,
      consumed: 0,
      operations: [],
    };
  }

  const scores = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => Number.POSITIVE_INFINITY),
  );
  const backtrack = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );

  scores[0][0] = 0;

  for (let row = 0; row <= recognized.length; row += 1) {
    for (let col = 0; col <= expected.length; col += 1) {
      const current = scores[row][col];
      if (!Number.isFinite(current)) continue;

      if (row < recognized.length && current + 1 < scores[row + 1][col]) {
        scores[row + 1][col] = current + 1;
        backtrack[row + 1][col] = {
          prevRow: row,
          prevCol: col,
          operation: 'ignore-spoken',
        };
      }

      if (col < expected.length && current + 1 < scores[row][col + 1]) {
        scores[row][col + 1] = current + 1;
        backtrack[row][col + 1] = {
          prevRow: row,
          prevCol: col,
          operation: 'skip-expected',
        };
      }

      if (row < recognized.length && col < expected.length) {
        const isMatch = isApproximateMatch(expected[col], recognized[row], options);
        const nextCost = current + (isMatch ? 0 : 1);

        if (nextCost <= scores[row + 1][col + 1]) {
          scores[row + 1][col + 1] = nextCost;
          backtrack[row + 1][col + 1] = {
            prevRow: row,
            prevCol: col,
            operation: isMatch ? 'match' : 'mistake',
          };
        }
      }
    }
  }

  let bestColumn = 0;
  let bestScore = scores[recognized.length][0];
  for (let col = 1; col <= expected.length; col += 1) {
    if (scores[recognized.length][col] < bestScore) {
      bestScore = scores[recognized.length][col];
      bestColumn = col;
    }
  }

  const operations = [];
  let row = recognized.length;
  let col = bestColumn;

  while (row > 0 || col > 0) {
    const step = backtrack[row][col];
    if (!step) break;

    operations.unshift({
      operation: step.operation,
      recogIndex: row - 1,
      expectedIndex: col - 1,
    });

    row = step.prevRow;
    col = step.prevCol;
  }

  const matchedIndices = operations
    .filter(step => step.operation === 'match')
    .map(step => step.expectedIndex);
  const matchedSet = new Set(matchedIndices);

  const revealIndices = [];
  let revealIndex = 0;
  while (matchedSet.has(revealIndex)) {
    revealIndices.push(revealIndex);
    revealIndex += 1;
  }

  const firstMatchedIndex = matchedIndices.length ? matchedIndices[0] : -1;
  const anchorIndices = [];
  if (firstMatchedIndex >= 0) {
    let anchorIndex = firstMatchedIndex;
    while (matchedSet.has(anchorIndex)) {
      anchorIndices.push(anchorIndex);
      anchorIndex += 1;
    }
  }

  const anchorLimit = anchorIndices.length
    ? anchorIndices[anchorIndices.length - 1]
    : revealIndices.length
      ? revealIndices[revealIndices.length - 1]
      : -1;

  const consumedMatches = operations
    .filter(step => step.operation === 'match' && step.expectedIndex <= anchorLimit)
    .map(step => step.recogIndex);

  return {
    matchedIndices,
    revealIndices,
    anchorIndices,
    firstMatchedIndex,
    consumed: consumedMatches.length ? Math.max(...consumedMatches) + 1 : 0,
    operations,
  };
}

export function phraseSnap(recognizedWords, expectedWords, minWords = 1, maxWords = 5) {
  const recognizedPhrase = recognizedWords
    .map(getCanonicalToken)
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!recognizedPhrase) {
    return { revealIndices: [], consumed: 0 };
  }

  const upperBound = Math.min(expectedWords.length, maxWords);
  for (let length = upperBound; length >= Math.max(1, minWords); length -= 1) {
    const expectedPhrase = expectedWords
      .slice(0, length)
      .map(getCanonicalToken)
      .join(' ');

    if (expectedPhrase && recognizedPhrase.includes(expectedPhrase)) {
      return {
        revealIndices: Array.from({ length }, (_, index) => index),
        consumed: length,
      };
    }
  }

  return { revealIndices: [], consumed: 0 };
}
