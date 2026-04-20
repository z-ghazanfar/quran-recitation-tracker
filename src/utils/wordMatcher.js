import {
  alignAndReveal,
  isApproximateMatch,
  phraseSnap,
} from './matchingCore.js';

export const WORD_STATE = {
  PENDING: 'pending',
  CORRECT: 'correct',
  MISTAKE: 'mistake',
  SKIPPED: 'skipped',
  CURRENT: 'current',
};

const LOCAL_WINDOW = 10;
const FAR_WINDOW = 48;
const REVIEW_WINDOW = 18;
const MAX_TRIMMED_OVERLAP = 4;
const MIN_LOCAL_ANCHOR = 2;
const MIN_FAR_ANCHOR = 4;

function collapseRepeatedCharacters(value) {
  return String(value ?? '').replace(/(.)\1+/gu, '$1');
}

function toProcessedChunk(spokenInput) {
  if (Array.isArray(spokenInput)) {
    const tokens = spokenInput.map((value) =>
      typeof value === 'string'
        ? { text: value, variants: [value] }
        : value,
    );

    return {
      words: tokens.map((token) => token.text),
      tokens,
      normalizedWords: tokens.map((token) => token.variants ?? []),
    };
  }

  const tokens = spokenInput?.tokens ?? (spokenInput?.words ?? []).map((word, index) => ({
    text: word,
    variants: spokenInput?.normalizedWords?.[index] ?? [word],
  }));

  return {
    words: tokens.map((token) => token.text),
    tokens,
    normalizedWords: tokens.map((token) => token.variants ?? []),
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

function buildAlignmentRange(start, length) {
  return Array.from({ length }, (_, index) => start + index);
}

function getCanonicalIndexForAlignment(session, alignmentIndex) {
  if (!session || session.canonicalWords.length === 0) return 0;
  if (alignmentIndex >= session.alignmentWords.length) {
    return session.canonicalWords.length;
  }

  return session.alignmentWords[alignmentIndex]?.canonicalIndex ?? session.canonicalWords.length;
}

function uniqueCanonicalIndexes(session, alignmentIndexes) {
  const canonicalIndexes = [];
  const seen = new Set();

  for (const alignmentIndex of alignmentIndexes) {
    const canonicalIndex = session.alignmentWords[alignmentIndex]?.canonicalIndex;
    if (canonicalIndex === undefined || seen.has(canonicalIndex)) continue;
    seen.add(canonicalIndex);
    canonicalIndexes.push(canonicalIndex);
  }

  return canonicalIndexes;
}

function trimLeadingOverlap(session, currentAlignmentIndex, processedChunk) {
  const maxOverlap = Math.min(
    MAX_TRIMMED_OVERLAP,
    currentAlignmentIndex,
    processedChunk.tokens.length,
  );

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    let matches = true;

    for (let offset = 0; offset < overlap; offset += 1) {
      const expectedToken = session.alignmentWords[currentAlignmentIndex - overlap + offset];
      const spokenToken = processedChunk.tokens[offset];

      if (!tokensMatch(expectedToken, spokenToken)) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return {
        words: processedChunk.words.slice(overlap),
        tokens: processedChunk.tokens.slice(overlap),
        normalizedWords: processedChunk.normalizedWords.slice(overlap),
      };
    }
  }

  return processedChunk;
}

function findReviewAnchor(session, currentAlignmentIndex, spokenTokens) {
  if (spokenTokens.length === 0 || currentAlignmentIndex <= 0) return null;

  const searchStart = Math.max(0, currentAlignmentIndex - REVIEW_WINDOW);
  let best = null;

  for (let expectedStart = searchStart; expectedStart < currentAlignmentIndex; expectedStart += 1) {
    const runLength = contiguousRun(session.alignmentWords, expectedStart, spokenTokens);
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

function buildMergedExpectedToken(tokens) {
  let candidates = [''];

  for (const token of tokens) {
    const variants = (token?.variants ?? [token?.text ?? ''])
      .filter(Boolean)
      .slice(0, 3);
    const nextCandidates = new Set();

    for (const candidate of candidates) {
      for (const variant of variants) {
        const merged = `${candidate}${variant}`;
        nextCandidates.add(merged);
        nextCandidates.add(collapseRepeatedCharacters(merged));
      }
    }

    candidates = Array.from(nextCandidates).filter(Boolean).slice(0, 24);
  }

  return {
    text: tokens.map((token) => token.text).join(' '),
    variants: candidates,
  };
}

function applyAlignmentProgress(
  session,
  states,
  currentAlignmentIndex,
  newAlignmentIndex,
  matchedAlignmentIndexes = [],
  mistakeAlignmentIndexes = [],
  options = {},
) {
  const preserveUnmatchedPending = options.preserveUnmatchedPending ?? false;
  const heardWordIndexes = [];
  const heardSet = new Set();
  const matchedSet = new Set(matchedAlignmentIndexes);
  const mistakeSet = new Set(mistakeAlignmentIndexes);
  const affectedCanonicalIndexes = new Set();

  for (let alignmentIndex = currentAlignmentIndex; alignmentIndex < newAlignmentIndex; alignmentIndex += 1) {
    const canonicalIndex = session.alignmentWords[alignmentIndex]?.canonicalIndex;
    if (canonicalIndex !== undefined) {
      affectedCanonicalIndexes.add(canonicalIndex);
    }
  }

  const orderedCanonicalIndexes = Array.from(affectedCanonicalIndexes).sort((left, right) => left - right);

  for (const canonicalIndex of orderedCanonicalIndexes) {
    const range = session.canonicalRanges[canonicalIndex];
    if (!range) continue;

    const inspectStart = Math.max(currentAlignmentIndex, range.start);
    const inspectEnd = Math.min(newAlignmentIndex - 1, range.end);

    let hasMatch = false;
    let hasMistake = false;

    for (let alignmentIndex = inspectStart; alignmentIndex <= inspectEnd; alignmentIndex += 1) {
      if (matchedSet.has(alignmentIndex)) {
        hasMatch = true;
      }
      if (mistakeSet.has(alignmentIndex)) {
        hasMistake = true;
      }
    }

    if (hasMatch) {
      states[canonicalIndex] = WORD_STATE.CORRECT;
      if (!heardSet.has(canonicalIndex)) {
        heardSet.add(canonicalIndex);
        heardWordIndexes.push(canonicalIndex);
      }
      continue;
    }

    if (hasMistake) {
      if (states[canonicalIndex] === WORD_STATE.PENDING) {
        states[canonicalIndex] = WORD_STATE.MISTAKE;
      }

      if (!heardSet.has(canonicalIndex)) {
        heardSet.add(canonicalIndex);
        heardWordIndexes.push(canonicalIndex);
      }
      continue;
    }

    if (!preserveUnmatchedPending && states[canonicalIndex] === WORD_STATE.PENDING) {
      states[canonicalIndex] = WORD_STATE.SKIPPED;
    }
  }

  return {
    states,
    newAlignmentIndex,
    newCanonicalIndex: getCanonicalIndexForAlignment(session, newAlignmentIndex),
    heardWordIndexes,
  };
}

function attemptPhraseSnap(session, states, currentAlignmentIndex, processedChunk) {
  const expectedWindow = session.alignmentWords.slice(
    currentAlignmentIndex,
    currentAlignmentIndex + LOCAL_WINDOW,
  );

  const snapped = phraseSnap(
    processedChunk.tokens,
    expectedWindow,
    Math.min(processedChunk.tokens.length, 2),
    4,
  );

  if (snapped.revealIndices.length === 0) {
    return null;
  }

  const matchedAlignmentIndexes = snapped.revealIndices.map(
    (index) => currentAlignmentIndex + index,
  );

  return applyAlignmentProgress(
    session,
    states,
    currentAlignmentIndex,
    currentAlignmentIndex + snapped.revealIndices.length,
    matchedAlignmentIndexes,
  );
}

function attemptMergedAnchor(session, states, currentAlignmentIndex, processedChunk) {
  if (processedChunk.tokens.length !== 1) return null;

  const maxShift = 1;
  const searchWindow = session.alignmentWords.slice(
    currentAlignmentIndex,
    currentAlignmentIndex + LOCAL_WINDOW,
  );

  for (let shift = 0; shift <= maxShift; shift += 1) {
    for (let count = 2; count <= 3; count += 1) {
      const candidateTokens = searchWindow.slice(shift, shift + count);
      if (candidateTokens.length !== count) continue;

      const mergedToken = buildMergedExpectedToken(candidateTokens);
      if (!tokensMatch(mergedToken, processedChunk.tokens[0])) continue;

      return applyAlignmentProgress(
        session,
        states,
        currentAlignmentIndex,
        currentAlignmentIndex + shift + count,
        buildAlignmentRange(currentAlignmentIndex + shift, count),
        [],
        { preserveUnmatchedPending: shift > 0 },
      );
    }
  }

  return null;
}

function attemptLocalAnchor(session, states, currentAlignmentIndex, processedChunk, options = {}) {
  const stuckCount = options.stuckCount ?? 0;
  const maxShift = stuckCount >= 2
    ? 6
    : processedChunk.tokens.length === 1 ? 1 : 2;

  let best = null;

  for (let shift = 0; shift <= maxShift; shift += 1) {
    const runLength = contiguousRun(
      session.alignmentWords,
      currentAlignmentIndex + shift,
      processedChunk.tokens,
    );

    const minimumRunLength =
      processedChunk.tokens.length === 1
        ? 1
        : Math.min(MIN_LOCAL_ANCHOR, processedChunk.tokens.length);

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

  return applyAlignmentProgress(
    session,
    states,
    currentAlignmentIndex,
    currentAlignmentIndex + best.shift + best.runLength,
    buildAlignmentRange(currentAlignmentIndex + best.shift, best.runLength),
    [],
    { preserveUnmatchedPending: best.shift > 0 || stuckCount >= 2 },
  );
}

function attemptLocalReveal(session, states, currentAlignmentIndex, processedChunk, options = {}) {
  const stuckCount = options.stuckCount ?? 0;
  const expectedWindowSize = stuckCount >= 2 ? Math.max(LOCAL_WINDOW, 18) : LOCAL_WINDOW;
  const expectedWindow = session.alignmentWords.slice(
    currentAlignmentIndex,
    currentAlignmentIndex + expectedWindowSize,
  );

  const alignment = alignAndReveal(
    processedChunk.tokens,
    expectedWindow,
    { maxAlignmentExpectedWindow: expectedWindowSize },
  );

  if (alignment.anchorIndices.length === 0) {
    return null;
  }

  const anchorStart = alignment.firstMatchedIndex;
  const anchorLength = alignment.anchorIndices.length;
  const baseAllowedSkip = processedChunk.tokens.length === 1 ? 1 : 2;
  const maxAllowedSkip = Math.min(4, baseAllowedSkip + Math.min(2, stuckCount));

  if (anchorStart < 0 || anchorStart > maxAllowedSkip) {
    return null;
  }

  if (
    anchorStart > 0 &&
    anchorLength < Math.min(MIN_LOCAL_ANCHOR, processedChunk.tokens.length)
  ) {
    return null;
  }

  const matchedAlignmentIndexes = [];
  const mistakeAlignmentIndexes = [];
  const anchorEnd = anchorStart + anchorLength - 1;

  for (const step of alignment.operations) {
    if (step.expectedIndex < anchorStart || step.expectedIndex > anchorEnd) continue;

    const absoluteAlignmentIndex = currentAlignmentIndex + step.expectedIndex;
    if (step.operation === 'match') {
      matchedAlignmentIndexes.push(absoluteAlignmentIndex);
    } else if (step.operation === 'mistake') {
      mistakeAlignmentIndexes.push(absoluteAlignmentIndex);
    }
  }

  return applyAlignmentProgress(
    session,
    states,
    currentAlignmentIndex,
    currentAlignmentIndex + anchorEnd + 1,
    matchedAlignmentIndexes,
    mistakeAlignmentIndexes,
    { preserveUnmatchedPending: anchorStart > 0 || stuckCount >= 2 },
  );
}

function isFarAnchorStrongEnough(session, currentAlignmentIndex, candidateStart, runLength) {
  const currentToken =
    session.alignmentWords[currentAlignmentIndex] ??
    session.alignmentWords[Math.max(0, currentAlignmentIndex - 1)];
  const candidateToken = session.alignmentWords[candidateStart];

  if (!currentToken || !candidateToken) return false;
  if (runLength < MIN_FAR_ANCHOR) return false;

  const samePage = currentToken.page === candidateToken.page;
  const sameSurah = currentToken.surah === candidateToken.surah;
  const ayahDistance = sameSurah
    ? Math.abs(candidateToken.ayah - currentToken.ayah)
    : Number.POSITIVE_INFINITY;
  const alignmentDistance = candidateStart - currentAlignmentIndex;

  if (!sameSurah) return false;
  if (!samePage && runLength < 6) return false;
  if (ayahDistance > 1) return false;
  if (alignmentDistance > 12 && runLength < 5) return false;

  return true;
}

function attemptFarAnchor(session, states, currentAlignmentIndex, processedChunk) {
  if (processedChunk.tokens.length < MIN_FAR_ANCHOR) {
    return null;
  }

  let best = null;
  const searchEnd = Math.min(session.alignmentWords.length, currentAlignmentIndex + FAR_WINDOW);

  for (let expectedStart = currentAlignmentIndex + 4; expectedStart < searchEnd; expectedStart += 1) {
    const runLength = contiguousRun(
      session.alignmentWords,
      expectedStart,
      processedChunk.tokens,
    );

    if (!isFarAnchorStrongEnough(session, currentAlignmentIndex, expectedStart, runLength)) {
      continue;
    }

    if (!best || runLength > best.runLength) {
      best = { expectedStart, runLength };
    }
  }

  if (!best) return null;

  for (
    let nearbyStart = currentAlignmentIndex;
    nearbyStart < Math.min(currentAlignmentIndex + 3, session.alignmentWords.length);
    nearbyStart += 1
  ) {
    const nearbyRun = contiguousRun(
      session.alignmentWords,
      nearbyStart,
      processedChunk.tokens,
    );

    if (nearbyRun >= Math.max(2, best.runLength - 1)) {
      return null;
    }
  }

  return applyAlignmentProgress(
    session,
    states,
    currentAlignmentIndex,
    best.expectedStart + best.runLength,
    buildAlignmentRange(best.expectedStart, best.runLength),
    [],
    { preserveUnmatchedPending: true },
  );
}

export function matchSpokenWords(session, wordStates, currentAlignmentIndex, spokenInput, options = {}) {
  const states = [...wordStates];
  const processedChunk = toProcessedChunk(spokenInput);
  const reviewAnchor = findReviewAnchor(session, currentAlignmentIndex, processedChunk.tokens);
  const reviewWordIndexes = reviewAnchor
    ? uniqueCanonicalIndexes(
        session,
        buildAlignmentRange(reviewAnchor.expectedStart, reviewAnchor.runLength),
      )
    : [];

  const cleanedChunk = trimLeadingOverlap(session, currentAlignmentIndex, processedChunk);

  if (
    cleanedChunk.tokens.length === 0 ||
    currentAlignmentIndex >= session.alignmentWords.length
  ) {
    return {
      states,
      newAlignmentIndex: currentAlignmentIndex,
      newCanonicalIndex: getCanonicalIndexForAlignment(session, currentAlignmentIndex),
      heardWordIndexes: reviewWordIndexes,
    };
  }

  const snapped = attemptPhraseSnap(session, states, currentAlignmentIndex, cleanedChunk);
  if (snapped) {
    return snapped;
  }

  const merged = attemptMergedAnchor(session, states, currentAlignmentIndex, cleanedChunk);
  if (merged) {
    return merged;
  }

  const localAnchor = attemptLocalAnchor(session, states, currentAlignmentIndex, cleanedChunk, options);
  if (localAnchor) {
    return localAnchor;
  }

  const localReveal = attemptLocalReveal(session, states, currentAlignmentIndex, cleanedChunk, options);
  if (localReveal) {
    return localReveal;
  }

  const farAnchor = attemptFarAnchor(session, states, currentAlignmentIndex, cleanedChunk);
  if (farAnchor) {
    return farAnchor;
  }

  return {
    states,
    newAlignmentIndex: currentAlignmentIndex,
    newCanonicalIndex: getCanonicalIndexForAlignment(session, currentAlignmentIndex),
    heardWordIndexes: reviewWordIndexes,
  };
}

export function initWordStates(count) {
  return Array(count).fill(WORD_STATE.PENDING);
}
