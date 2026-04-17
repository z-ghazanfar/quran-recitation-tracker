import {
  alignAndReveal,
  isApproximateMatch,
  normalizeWords,
  phraseSnap,
} from './matchingCore.js';

export const WORD_STATE = {
  PENDING: 'pending',
  CORRECT: 'correct',
  MISTAKE: 'mistake',
  SKIPPED: 'skipped',
  CURRENT: 'current',
};

const LOCAL_WINDOW = 8;
const FAR_WINDOW = 80;
const REVIEW_WINDOW = 18;
const MAX_TRIMMED_OVERLAP = 3;
const MIN_LOCAL_ANCHOR = 2;
const MIN_FAR_ANCHOR = 4;

function buildIndexRange(start, length) {
  return Array.from({ length }, (_, index) => start + index);
}

function toExpectedSession(expectedInput) {
  if (Array.isArray(expectedInput)) {
    return {
      words: expectedInput,
      normalizedWords: normalizeWords(expectedInput),
    };
  }

  return expectedInput;
}

function toProcessedChunk(spokenInput) {
  if (Array.isArray(spokenInput)) {
    return {
      words: spokenInput,
      normalizedWords: normalizeWords(spokenInput),
    };
  }

  return {
    words: spokenInput?.words ?? [],
    normalizedWords: spokenInput?.normalizedWords ?? normalizeWords(spokenInput?.words ?? []),
  };
}

function tokensMatch(expectedToken, spokenToken) {
  return isApproximateMatch(expectedToken, spokenToken);
}

function contiguousRun(expectedTokens, expectedStart, spokenTokens) {
  let runLength = 0;

  while (
    expectedStart + runLength < expectedTokens.length &&
    runLength < spokenTokens.length &&
    tokensMatch(expectedTokens[expectedStart + runLength], spokenTokens[runLength])
  ) {
    runLength += 1;
  }

  return runLength;
}

function trimLeadingOverlap(expectedTokens, currentIndex, processedChunk) {
  const maxOverlap = Math.min(MAX_TRIMMED_OVERLAP, currentIndex, processedChunk.words.length);

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    let matches = true;

    for (let offset = 0; offset < overlap; offset += 1) {
      if (
        !tokensMatch(
          expectedTokens[currentIndex - overlap + offset],
          processedChunk.normalizedWords[offset],
        )
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return {
        words: processedChunk.words.slice(overlap),
        normalizedWords: processedChunk.normalizedWords.slice(overlap),
      };
    }
  }

  return processedChunk;
}

function findReviewAnchor(expectedTokens, currentIndex, spokenTokens) {
  if (spokenTokens.length === 0 || currentIndex <= 0) return null;

  const searchStart = Math.max(0, currentIndex - REVIEW_WINDOW);
  let best = null;

  for (let expectedStart = searchStart; expectedStart < currentIndex; expectedStart += 1) {
    const runLength = contiguousRun(expectedTokens, expectedStart, spokenTokens);
    if (runLength === 0) continue;

    const candidate = { expectedStart, runLength };
    if (
      !best ||
      candidate.runLength > best.runLength ||
      (candidate.runLength === best.runLength && candidate.expectedStart > best.expectedStart)
    ) {
      best = candidate;
    }
  }

  return best;
}

function applyReveal(states, currentIndex, anchorStart, anchorLength, operations) {
  const anchorEnd = anchorStart + anchorLength - 1;
  const heardWordIndexes = [];

  for (let offset = 0; offset < anchorStart; offset += 1) {
    const targetIndex = currentIndex + offset;
    if (states[targetIndex] === WORD_STATE.PENDING) {
      states[targetIndex] = WORD_STATE.SKIPPED;
    }
  }

  for (const step of operations) {
    if (step.expectedIndex < 0 || step.expectedIndex > anchorEnd) continue;

    const targetIndex = currentIndex + step.expectedIndex;
    if (targetIndex < currentIndex || targetIndex >= states.length) continue;

    if (step.operation === 'match') {
      states[targetIndex] = WORD_STATE.CORRECT;
      heardWordIndexes.push(targetIndex);
      continue;
    }

    if (
      step.operation === 'mistake' &&
      step.expectedIndex >= anchorStart &&
      states[targetIndex] === WORD_STATE.PENDING
    ) {
      states[targetIndex] = WORD_STATE.MISTAKE;
      heardWordIndexes.push(targetIndex);
      continue;
    }

    if (
      step.operation === 'skip-expected' &&
      step.expectedIndex >= anchorStart &&
      states[targetIndex] === WORD_STATE.PENDING
    ) {
      states[targetIndex] = WORD_STATE.SKIPPED;
    }
  }

  return {
    states,
    newIndex: currentIndex + anchorEnd + 1,
    heardWordIndexes,
  };
}

function applyDirectAnchor(states, currentIndex, anchorStart, anchorLength) {
  for (let offset = 0; offset < anchorStart; offset += 1) {
    const targetIndex = currentIndex + offset;
    if (states[targetIndex] === WORD_STATE.PENDING) {
      states[targetIndex] = WORD_STATE.SKIPPED;
    }
  }

  const heardWordIndexes = [];
  for (let offset = 0; offset < anchorLength; offset += 1) {
    const targetIndex = currentIndex + anchorStart + offset;
    states[targetIndex] = WORD_STATE.CORRECT;
    heardWordIndexes.push(targetIndex);
  }

  return {
    states,
    newIndex: currentIndex + anchorStart + anchorLength,
    heardWordIndexes,
  };
}

function attemptPhraseSnap(states, currentIndex, expectedWindow, processedChunk) {
  const snapped = phraseSnap(processedChunk.normalizedWords, expectedWindow.normalizedWords, 1, 4);

  if (snapped.revealIndices.length === 0) {
    return null;
  }

  const revealLength = snapped.revealIndices.length;
  const heardWordIndexes = [];

  for (let offset = 0; offset < revealLength; offset += 1) {
    const targetIndex = currentIndex + offset;
    states[targetIndex] = WORD_STATE.CORRECT;
    heardWordIndexes.push(targetIndex);
  }

  return {
    states,
    newIndex: currentIndex + revealLength,
    heardWordIndexes,
  };
}

function attemptLocalAnchor(states, currentIndex, expectedWindow, processedChunk) {
  const maxShift =
    processedChunk.words.length === 1 ? 1 :
    processedChunk.words.length === 2 ? 1 :
    2;

  let best = null;

  for (let shift = 0; shift <= maxShift; shift += 1) {
    const runLength = contiguousRun(
      expectedWindow.normalizedWords,
      shift,
      processedChunk.normalizedWords,
    );

    const minimumRunLength =
      processedChunk.words.length === 1 ? 1 : Math.min(MIN_LOCAL_ANCHOR, processedChunk.words.length);

    if (runLength < minimumRunLength) continue;

    const candidate = { shift, runLength };
    if (
      !best ||
      candidate.shift < best.shift ||
      (candidate.shift === best.shift && candidate.runLength > best.runLength)
    ) {
      best = candidate;
    }
  }

  if (!best) return null;
  return applyDirectAnchor(states, currentIndex, best.shift, best.runLength);
}

function attemptLocalReveal(states, currentIndex, expectedWindow, processedChunk) {
  const alignment = alignAndReveal(
    processedChunk.normalizedWords,
    expectedWindow.normalizedWords,
    { maxAlignmentExpectedWindow: LOCAL_WINDOW },
  );

  if (alignment.anchorIndices.length === 0) {
    return null;
  }

  const anchorStart = alignment.firstMatchedIndex;
  const anchorLength = alignment.anchorIndices.length;
  const maxAllowedSkip =
    processedChunk.words.length === 1 ? 1 :
    processedChunk.words.length === 2 ? 1 :
    2;

  if (anchorStart < 0 || anchorStart > maxAllowedSkip) {
    return null;
  }

  if (
    anchorStart > 0 &&
    anchorLength < Math.min(MIN_LOCAL_ANCHOR, processedChunk.words.length)
  ) {
    return null;
  }

  return applyReveal(states, currentIndex, anchorStart, anchorLength, alignment.operations);
}

function attemptFarAnchor(states, currentIndex, expectedSession, processedChunk) {
  if (processedChunk.words.length < MIN_FAR_ANCHOR) {
    return null;
  }

  let best = null;
  const searchEnd = Math.min(expectedSession.words.length, currentIndex + FAR_WINDOW);

  for (let expectedStart = currentIndex + 3; expectedStart < searchEnd; expectedStart += 1) {
    const runLength = contiguousRun(
      expectedSession.normalizedWords,
      expectedStart,
      processedChunk.normalizedWords,
    );

    if (runLength < MIN_FAR_ANCHOR) continue;

    if (!best || runLength > best.runLength) {
      best = { expectedStart, runLength };
    }
  }

  if (!best) return null;

  for (let nearbyStart = currentIndex; nearbyStart < Math.min(currentIndex + 3, expectedSession.words.length); nearbyStart += 1) {
    const nearbyRun = contiguousRun(
      expectedSession.normalizedWords,
      nearbyStart,
      processedChunk.normalizedWords,
    );

    if (nearbyRun >= Math.max(2, best.runLength - 1)) {
      return null;
    }
  }

  for (let index = currentIndex; index < best.expectedStart; index += 1) {
    if (states[index] === WORD_STATE.PENDING) {
      states[index] = WORD_STATE.SKIPPED;
    }
  }

  const heardWordIndexes = [];
  for (let offset = 0; offset < best.runLength; offset += 1) {
    const targetIndex = best.expectedStart + offset;
    states[targetIndex] = WORD_STATE.CORRECT;
    heardWordIndexes.push(targetIndex);
  }

  return {
    states,
    newIndex: best.expectedStart + best.runLength,
    heardWordIndexes,
  };
}

export function matchSpokenWords(expectedInput, wordStates, currentIndex, spokenInput) {
  const states = [...wordStates];
  const expectedSession = toExpectedSession(expectedInput);
  const processedChunk = toProcessedChunk(spokenInput);

  const reviewAnchor = findReviewAnchor(
    expectedSession.normalizedWords,
    currentIndex,
    processedChunk.normalizedWords,
  );
  const reviewWordIndexes = reviewAnchor
    ? buildIndexRange(reviewAnchor.expectedStart, reviewAnchor.runLength)
    : [];

  const cleanedChunk = trimLeadingOverlap(
    expectedSession.normalizedWords,
    currentIndex,
    processedChunk,
  );

  if (cleanedChunk.words.length === 0 || currentIndex >= expectedSession.words.length) {
    return {
      states,
      newIndex: currentIndex,
      heardWordIndexes: reviewWordIndexes,
    };
  }

  const expectedWindow = {
    words: expectedSession.words.slice(currentIndex, currentIndex + LOCAL_WINDOW),
    normalizedWords: expectedSession.normalizedWords.slice(currentIndex, currentIndex + LOCAL_WINDOW),
  };

  const snapped = attemptPhraseSnap(states, currentIndex, expectedWindow, cleanedChunk);
  if (snapped) {
    return snapped;
  }

  const localAnchor = attemptLocalAnchor(states, currentIndex, expectedWindow, cleanedChunk);
  if (localAnchor) {
    return localAnchor;
  }

  const localReveal = attemptLocalReveal(states, currentIndex, expectedWindow, cleanedChunk);
  if (localReveal) {
    return localReveal;
  }

  const farAnchor = attemptFarAnchor(states, currentIndex, expectedSession, cleanedChunk);
  if (farAnchor) {
    return farAnchor;
  }

  return {
    states,
    newIndex: currentIndex,
    heardWordIndexes: reviewWordIndexes,
  };
}

export function initWordStates(count) {
  return Array(count).fill(WORD_STATE.PENDING);
}
