import mushafTranslatorIndex from './mushaf-source/metadata/mushaf-translator-index.json';
import quranSimpleClean from './mushaf-source/text/quran-simple-clean.json';
import { getArabicWordVariants } from '../utils/arabicNormalize.js';
import {
  extractQuranOrthographyFeatures,
  mergeQuranVariants,
} from '../utils/quranOrthography.js';

const pageModules = import.meta.glob('./mushaf-source/pages/*.json', {
  eager: true,
  import: 'default',
});

const pageNumbers = Object.keys(pageModules)
  .map((path) => {
    const match = path.match(/\/(\d+)\.json$/u);
    return match ? Number(match[1]) : null;
  })
  .filter((pageNumber) => Number.isInteger(pageNumber))
  .sort((left, right) => left - right);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildWordId(surahNumber, ayahNumber, canonicalAyahIndex) {
  return `${surahNumber}:${ayahNumber}:${canonicalAyahIndex + 1}`;
}

function splitSimpleTokens(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function createVerseRecord({ surahNumber, ayahNumber, pageNumber }) {
  return {
    number: `${surahNumber}:${ayahNumber}`,
    chapterNumber: surahNumber,
    verseKey: `${surahNumber}:${ayahNumber}`,
    numberInSurah: ayahNumber,
    pageNumber,
    wordEntries: [],
    words: [],
    alignmentTemplate: [],
    simpleTokens: [],
  };
}

const verseMap = new Map();
const versesBySurah = new Map();
const pageSelections = new Map();
const pageBoundaries = new Map();

for (const pageNumber of pageNumbers) {
  const pageData = pageModules[`./mushaf-source/pages/${pageNumber}.json`];
  const pageAyahs = [];
  let pageStart = null;
  let pageEnd = null;

  for (const surah of pageData.surahs ?? []) {
    for (const ayah of surah.ayahs ?? []) {
      const surahNumber = Number(surah.surahNum);
      const ayahNumber = Number(ayah.ayahNum);
      const verseKey = `${surahNumber}:${ayahNumber}`;
      let verseRecord = verseMap.get(verseKey);

      if (!verseRecord) {
        verseRecord = createVerseRecord({
          surahNumber,
          ayahNumber,
          pageNumber,
        });
        verseMap.set(verseKey, verseRecord);

        const surahVerses = versesBySurah.get(surahNumber) ?? [];
        surahVerses.push(verseRecord);
        versesBySurah.set(surahNumber, surahVerses);
      }

      const fragmentWords = [];
      for (const word of ayah.words ?? []) {
        if (!word.text) continue;

        const canonicalAyahIndex = verseRecord.wordEntries.length;
        const wordRecord = {
          id: `${verseKey}:${canonicalAyahIndex + 1}`,
          wordId: buildWordId(surahNumber, ayahNumber, canonicalAyahIndex),
          display: word.text,
          uthmaniText: word.text,
          indopakText: word.indopak ?? word.text,
          quranFeatures: extractQuranOrthographyFeatures(word.text),
          surah: surahNumber,
          ayah: ayahNumber,
          page: pageNumber,
          pageNumber,
          lineNumber: word.lineNumber ? Number(word.lineNumber) : null,
          canonicalAyahIndex,
          variants: getArabicWordVariants(word.text),
          simpleTokens: [],
          simpleText: '',
        };

        verseRecord.wordEntries.push(wordRecord);
        verseRecord.words.push(wordRecord.display);
        fragmentWords.push(wordRecord);
      }

      if (fragmentWords.length === 0) {
        continue;
      }

      if (!pageStart) {
        pageStart = { surah: surahNumber, ayah: ayahNumber };
      }
      pageEnd = { surah: surahNumber, ayah: ayahNumber };

      pageAyahs.push({
        number: `${pageNumber}:${verseKey}`,
        chapterNumber: surahNumber,
        verseKey,
        numberInSurah: ayahNumber,
        pageNumber,
        wordEntries: fragmentWords,
        words: fragmentWords.map((entry) => entry.display),
      });
    }
  }

  pageSelections.set(pageNumber, pageAyahs);
  pageBoundaries.set(pageNumber, {
    pageNumber,
    start: pageStart,
    end: pageEnd,
  });
}

for (const verseRecord of verseMap.values()) {
  const surahKey = String(verseRecord.chapterNumber);
  const ayahKey = String(verseRecord.numberInSurah);
  const simpleText = quranSimpleClean[surahKey]?.[ayahKey] ?? verseRecord.words.join(' ');
  const simpleTokens = splitSimpleTokens(simpleText);
  const translatorEntry = mushafTranslatorIndex[surahKey]?.[ayahKey] ?? {};
  const groupedSimpleTokens = Array.from(
    { length: verseRecord.wordEntries.length },
    () => [],
  );

  verseRecord.simpleTokens = simpleTokens;
  verseRecord.alignmentTemplate = simpleTokens.map((token, simpleIndex) => {
    const mappedIndex = clamp(
      Number(translatorEntry[String(simpleIndex)] ?? simpleIndex),
      0,
      Math.max(verseRecord.wordEntries.length - 1, 0),
    );
    const canonicalWord = verseRecord.wordEntries[mappedIndex];
    groupedSimpleTokens[mappedIndex].push(token);

    return {
      text: token,
      variants: mergeQuranVariants({
        tokenText: token,
        uthmaniText: canonicalWord?.uthmaniText,
        indopakText: canonicalWord?.indopakText,
      }),
      wordId: canonicalWord?.wordId,
      quranFeatures: canonicalWord?.quranFeatures ?? null,
      surah: canonicalWord?.surah,
      ayah: canonicalWord?.ayah,
      page: canonicalWord?.page,
      lineNumber: canonicalWord?.lineNumber ?? null,
      canonicalAyahIndex: canonicalWord?.canonicalAyahIndex ?? mappedIndex,
    };
  });

  for (const word of verseRecord.wordEntries) {
    word.simpleTokens = groupedSimpleTokens[word.canonicalAyahIndex];
    word.simpleText = word.simpleTokens.join(' ');
    word.matchVariants = mergeQuranVariants({
      uthmaniText: word.uthmaniText,
      indopakText: word.indopakText,
      simpleTokens: word.simpleTokens,
    });
  }
}

const pageCache = new Map();
const surahCache = new Map();

function buildPreparedSession(ayahs) {
  const canonicalWords = [];
  const alignmentWords = [];
  const wordIdToCanonicalIndex = new Map();

  for (const ayah of ayahs) {
    for (const entry of ayah.wordEntries) {
      const canonicalIndex = canonicalWords.length;
      canonicalWords.push({
        ...entry,
        canonicalIndex,
      });
      wordIdToCanonicalIndex.set(entry.wordId, canonicalIndex);
    }
  }

  for (const ayah of ayahs) {
    const visibleWordIds = new Set(ayah.wordEntries.map((entry) => entry.wordId));
    const verseRecord = verseMap.get(ayah.verseKey);
    if (!verseRecord) continue;

    for (const token of verseRecord.alignmentTemplate) {
      if (!visibleWordIds.has(token.wordId)) continue;
      const canonicalIndex = wordIdToCanonicalIndex.get(token.wordId);
      if (canonicalIndex === undefined) continue;

      alignmentWords.push({
        ...token,
        canonicalIndex,
        alignmentIndex: alignmentWords.length,
      });
    }
  }

  const canonicalRanges = canonicalWords.map(() => ({ start: -1, end: -1 }));

  for (const token of alignmentWords) {
    const range = canonicalRanges[token.canonicalIndex];
    if (range.start === -1) {
      range.start = token.alignmentIndex;
    }
    range.end = token.alignmentIndex;
  }

  let fallbackIndex = 0;
  for (const range of canonicalRanges) {
    if (range.start === -1) {
      range.start = fallbackIndex;
      range.end = fallbackIndex - 1;
    } else {
      fallbackIndex = range.end + 1;
    }
  }

  return {
    canonicalWords,
    alignmentWords,
    canonicalRanges,
  };
}

function buildSelectionResult(ayahs) {
  return {
    ayahs,
    session: buildPreparedSession(ayahs),
  };
}

export function getPageSelection(pageNumber) {
  const normalizedPage = clamp(pageNumber, 1, pageNumbers.length);
  const cached = pageCache.get(normalizedPage);
  if (cached) return cached;

  const ayahs = pageSelections.get(normalizedPage) ?? [];
  const result = buildSelectionResult(ayahs);
  pageCache.set(normalizedPage, result);
  return result;
}

export function getSurahSelection(surahNumber, startAyah) {
  const cacheKey = `${surahNumber}:${startAyah}`;
  const cached = surahCache.get(cacheKey);
  if (cached) return cached;

  const ayahs = (versesBySurah.get(surahNumber) ?? [])
    .filter((verse) => verse.numberInSurah >= startAyah);
  const result = buildSelectionResult(ayahs);
  surahCache.set(cacheKey, result);
  return result;
}

export function getCanonicalIndexForAlignment(session, alignmentIndex) {
  if (!session || session.canonicalWords.length === 0) return 0;
  if (alignmentIndex >= session.alignmentWords.length) {
    return session.canonicalWords.length;
  }

  return session.alignmentWords[alignmentIndex]?.canonicalIndex ?? session.canonicalWords.length;
}

export function getCurrentPositionFromSession(session, canonicalIndex) {
  if (!session || canonicalIndex < 0 || canonicalIndex >= session.canonicalWords.length) {
    return null;
  }

  const word = session.canonicalWords[canonicalIndex];
  if (!word) return null;

  return {
    surah: word.surah,
    ayah: word.ayah,
    page: word.page,
  };
}

export function getPageBoundary(pageNumber) {
  return pageBoundaries.get(pageNumber) ?? null;
}
