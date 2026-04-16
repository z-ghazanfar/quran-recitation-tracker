import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { WORD_STATE } from '../utils/wordMatcher.js';

const WordToken = memo(function WordToken({
  word,
  state,
  isCurrentWord,
  isActiveRead,
  registerWordRef,
  wordIndex,
}) {
  const classNames = ['word-token'];

  if (state === WORD_STATE.CORRECT) {
    classNames.push('word-correct');
  } else if (state === WORD_STATE.MISTAKE) {
    classNames.push('word-mistake');
  } else if (state === WORD_STATE.SKIPPED) {
    classNames.push('word-skipped');
  } else {
    classNames.push('word-pending');
  }

  if (isCurrentWord) {
    classNames.push('word-current');
  }

  if (isActiveRead) {
    classNames.push('word-live');
  }

  return (
    <span ref={registerWordRef(wordIndex)} className={`arabic-text ${classNames.join(' ')}`}>
      {word}
    </span>
  );
});

const AyahMarker = memo(function AyahMarker({ number }) {
  return (
    <span className="ayah-marker arabic-text">
      ﴿{toArabicNumerals(number)}﴾
    </span>
  );
});

const PageBreak = memo(function PageBreak({ pageNumber }) {
  return (
    <div className="page-break-chip">
      <span className="page-break-rule" />
      <span>Page {pageNumber}</span>
      <span className="page-break-rule" />
    </div>
  );
});

function toArabicNumerals(value) {
  return String(value).replace(/\d/g, digit => '٠١٢٣٤٥٦٧٨٩'[digit]);
}

function buildPageLines(ayahs) {
  const lines = Array.from({ length: 15 }, () => []);
  let flatIndex = 0;

  for (const ayah of ayahs) {
    let lastLine = 1;

    for (const entry of ayah.wordEntries) {
      const lineNumber = entry.lineNumber ?? lastLine;
      lastLine = lineNumber;
      lines[lineNumber - 1].push({
        type: 'word',
        key: entry.id,
        flatIndex,
        word: entry.display,
      });
      flatIndex += 1;
    }

    lines[lastLine - 1].push({
      type: 'ayah',
      key: `ayah-marker-${ayah.number}`,
      number: ayah.numberInSurah,
    });
  }

  return lines;
}

function buildSurahBlocks(ayahs) {
  const blocks = [];
  let flatIndex = 0;
  let lastPage = null;

  for (const ayah of ayahs) {
    blocks.push({
      key: ayah.number,
      pageBreak: ayah.pageNumber !== lastPage ? ayah.pageNumber : null,
      ayahNumber: ayah.numberInSurah,
      words: ayah.wordEntries.map(entry => ({
        key: entry.id,
        flatIndex: flatIndex++,
        word: entry.display,
      })),
    });

    lastPage = ayah.pageNumber;
  }

  return blocks;
}

function LoadingState() {
  return (
    <div className="reader-empty-state">
      <div className="flex items-center gap-3 text-stone-500">
        <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v8z" />
        </svg>
        <span>Preparing the reading surface…</span>
      </div>
    </div>
  );
}

function QuranDisplay({
  ayahs,
  wordStates,
  activeWordIndexes,
  currentWordIndex,
  isLoading,
  error,
  mode,
  pageNumber,
}) {
  const wordRefs = useRef(new Map());
  const scrollStateRef = useRef({ index: -1, timestamp: 0 });
  const scrollFrameRef = useRef(null);

  const registerWordRef = useCallback((index) => (node) => {
    if (node) {
      wordRefs.current.set(index, node);
    } else {
      wordRefs.current.delete(index);
    }
  }, []);

  const activeWordIndexSet = useMemo(
    () => new Set(activeWordIndexes),
    [activeWordIndexes],
  );
  const pageLines = useMemo(() => (mode === 'page' ? buildPageLines(ayahs) : []), [ayahs, mode]);
  const surahBlocks = useMemo(() => (mode === 'surah' ? buildSurahBlocks(ayahs) : []), [ayahs, mode]);

  useEffect(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }

    if (currentWordIndex < 0) return;

    const element = wordRefs.current.get(currentWordIndex);
    if (!element) return;

    scrollFrameRef.current = requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const upperBand = 140;
      const lowerBand = viewportHeight - 180;
      const outsideBand = rect.top < upperBand || rect.bottom > lowerBand;

      if (!outsideBand) return;

      const now = performance.now();
      const lastScroll = scrollStateRef.current;
      const movedWords = Math.abs(currentWordIndex - lastScroll.index);
      const recentlyScrolled = now - lastScroll.timestamp < 180;

      if (recentlyScrolled && movedWords < 3) return;

      const targetTop = window.scrollY + rect.top - viewportHeight * 0.32;
      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'auto',
      });

      scrollStateRef.current = {
        index: currentWordIndex,
        timestamp: now,
      };
    });

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [currentWordIndex]);

  if (isLoading) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="reader-empty-state text-red-700">
        {error}
      </div>
    );
  }

  if (!ayahs || ayahs.length === 0) {
    return (
      <div className="reader-empty-state">
        <div className="max-w-md text-center">
          <div className="text-[0.68rem] uppercase tracking-[0.24em] text-stone-500">Ready To Begin</div>
          <div className="kitab-heading mt-2 text-3xl text-stone-800">
            {mode === 'page' ? `Open Page ${pageNumber}` : 'Choose a Surah'}
          </div>
          <p className="mt-2 text-sm text-stone-600">
            The Mushaf view will appear here once a page or surah has been selected.
          </p>
        </div>
      </div>
    );
  }

  if (mode === 'page') {
    return (
      <div className="mushaf-scroll">
        <div className="mushaf-page">
          <div className="mushaf-page-top">
            <span className="page-ornament" />
            <span className="text-sm text-stone-600">Madani layout</span>
            <span className="page-ornament" />
          </div>

          <div className="mushaf-page-body">
            {pageLines.map((line, index) => (
              <div key={index} className="mushaf-line-row">
                <div className="mushaf-line" dir="rtl">
                  {line.map(token => (
                    token.type === 'word' ? (
                      <WordToken
                        key={token.key}
                        word={token.word}
                        state={wordStates[token.flatIndex] ?? WORD_STATE.PENDING}
                        isCurrentWord={token.flatIndex === currentWordIndex}
                        isActiveRead={activeWordIndexSet.has(token.flatIndex)}
                        registerWordRef={registerWordRef}
                        wordIndex={token.flatIndex}
                      />
                    ) : (
                      <AyahMarker key={token.key} number={token.number} />
                    )
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mushaf-page-bottom">
            <span className="page-ornament" />
            <span className="kitab-heading text-2xl text-stone-800">Page {pageNumber}</span>
            <span className="page-ornament" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mushaf-scroll">
      <div className="mushaf-page mushaf-page-continuous">
        <div className="mushaf-page-body">
          {surahBlocks.map(block => (
            <div key={block.key}>
              {block.pageBreak && <PageBreak pageNumber={block.pageBreak} />}

              <div className="surah-ayah-block" dir="rtl">
                {block.words.map(token => (
                  <WordToken
                    key={token.key}
                    word={token.word}
                    state={wordStates[token.flatIndex] ?? WORD_STATE.PENDING}
                    isCurrentWord={token.flatIndex === currentWordIndex}
                    isActiveRead={activeWordIndexSet.has(token.flatIndex)}
                    registerWordRef={registerWordRef}
                    wordIndex={token.flatIndex}
                  />
                ))}
                <AyahMarker number={block.ayahNumber} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(QuranDisplay);
