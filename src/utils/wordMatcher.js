import { arabicSimilarity, looseMatch, normalizeArabic } from './arabicNormalize.js';

export const WORD_STATE = {
  PENDING: 'pending',
  CORRECT: 'correct',
  MISTAKE: 'mistake',
  SKIPPED: 'skipped',
  CURRENT: 'current',
};

const EXPECTED_WINDOW = 12;
const REANCHOR_WINDOW = 160;
const REVIEW_WINDOW = 40;
const MAX_REANCHOR_SPOKEN_OFFSET = 2;
const MIN_REANCHOR_MATCHES = 3;
const MAX_LEADING_OVERLAP = 3;
const MATCH_REWARD = 3;
const FUZZY_MATCH_REWARD = 2.15;
const SUBSTITUTION_PENALTY = -0.6;
const SPOKEN_INSERTION_PENALTY = -0.35;
const EXPECTED_SKIP_PENALTY = -0.8;
const NO_ALIGNMENT = null;

function getMatchQuality(expected, spoken) {
  const normalizedExpected = normalizeArabic(expected);
  const normalizedSpoken = normalizeArabic(spoken);

  if (!normalizedExpected || !normalizedSpoken) return 0;
  if (normalizedExpected === normalizedSpoken) return 1;
  if (looseMatch(normalizedExpected, normalizedSpoken)) return 0.96;

  const similarity = arabicSimilarity(normalizedExpected, normalizedSpoken);
  return similarity >= 0.72 ? similarity : 0;
}

function createScore(score = Number.NEGATIVE_INFINITY, matches = 0, consumed = 0) {
  return { score, matches, consumed };
}

function isBetterCandidate(candidate, current) {
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.matches !== current.matches) return candidate.matches > current.matches;
  return candidate.consumed > current.consumed;
}

function selectBestEndpoint(scores) {
  let best = createScore(0, 0, 0);

  for (let spokenIndex = 0; spokenIndex < scores.length; spokenIndex++) {
    for (let expectedIndex = 0; expectedIndex < scores[spokenIndex].length; expectedIndex++) {
      const candidate = scores[spokenIndex][expectedIndex];
      if (isBetterCandidate(candidate, best)) {
        best = { ...candidate, spokenIndex, expectedIndex };
      }
    }
  }

  if (best.matches === 0 || best.score <= 0) {
    return NO_ALIGNMENT;
  }

  return best;
}

function alignChunk(expectedWords, spokenWords) {
  const rows = spokenWords.length + 1;
  const cols = expectedWords.length + 1;
  const scores = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => createScore())
  );
  const backtrack = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null)
  );

  scores[0][0] = createScore(0, 0, 0);

  for (let spokenIndex = 0; spokenIndex <= spokenWords.length; spokenIndex++) {
    for (let expectedIndex = 0; expectedIndex <= expectedWords.length; expectedIndex++) {
      const current = scores[spokenIndex][expectedIndex];
      if (current.score === Number.NEGATIVE_INFINITY) continue;

      if (spokenIndex < spokenWords.length) {
        const insertion = createScore(
          current.score + SPOKEN_INSERTION_PENALTY,
          current.matches,
          expectedIndex,
        );

        if (isBetterCandidate(insertion, scores[spokenIndex + 1][expectedIndex])) {
          scores[spokenIndex + 1][expectedIndex] = insertion;
          backtrack[spokenIndex + 1][expectedIndex] = {
            prevSpoken: spokenIndex,
            prevExpected: expectedIndex,
            operation: 'ignore-spoken',
          };
        }
      }

      if (expectedIndex < expectedWords.length) {
        const deletion = createScore(
          current.score + EXPECTED_SKIP_PENALTY,
          current.matches,
          expectedIndex + 1,
        );

        if (isBetterCandidate(deletion, scores[spokenIndex][expectedIndex + 1])) {
          scores[spokenIndex][expectedIndex + 1] = deletion;
          backtrack[spokenIndex][expectedIndex + 1] = {
            prevSpoken: spokenIndex,
            prevExpected: expectedIndex,
            operation: 'skip-expected',
          };
        }
      }

      if (spokenIndex < spokenWords.length && expectedIndex < expectedWords.length) {
        const quality = getMatchQuality(expectedWords[expectedIndex], spokenWords[spokenIndex]);
        const isMatch = quality > 0;
        const pair = createScore(
          current.score + (isMatch ? (quality >= 0.9 ? MATCH_REWARD : FUZZY_MATCH_REWARD) : SUBSTITUTION_PENALTY),
          current.matches + (isMatch ? 1 : 0),
          expectedIndex + 1,
        );

        if (isBetterCandidate(pair, scores[spokenIndex + 1][expectedIndex + 1])) {
          scores[spokenIndex + 1][expectedIndex + 1] = pair;
          backtrack[spokenIndex + 1][expectedIndex + 1] = {
            prevSpoken: spokenIndex,
            prevExpected: expectedIndex,
            operation: isMatch ? 'match' : 'mistake',
          };
        }
      }
    }
  }

  const endpoint = selectBestEndpoint(scores);
  if (!endpoint) return NO_ALIGNMENT;

  const operations = [];
  let spokenIndex = endpoint.spokenIndex;
  let expectedIndex = endpoint.expectedIndex;

  while (spokenIndex > 0 || expectedIndex > 0) {
    const step = backtrack[spokenIndex][expectedIndex];
    if (!step) break;

    operations.push({
      operation: step.operation,
      spokenIndex: spokenIndex - 1,
      expectedIndex: expectedIndex - 1,
    });

    spokenIndex = step.prevSpoken;
    expectedIndex = step.prevExpected;
  }

  operations.reverse();

  return {
    operations,
    consumedExpected: endpoint.expectedIndex,
    matchCount: endpoint.matches,
  };
}

function applyAlignment(states, baseIndex, expectedWordsLength, alignment) {
  for (const step of alignment.operations) {
    const targetIndex = baseIndex + step.expectedIndex;
    if (targetIndex < baseIndex || targetIndex >= expectedWordsLength) continue;

    if (step.operation === 'match') {
      states[targetIndex] = WORD_STATE.CORRECT;
      continue;
    }

    if (step.operation === 'mistake' && states[targetIndex] === WORD_STATE.PENDING) {
      states[targetIndex] = WORD_STATE.MISTAKE;
      continue;
    }

    if (step.operation === 'skip-expected' && states[targetIndex] === WORD_STATE.PENDING) {
      states[targetIndex] = WORD_STATE.SKIPPED;
    }
  }
}

function getHeardWordIndexes(baseIndex, alignment) {
  const heardWordIndexes = [];

  for (const step of alignment.operations) {
    if (
      (step.operation === 'match' || step.operation === 'mistake') &&
      step.expectedIndex >= 0
    ) {
      heardWordIndexes.push(baseIndex + step.expectedIndex);
    }
  }

  return heardWordIndexes;
}

function buildIndexRange(start, length) {
  return Array.from({ length }, (_, index) => start + index);
}

function getLeadingSkippedCount(alignment) {
  let count = 0;

  for (const step of alignment.operations) {
    if (step.operation === 'skip-expected') {
      count += 1;
      continue;
    }

    if (step.operation === 'ignore-spoken') {
      continue;
    }

    break;
  }

  return count;
}

function getContiguousRun(expectedWords, expectedStart, spokenWords, spokenStart) {
  let runLength = 0;
  let qualitySum = 0;

  while (
    expectedStart + runLength < expectedWords.length &&
    spokenStart + runLength < spokenWords.length
  ) {
    const quality = getMatchQuality(
      expectedWords[expectedStart + runLength],
      spokenWords[spokenStart + runLength],
    );

    if (quality <= 0) break;
    runLength += 1;
    qualitySum += quality;
  }

  return { runLength, qualitySum };
}

function isBetterReanchor(candidate, current) {
  if (!current) return true;
  if (candidate.runLength !== current.runLength) return candidate.runLength > current.runLength;
  if (candidate.qualitySum !== current.qualitySum) return candidate.qualitySum > current.qualitySum;
  return candidate.expectedStart < current.expectedStart;
}

function isBetterReviewAnchor(candidate, current, currentIndex) {
  if (!current) return true;
  if (candidate.runLength !== current.runLength) return candidate.runLength > current.runLength;
  if (candidate.qualitySum !== current.qualitySum) return candidate.qualitySum > current.qualitySum;

  const candidateDistance = currentIndex - candidate.expectedStart;
  const currentDistance = currentIndex - current.expectedStart;
  if (candidateDistance !== currentDistance) return candidateDistance < currentDistance;

  return candidate.expectedStart > current.expectedStart;
}

function findReanchor(expectedWords, currentIndex, spokenWords) {
  const searchEnd = Math.min(expectedWords.length, currentIndex + REANCHOR_WINDOW);
  let best = null;

  for (let spokenStart = 0; spokenStart < Math.min(MAX_REANCHOR_SPOKEN_OFFSET, spokenWords.length); spokenStart++) {
    for (let expectedStart = currentIndex + 1; expectedStart < searchEnd; expectedStart++) {
      const { runLength, qualitySum } = getContiguousRun(
        expectedWords,
        expectedStart,
        spokenWords,
        spokenStart,
      );

      if (runLength < MIN_REANCHOR_MATCHES) continue;
      if (qualitySum / runLength < 0.88) continue;

      const candidate = {
        expectedStart,
        spokenStart,
        runLength,
        qualitySum,
      };

      if (isBetterReanchor(candidate, best)) {
        best = candidate;
      }
    }
  }

  return best;
}

function findReviewAnchor(expectedWords, currentIndex, spokenWords) {
  if (currentIndex <= 0 || spokenWords.length === 0) return null;

  const searchStart = Math.max(0, currentIndex - REVIEW_WINDOW);
  let best = null;

  for (let expectedStart = searchStart; expectedStart < currentIndex; expectedStart++) {
    const { runLength, qualitySum } = getContiguousRun(
      expectedWords,
      expectedStart,
      spokenWords,
      0,
    );

    if (runLength === 0) continue;
    if (qualitySum / runLength < 0.92) continue;

    const candidate = {
      expectedStart,
      runLength,
      qualitySum,
    };

    if (isBetterReviewAnchor(candidate, best, currentIndex)) {
      best = candidate;
    }
  }

  return best;
}

function hasCompetingNearbyAnchor(expectedWords, currentIndex, spokenWords, reanchor) {
  const nearbyStart = Math.max(0, currentIndex - 2);
  const nearbyEnd = Math.min(expectedWords.length, currentIndex + 3);

  for (let spokenStart = 0; spokenStart < Math.min(MAX_REANCHOR_SPOKEN_OFFSET, spokenWords.length); spokenStart++) {
    for (let expectedStart = nearbyStart; expectedStart < nearbyEnd; expectedStart++) {
      const { runLength, qualitySum } = getContiguousRun(
        expectedWords,
        expectedStart,
        spokenWords,
        spokenStart,
      );

      if (runLength < reanchor.runLength) continue;
      if (qualitySum / runLength < 0.88) continue;

      if (Math.abs(expectedStart - reanchor.expectedStart) > 2) {
        return true;
      }
    }
  }

  return false;
}

function applyReanchor(states, expectedWords, currentIndex, cleanedWords, reanchor) {
  for (let index = currentIndex; index < reanchor.expectedStart; index++) {
    if (states[index] === WORD_STATE.PENDING) {
      states[index] = WORD_STATE.SKIPPED;
    }
  }

  const reanchorSpokenWords = cleanedWords.slice(reanchor.spokenStart);
  const reanchorExpectedWords = expectedWords.slice(
    reanchor.expectedStart,
    reanchor.expectedStart + EXPECTED_WINDOW,
  );
  const reanchorAlignment = alignChunk(reanchorExpectedWords, reanchorSpokenWords);

  if (!reanchorAlignment || reanchorAlignment.matchCount < reanchor.runLength) {
    for (let offset = 0; offset < reanchor.runLength; offset++) {
      const targetIndex = reanchor.expectedStart + offset;
      states[targetIndex] = WORD_STATE.CORRECT;
    }

    return {
      states,
      heardWordIndexes: buildIndexRange(reanchor.expectedStart, reanchor.runLength),
      newIndex: reanchor.expectedStart + reanchor.runLength,
    };
  }

  applyAlignment(states, reanchor.expectedStart, expectedWords.length, reanchorAlignment);
  return {
    states,
    heardWordIndexes: getHeardWordIndexes(reanchor.expectedStart, reanchorAlignment),
    newIndex: reanchor.expectedStart + reanchorAlignment.consumedExpected,
  };
}

function trimLeadingOverlap(expectedWords, currentIndex, spokenWords) {
  const maxOverlap = Math.min(MAX_LEADING_OVERLAP, currentIndex, spokenWords.length);

  for (let overlap = maxOverlap; overlap >= 1; overlap--) {
    let matches = true;

    for (let offset = 0; offset < overlap; offset++) {
      const expected = expectedWords[currentIndex - overlap + offset];
      const spoken = spokenWords[offset];

      if (getMatchQuality(expected, spoken) < 0.96) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return spokenWords.slice(overlap);
    }
  }

  return spokenWords;
}

/**
 * Advance the pointer using an alignment against a short upcoming window.
 * This is more resilient to repeated transcripts, filler words, and minor ASR drift.
 */
export function matchSpokenWords(expectedWords, wordStates, currentIndex, spokenWords) {
  const states = [...wordStates];
  const normalizedSpokenWords = spokenWords.map(normalizeArabic).filter(Boolean);
  const reviewAnchor = findReviewAnchor(expectedWords, currentIndex, normalizedSpokenWords);
  const reviewWordIndexes = reviewAnchor
    ? buildIndexRange(reviewAnchor.expectedStart, reviewAnchor.runLength)
    : [];
  const cleanedWords = trimLeadingOverlap(
    expectedWords,
    currentIndex,
    normalizedSpokenWords,
  );
  if (cleanedWords.length === 0 || currentIndex >= expectedWords.length) {
    return {
      states,
      newIndex: currentIndex,
      heardWordIndexes: reviewWordIndexes,
    };
  }

  const windowWords = expectedWords.slice(currentIndex, currentIndex + EXPECTED_WINDOW);
  const alignment = alignChunk(windowWords, cleanedWords);
  if (!alignment) {
    const reanchor = findReanchor(expectedWords, currentIndex, cleanedWords);
    if (!reanchor) {
      return {
        states,
        newIndex: currentIndex,
        heardWordIndexes: reviewWordIndexes,
      };
    }

    return applyReanchor(states, expectedWords, currentIndex, cleanedWords, reanchor);
  }

  const skippedCount = alignment.operations.filter(step => step.operation === 'skip-expected').length;
  const mistakeCount = alignment.operations.filter(step => step.operation === 'mistake').length;
  const leadingSkippedCount = getLeadingSkippedCount(alignment);
  const reanchor = findReanchor(expectedWords, currentIndex, cleanedWords);
  const shortChunkOverskips =
    cleanedWords.length < 3 &&
    leadingSkippedCount > 2;

  if (shortChunkOverskips) {
    if (reanchor && reanchor.runLength >= MIN_REANCHOR_MATCHES && !hasCompetingNearbyAnchor(expectedWords, currentIndex, cleanedWords, reanchor)) {
      return applyReanchor(states, expectedWords, currentIndex, cleanedWords, reanchor);
    }

    return {
      states,
      newIndex: currentIndex,
      heardWordIndexes: reviewWordIndexes,
    };
  }

  if (reanchor) {
    const reanchorIsAmbiguous = hasCompetingNearbyAnchor(
      expectedWords,
      currentIndex,
      cleanedWords,
      reanchor,
    );
    const localAlignmentLooksWeak =
      alignment.matchCount < 2 ||
      skippedCount >= 3 ||
      mistakeCount >= 2;
    const reanchorIsClearlyBetter =
      reanchor.expectedStart > currentIndex + 2 &&
      reanchor.runLength >= Math.max(MIN_REANCHOR_MATCHES, alignment.matchCount + 1);

    if (localAlignmentLooksWeak && reanchorIsClearlyBetter && !reanchorIsAmbiguous) {
      return applyReanchor(states, expectedWords, currentIndex, cleanedWords, reanchor);
    }
  }

  if (alignment.matchCount < 2 && skippedCount > 2) {
    if (!reanchor || hasCompetingNearbyAnchor(expectedWords, currentIndex, cleanedWords, reanchor)) {
      return {
        states,
        newIndex: currentIndex,
        heardWordIndexes: reviewWordIndexes,
      };
    }

    return applyReanchor(states, expectedWords, currentIndex, cleanedWords, reanchor);
  }

  applyAlignment(states, currentIndex, expectedWords.length, alignment);

  return {
    states,
    heardWordIndexes: getHeardWordIndexes(currentIndex, alignment),
    newIndex: currentIndex + alignment.consumedExpected,
  };
}

/**
 * Build an initial all-pending word states array.
 */
export function initWordStates(count) {
  return Array(count).fill(WORD_STATE.PENDING);
}
