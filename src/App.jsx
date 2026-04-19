import { startTransition, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import ReadingNavigator from './components/SurahSelector.jsx';
import QuranDisplay from './components/QuranDisplay.jsx';
import MistakesSummary from './components/MistakesSummary.jsx';
import { useSpeechRecognition } from './hooks/useSpeechRecognition.js';
import { matchSpokenWords, initWordStates, WORD_STATE } from './utils/wordMatcher.js';
import { SURAHS, TOTAL_PAGES } from './data/quranMeta.js';
import {
  getCurrentPositionFromSession,
  getPageSelection,
  getSurahSelection,
} from './data/quranDataset.js';

const initialRecitationState = {
  ayahs: [],
  session: {
    canonicalWords: [],
    alignmentWords: [],
    canonicalRanges: [],
  },
  isLoading: false,
  loadError: null,
  wordStates: [],
  activeWordIndexes: [],
  currentWordIndex: 0,
  currentAlignmentIndex: 0,
  interimText: '',
  lastHeard: '',
  sessionStarted: false,
};

const MAX_PENDING_CHUNK_WORDS = 10;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function countWords(ayahs) {
  return ayahs.reduce((total, ayah) => total + ayah.words.length, 0);
}

function getChunkOverlapLength(previousWords, nextWords) {
  const maxOverlap = Math.min(previousWords.length, nextWords.length, 4);

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    let matches = true;

    for (let index = 0; index < overlap; index += 1) {
      if (previousWords[previousWords.length - overlap + index] !== nextWords[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlap;
    }
  }

  return 0;
}

function trimChunkToWordLimit(spokenChunk, maxWords) {
  if ((spokenChunk?.words?.length ?? 0) <= maxWords) {
    return spokenChunk;
  }

  const start = spokenChunk.words.length - maxWords;

  return {
    ...spokenChunk,
    words: spokenChunk.words.slice(start),
    tokens: (spokenChunk.tokens ?? []).slice(start),
    normalizedWords: (spokenChunk.normalizedWords ?? []).slice(start),
  };
}

function mergeSpokenChunks(previousChunk, nextChunk) {
  if (!previousChunk) {
    return trimChunkToWordLimit(nextChunk, MAX_PENDING_CHUNK_WORDS);
  }

  const overlap = getChunkOverlapLength(previousChunk.words ?? [], nextChunk.words ?? []);

  return trimChunkToWordLimit({
    ...nextChunk,
    words: [...(previousChunk.words ?? []), ...(nextChunk.words ?? []).slice(overlap)],
    tokens: [...(previousChunk.tokens ?? []), ...(nextChunk.tokens ?? []).slice(overlap)],
    normalizedWords: [
      ...(previousChunk.normalizedWords ?? []),
      ...(nextChunk.normalizedWords ?? []).slice(overlap),
    ],
  }, MAX_PENDING_CHUNK_WORDS);
}

function recitationReducer(state, action) {
  switch (action.type) {
    case 'load-start':
      return {
        ...state,
        ayahs: [],
        session: {
          canonicalWords: [],
          alignmentWords: [],
          canonicalRanges: [],
        },
        isLoading: true,
        loadError: null,
        wordStates: [],
        activeWordIndexes: [],
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
        interimText: '',
        lastHeard: '',
      };
    case 'load-success': {
      const totalWords = action.totalWords;
      return {
        ...state,
        ayahs: action.verses,
        session: action.session,
        isLoading: false,
        loadError: null,
        wordStates: initWordStates(totalWords),
        activeWordIndexes: [],
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
        interimText: '',
        lastHeard: '',
      };
    }
    case 'load-error':
      return {
        ...state,
        ayahs: [],
        session: {
          canonicalWords: [],
          alignmentWords: [],
          canonicalRanges: [],
        },
        isLoading: false,
        loadError: action.message,
        wordStates: [],
        activeWordIndexes: [],
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
        interimText: '',
        lastHeard: '',
      };
    case 'apply-final-words':
      return {
        ...state,
        wordStates: action.states,
        activeWordIndexes: action.heardWordIndexes,
        currentWordIndex: action.newIndex,
        currentAlignmentIndex: action.newAlignmentIndex,
        lastHeard: action.lastHeard,
        interimText: '',
      };
    case 'apply-interim':
      return {
        ...state,
        interimText: action.text,
      };
    case 'start-session':
      return {
        ...state,
        sessionStarted: true,
      };
    case 'reset-session':
      return {
        ...state,
        wordStates: initWordStates(countWords(state.ayahs)),
        activeWordIndexes: [],
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
        interimText: '',
        lastHeard: '',
        sessionStarted: false,
      };
    case 'clear-session':
      return {
        ...state,
        activeWordIndexes: [],
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
        interimText: '',
        lastHeard: '',
        sessionStarted: false,
      };
    case 'clear-active-read':
      return {
        ...state,
        activeWordIndexes: [],
      };
    default:
      return state;
  }
}

function getSurahName(chapterNumber) {
  return SURAHS.find(surah => surah.num === chapterNumber)?.name ?? `Surah ${chapterNumber}`;
}

function getPageRange(ayahs) {
  if (ayahs.length === 0) return null;
  return {
    first: ayahs[0].pageNumber,
    last: ayahs[ayahs.length - 1].pageNumber,
  };
}

function buildSelectionInfo(ayahs, mode, pageNum) {
  if (ayahs.length === 0) {
    return {
      eyebrow: mode === 'page' ? 'Madani Page' : 'Focused Recitation',
      title: mode === 'page' ? `Page ${pageNum}` : 'Choose a Surah',
      subtitle: mode === 'page'
        ? 'Each page is rendered as a Mushaf-style reading surface.'
        : 'Jump to any surah and begin from the ayah you need.',
      detail: mode === 'page' ? '604 pages' : '114 surahs',
      surahLabel: '',
    };
  }

  const firstAyah = ayahs[0];
  const lastAyah = ayahs[ayahs.length - 1];
  const firstSurahName = getSurahName(firstAyah.chapterNumber);
  const lastSurahName = getSurahName(lastAyah.chapterNumber);
  const pageRange = getPageRange(ayahs);
  const spansSingleSurah = firstAyah.chapterNumber === lastAyah.chapterNumber;
  const spansSinglePage = pageRange?.first === pageRange?.last;

  if (mode === 'page') {
    return {
      eyebrow: 'Madani Page',
      title: `Page ${pageNum}`,
      subtitle: spansSingleSurah
        ? `${firstSurahName} · from ayah ${firstAyah.numberInSurah}`
        : `${firstSurahName} to ${lastSurahName}`,
      detail: spansSinglePage ? 'Single Mushaf page' : `Pages ${pageRange.first}-${pageRange.last}`,
      surahLabel: spansSingleSurah ? firstSurahName : `${firstSurahName} to ${lastSurahName}`,
    };
  }

  return {
    eyebrow: 'Focused Recitation',
    title: `${firstSurahName}`,
    subtitle: `Starting at ayah ${firstAyah.numberInSurah} and continuing through the surah`,
    detail: spansSinglePage ? `Within page ${pageRange.first}` : `Pages ${pageRange.first}-${pageRange.last}`,
    surahLabel: firstSurahName,
  };
}

function MetaChip({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#12251b]/80 px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[0.62rem] uppercase tracking-[0.18em] text-amber-100/45">{label}</div>
      <div className="mt-1 text-sm font-medium text-stone-100">{value}</div>
    </div>
  );
}

function LegendItem({ state, label }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white/55 px-3 py-1.5 text-xs text-stone-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
      <span className={`legend-dot legend-dot-${state}`} />
      <span>{label}</span>
    </div>
  );
}

export default function App() {
  const [navigationMode, setNavigationMode] = useState('page');
  const [audioSource, setAudioSource] = useState('microphone');
  const [surahNum, setSurahNum] = useState(1);
  const [ayahNum, setAyahNum] = useState(1);
  const [pageNum, setPageNum] = useState(1);
  const [state, dispatch] = useReducer(recitationReducer, initialRecitationState);
  const {
    ayahs,
    session,
    isLoading,
    loadError,
    wordStates,
    activeWordIndexes,
    currentWordIndex,
    currentAlignmentIndex,
    interimText,
    lastHeard,
    sessionStarted,
  } = state;

  const stateRef = useRef({ wordStates: [], currentWordIndex: 0, currentAlignmentIndex: 0 });
  const activeReadClearTimerRef = useRef(null);
  const pendingSpokenChunkRef = useRef(null);
  useEffect(() => {
    stateRef.current = { wordStates, currentWordIndex, currentAlignmentIndex };
  }, [currentAlignmentIndex, currentWordIndex, wordStates]);

  useEffect(() => () => {
    if (activeReadClearTimerRef.current) {
      clearTimeout(activeReadClearTimerRef.current);
    }
  }, []);

  const expectedSessionRef = useRef({
    canonicalWords: [],
    alignmentWords: [],
    canonicalRanges: [],
  });

  const handleWords = useCallback((spokenChunk) => {
    const {
      wordStates: statesSnapshot,
      currentWordIndex: currentWordSnapshot,
      currentAlignmentIndex: alignmentSnapshot,
    } = stateRef.current;
    const combinedChunk = mergeSpokenChunks(pendingSpokenChunkRef.current, spokenChunk);
    const {
      states,
      newAlignmentIndex,
      newCanonicalIndex,
      heardWordIndexes = [],
    } = matchSpokenWords(
      expectedSessionRef.current,
      statesSnapshot,
      alignmentSnapshot,
      combinedChunk,
    );
    const progressed = newAlignmentIndex > alignmentSnapshot;
    const isReviewOnly =
      !progressed &&
      heardWordIndexes.length > 0 &&
      heardWordIndexes.every((index) => index < currentWordSnapshot);

    if (progressed || isReviewOnly) {
      pendingSpokenChunkRef.current = null;
    } else {
      pendingSpokenChunkRef.current = combinedChunk;
    }

    stateRef.current = {
      wordStates: states,
      currentWordIndex: newCanonicalIndex,
      currentAlignmentIndex: newAlignmentIndex,
    };

    dispatch({
      type: 'apply-final-words',
      states,
      heardWordIndexes,
      newIndex: newCanonicalIndex,
      newAlignmentIndex,
      lastHeard: combinedChunk.words.join(' '),
    });

    if (activeReadClearTimerRef.current) {
      clearTimeout(activeReadClearTimerRef.current);
    }

    if (heardWordIndexes.length > 0) {
      activeReadClearTimerRef.current = setTimeout(() => {
        dispatch({ type: 'clear-active-read' });
        activeReadClearTimerRef.current = null;
      }, 900);
    } else {
      activeReadClearTimerRef.current = null;
    }
  }, []);

  const handleInterim = useCallback((text) => {
    startTransition(() => {
      dispatch({ type: 'apply-interim', text });
    });
  }, []);

  const {
    isListening,
    isSupported,
    isDisplayAudioSupported,
    micError,
    start,
    stop,
    AUDIO_SOURCE,
  } = useSpeechRecognition({
    onWords: handleWords,
    onInterim: handleInterim,
  });

  useEffect(() => {
    dispatch({ type: 'load-start' });
    try {
      const selection = navigationMode === 'page'
        ? getPageSelection(clamp(pageNum, 1, TOTAL_PAGES))
        : getSurahSelection(surahNum, ayahNum);

      expectedSessionRef.current = selection.session;
      pendingSpokenChunkRef.current = null;
      stateRef.current = {
        wordStates: initWordStates(selection.session.canonicalWords.length),
        currentWordIndex: 0,
        currentAlignmentIndex: 0,
      };

      dispatch({
        type: 'load-success',
        verses: selection.ayahs,
        session: selection.session,
        totalWords: selection.session.canonicalWords.length,
      });
    } catch (error) {
      dispatch({
        type: 'load-error',
        message: error instanceof Error ? error.message : 'Failed to load the selected reading range.',
      });
    }
  }, [navigationMode, pageNum, surahNum, ayahNum]);

  const resetForNavigation = useCallback(() => {
    if (isListening) stop();
    if (activeReadClearTimerRef.current) {
      clearTimeout(activeReadClearTimerRef.current);
      activeReadClearTimerRef.current = null;
    }
    stateRef.current = {
      wordStates: initWordStates(expectedSessionRef.current.canonicalWords.length),
      currentWordIndex: 0,
      currentAlignmentIndex: 0,
    };
    pendingSpokenChunkRef.current = null;
    dispatch({ type: 'clear-session' });
  }, [isListening, stop]);

  const handleModeChange = useCallback((nextMode) => {
    if (nextMode === navigationMode) return;
    resetForNavigation();
    startTransition(() => {
      setNavigationMode(nextMode);
    });
  }, [navigationMode, resetForNavigation]);

  const handlePageChange = useCallback((nextPage) => {
    const normalizedPage = clamp(nextPage, 1, TOTAL_PAGES);
    if (normalizedPage === pageNum && navigationMode === 'page') return;
    resetForNavigation();
    startTransition(() => {
      setNavigationMode('page');
      setPageNum(normalizedPage);
    });
  }, [navigationMode, pageNum, resetForNavigation]);

  const handleSurahAyahChange = useCallback(({ surahNum: nextSurah, ayahNum: nextAyah }) => {
    if (nextSurah === surahNum && nextAyah === ayahNum && navigationMode === 'surah') return;
    resetForNavigation();
    startTransition(() => {
      setNavigationMode('surah');
      setSurahNum(nextSurah);
      setAyahNum(nextAyah);
    });
  }, [ayahNum, navigationMode, resetForNavigation, surahNum]);

  const handleStartStop = async () => {
    if (isListening) {
      stop();
      pendingSpokenChunkRef.current = null;
      if (activeReadClearTimerRef.current) {
        clearTimeout(activeReadClearTimerRef.current);
        activeReadClearTimerRef.current = null;
      }
      dispatch({ type: 'clear-active-read' });
      return;
    }

    const started = await start({ source: audioSource });
    if (started) {
      dispatch({ type: 'start-session' });
    }
  };

  const handleReset = () => {
    if (isListening) stop();
    pendingSpokenChunkRef.current = null;
    if (activeReadClearTimerRef.current) {
      clearTimeout(activeReadClearTimerRef.current);
      activeReadClearTimerRef.current = null;
    }
    stateRef.current = {
      wordStates: initWordStates(expectedSessionRef.current.canonicalWords.length),
      currentWordIndex: 0,
      currentAlignmentIndex: 0,
    };
    dispatch({ type: 'reset-session' });
  };

  const selectionInfo = buildSelectionInfo(ayahs, navigationMode, pageNum);
  const totalRead = wordStates.filter(wordState => wordState !== WORD_STATE.PENDING).length;
  const missedCount = wordStates.filter(
    wordState => wordState === WORD_STATE.MISTAKE || wordState === WORD_STATE.SKIPPED,
  ).length;
  const correctCount = wordStates.filter(wordState => wordState === WORD_STATE.CORRECT).length;
  const currentPosition = sessionStarted
    ? getCurrentPositionFromSession(session, currentWordIndex)
    : null;
  const pageRange = getPageRange(ayahs);

  return (
    <div className="min-h-screen app-shell text-stone-100">
      <div className="app-atmosphere" />

      <header className="border-b border-white/10 bg-[#08110c]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-300/20 bg-gradient-to-br from-amber-200/20 to-emerald-500/20 shadow-[0_18px_45px_rgba(0,0,0,0.35)]">
              <span className="arabic-text text-2xl text-amber-100">ق</span>
            </div>

            <div>
              <div className="text-[0.68rem] uppercase tracking-[0.28em] text-amber-100/45">Madani Recitation Studio</div>
              <h1 className="kitab-heading text-3xl leading-none text-stone-50">Quran Recitation Tracker</h1>
              <p className="mt-1 text-sm text-stone-300/70">
                Mushaf-inspired reading, live tracking, and class-friendly review.
              </p>
            </div>
          </div>

          <div className="hidden lg:grid grid-cols-3 gap-3">
            <MetaChip label="Mode" value={navigationMode === 'page' ? 'Page Reader' : 'Surah Focus'} />
            <MetaChip label="Correct" value={`${correctCount}`} />
            <MetaChip label="Missed" value={`${missedCount}`} />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[340px,minmax(0,1fr)] lg:px-8">
        <aside className="space-y-5 lg:sticky lg:top-6 self-start">
          <section className="panel-surface p-5">
            <ReadingNavigator
              mode={navigationMode}
              pageNum={pageNum}
              surahNum={surahNum}
              ayahNum={ayahNum}
              onModeChange={handleModeChange}
              onPageChange={handlePageChange}
              onSurahAyahChange={handleSurahAyahChange}
            />
          </section>

          <section className="panel-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Recitation Session</div>
                <h2 className="kitab-heading mt-1 text-2xl text-stone-50">{selectionInfo.title}</h2>
                <p className="mt-1 text-sm text-stone-300/70">{selectionInfo.subtitle}</p>
              </div>

              {isListening && (
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
                  <span className="recording-pulse inline-block h-2.5 w-2.5 rounded-full bg-emerald-300" />
                  Listening
                </div>
              )}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <MetaChip label="Tracked" value={`${totalRead} words`} />
              <MetaChip label="Selection" value={selectionInfo.detail} />
              <MetaChip
                label="Position"
                value={currentPosition ? `Ayah ${currentPosition.ayah}` : 'Awaiting speech'}
              />
              <MetaChip
                label="Page"
                value={currentPosition?.page ? `Page ${currentPosition.page}` : pageRange ? `Page ${pageRange.first}` : 'Not loaded'}
              />
            </div>

            <div className="mt-5">
              <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Audio Source</div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setAudioSource(AUDIO_SOURCE.MICROPHONE)}
                  disabled={isListening}
                  className={`rounded-[1.25rem] border px-4 py-3 text-left transition ${
                    audioSource === AUDIO_SOURCE.MICROPHONE
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                      : 'border-white/10 bg-white/5 text-stone-200 hover:bg-white/10'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <div className="text-sm font-semibold">Microphone</div>
                  <div className="mt-1 text-xs text-current/75">
                    Use the laptop mic or the browser’s current speech input.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setAudioSource(AUDIO_SOURCE.DISPLAY_AUDIO)}
                  disabled={isListening || !isDisplayAudioSupported}
                  className={`rounded-[1.25rem] border px-4 py-3 text-left transition ${
                    audioSource === AUDIO_SOURCE.DISPLAY_AUDIO
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                      : 'border-white/10 bg-white/5 text-stone-200 hover:bg-white/10'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <div className="text-sm font-semibold">Share Zoom Audio</div>
                  <div className="mt-1 text-xs text-current/75">
                    Pick a tab, window, or screen in Chrome and enable audio sharing.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setAudioSource(AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC)}
                  disabled={isListening || !isDisplayAudioSupported}
                  className={`rounded-[1.25rem] border px-4 py-3 text-left transition ${
                    audioSource === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                      : 'border-white/10 bg-white/5 text-stone-200 hover:bg-white/10'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <div className="text-sm font-semibold">Share Audio + Mic</div>
                  <div className="mt-1 text-xs text-current/75">
                    Mix the shared source with the microphone into one live track.
                  </div>
                </button>
              </div>

              <p className="mt-3 text-xs leading-5 text-stone-300/65">
                <code>Share Zoom Audio</code> keeps the browser audio-only path. <code>Share Audio + Mic</code> mixes the shared source and microphone together, but Chrome still has to expose that tab, window, or screen audio in the share picker.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={handleStartStop}
                disabled={!isSupported || isLoading || ayahs.length === 0}
                className={`inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all ${
                  isListening
                    ? 'bg-red-500 text-white shadow-[0_16px_32px_rgba(220,38,38,0.28)]'
                    : 'bg-emerald-500 text-[#062010] shadow-[0_18px_36px_rgba(16,185,129,0.3)] disabled:cursor-not-allowed disabled:opacity-40'
                }`}
              >
                {isListening
                  ? 'Stop Listening'
                  : audioSource === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
                    ? 'Start Mixed Capture'
                    : audioSource === AUDIO_SOURCE.DISPLAY_AUDIO
                    ? 'Start Shared Audio'
                    : 'Start Listening'}
              </button>

              <button
                onClick={handleReset}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-medium text-stone-100 transition hover:bg-white/10"
              >
                Reset Session
              </button>
            </div>

            {!isSupported && (
              <div className="mt-4 rounded-2xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
                Speech recognition is not supported in this browser. Use Chrome for the live tracker.
              </div>
            )}

            {micError && (
              <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {micError}
              </div>
            )}

            <div className="mt-5 rounded-[1.75rem] border border-white/10 bg-[#0c1711] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between gap-3 text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">
                <span>Live Transcript</span>
                <span>{interimText ? 'Hearing…' : lastHeard ? 'Last Heard' : 'Ready'}</span>
              </div>

              <div className="mt-3 min-h-[96px] rounded-[1.25rem] border border-white/6 bg-black/20 px-4 py-3">
                {interimText ? (
                  <span className="arabic-text text-[2rem] leading-[1.8] text-amber-100">{interimText}</span>
                ) : lastHeard ? (
                  <span className="arabic-text text-[2rem] leading-[1.8] text-stone-200/80">{lastHeard}</span>
                ) : (
                  <span className="text-sm italic text-stone-400/75">
                    Start reciting and the tracker will follow along word by word.
                  </span>
                )}
              </div>
            </div>
          </section>

          <MistakesSummary
            ayahs={ayahs}
            wordStates={wordStates}
            onReset={handleReset}
          />
        </aside>

        <section className="space-y-5">
          <div className="panel-surface overflow-hidden">
            <div className="flex flex-col gap-5 border-b border-black/10 bg-gradient-to-r from-[#f0dfb8]/95 via-[#ead4a8]/94 to-[#e7c891]/95 px-5 py-5 text-stone-800 sm:px-8">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="text-[0.68rem] uppercase tracking-[0.24em] text-stone-500">{selectionInfo.eyebrow}</div>
                  <h2 className="kitab-heading mt-2 text-4xl leading-none text-stone-900">{selectionInfo.title}</h2>
                  <p className="mt-2 max-w-2xl text-sm text-stone-700/80">{selectionInfo.subtitle}</p>
                </div>

                {navigationMode === 'page' && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handlePageChange(pageNum - 1)}
                      disabled={pageNum <= 1}
                      className="reader-nav-button"
                    >
                      Previous Page
                    </button>
                    <div className="rounded-full border border-black/10 bg-white/60 px-4 py-2 text-sm text-stone-700">
                      Page {pageNum} / {TOTAL_PAGES}
                    </div>
                    <button
                      onClick={() => handlePageChange(pageNum + 1)}
                      disabled={pageNum >= TOTAL_PAGES}
                      className="reader-nav-button"
                    >
                      Next Page
                    </button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="ornament-chip">{selectionInfo.surahLabel}</span>
                {pageRange && (
                  <span className="ornament-chip">
                    {pageRange.first === pageRange.last ? `Page ${pageRange.first}` : `Pages ${pageRange.first}-${pageRange.last}`}
                  </span>
                )}
                <span className="ornament-chip">{countWords(ayahs)} words in focus</span>
                {currentPosition && (
                  <span className="ornament-chip">
                    Tracking {getSurahName(currentPosition.surah)} · ayah {currentPosition.ayah}
                  </span>
                )}
              </div>
            </div>

            <QuranDisplay
              ayahs={ayahs}
              wordStates={wordStates}
              activeWordIndexes={sessionStarted ? activeWordIndexes : []}
              currentWordIndex={sessionStarted ? currentWordIndex : -1}
              isLoading={isLoading}
              error={loadError}
              mode={navigationMode}
              pageNumber={pageNum}
            />
          </div>

          <div className="panel-surface p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Reading Guide</div>
                <p className="mt-1 text-sm text-stone-300/75">
                  The page view follows the Madani line flow. Gold highlights the next expected word, green confirms correct recitation, amber marks skipped words, and the cool glow shows the phrase currently being heard even during rereads.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <LegendItem state="pending" label="Not yet read" />
                <LegendItem state="current" label="Expected next" />
                <LegendItem state="live" label="Reading now" />
                <LegendItem state="correct" label="Correct" />
                <LegendItem state="mistake" label="Mistake" />
                <LegendItem state="skipped" label="Skipped" />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
