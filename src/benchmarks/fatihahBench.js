import { getSurahSelection } from '../data/quranDataset.js';
import { matchSpokenWords, initWordStates } from '../utils/wordMatcher.js';
import { getArabicWordVariants, splitIntoWords } from '../utils/arabicNormalize.js';

function toSpokenChunk(transcript) {
  const words = splitIntoWords(transcript);
  const tokens = words.map((text) => ({
    text,
    variants: getArabicWordVariants(text),
  }));

  return {
    words,
    tokens,
    normalizedWords: tokens.map((token) => token.variants),
    wordCount: words.length,
    isInterim: false,
  };
}

const CASES = [
  {
    id: 'fatihah-basic-ayah1-2',
    description: 'Ayah 1 + 2 progression (clean)',
    chunks: [
      'بسم الله الرحمن الرحيم',
      'الحمد لله رب العالمين',
    ],
    expectedMinCanonicalIndex: 8,
  },
  {
    id: 'fatihah-variant-rahman-malik',
    description: 'Variant spellings: الرحمان + ملك',
    chunks: [
      'بسم الله الرحمن الرحيم',
      'الحمد لله رب العالمين',
      'الرحمان الرحيم',
      'ملك يوم الدين',
    ],
    expectedMinCanonicalIndex: 13,
  },
  {
    id: 'fatihah-noise-then-recover',
    description: 'Noise prefix then recovery to basmala',
    chunks: [
      'ترجمه ناسي فتح تعليم',
      'بسم الله الرحمن الرحيم',
    ],
    expectedMinCanonicalIndex: 4,
  },
];

export function runFatihahMatcherBench() {
  const selection = getSurahSelection(1, 1);
  const session = selection.session;

  const results = [];

  for (const testCase of CASES) {
    let states = initWordStates(session.canonicalWords.length);
    let alignmentIndex = 0;

    for (const chunkText of testCase.chunks) {
      const spokenChunk = toSpokenChunk(chunkText);
      const result = matchSpokenWords(session, states, alignmentIndex, spokenChunk, {
        stuckCount: 0,
      });

      states = result.states;
      alignmentIndex = result.newAlignmentIndex;
    }

    const canonicalIndex = session.alignmentWords[alignmentIndex]?.canonicalIndex ?? session.canonicalWords.length;
    const passed = canonicalIndex >= testCase.expectedMinCanonicalIndex;

    results.push({
      id: testCase.id,
      description: testCase.description,
      expectedMinCanonicalIndex: testCase.expectedMinCanonicalIndex,
      canonicalIndex,
      passed,
    });
  }

  const passedCount = results.filter((result) => result.passed).length;

  return {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    results,
  };
}

