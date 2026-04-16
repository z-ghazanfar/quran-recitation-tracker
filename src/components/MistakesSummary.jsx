import { memo, useMemo } from 'react';
import { WORD_STATE } from '../utils/wordMatcher.js';

function Stat({ label, value, tone = 'default' }) {
  return (
    <div className={`summary-stat summary-stat-${tone}`}>
      <div className="text-[0.62rem] uppercase tracking-[0.18em] opacity-60">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function MistakesSummary({ ayahs, wordStates, onReset }) {
  const { mistakes, skipped, correct, tracked, accuracy } = useMemo(() => {
    if (!ayahs || ayahs.length === 0) {
      return {
        mistakes: [],
        skipped: [],
        correct: 0,
        tracked: 0,
        accuracy: 0,
      };
    }

    const nextMistakes = [];
    const nextSkipped = [];
    let nextCorrect = 0;
    let nextTracked = 0;
    let flatIndex = 0;

    for (const ayah of ayahs) {
      for (const word of ayah.words) {
        const state = wordStates[flatIndex];
        if (state !== undefined && state !== WORD_STATE.PENDING) nextTracked += 1;
        if (state === WORD_STATE.CORRECT) nextCorrect += 1;
        if (state === WORD_STATE.MISTAKE) nextMistakes.push({ word, ayah: ayah.numberInSurah });
        if (state === WORD_STATE.SKIPPED) nextSkipped.push({ word, ayah: ayah.numberInSurah });
        flatIndex += 1;
      }
    }

    return {
      mistakes: nextMistakes,
      skipped: nextSkipped,
      correct: nextCorrect,
      tracked: nextTracked,
      accuracy: nextTracked > 0 ? Math.round((nextCorrect / nextTracked) * 100) : 0,
    };
  }, [ayahs, wordStates]);

  if (!ayahs || ayahs.length === 0) {
    return null;
  }

  return (
    <section className="panel-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Session Review</div>
          <h3 className="kitab-heading mt-1 text-2xl text-stone-50">Mistake Summary</h3>
          <p className="mt-1 text-sm text-stone-300/70">
            Review skipped words and slips after each student finishes reciting.
          </p>
        </div>

        <button
          onClick={onReset}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-200 transition hover:bg-white/10"
        >
          Reset
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Stat label="Accuracy" value={`${accuracy}%`} />
        <Stat label="Tracked" value={tracked} />
        <Stat label="Correct" value={correct} tone="success" />
        <Stat label="Missed" value={mistakes.length + skipped.length} tone="warning" />
      </div>

      {tracked === 0 ? (
        <div className="mt-5 rounded-[1.4rem] border border-white/10 bg-[#0b1711] px-4 py-4 text-sm text-stone-400">
          No recitation has been tracked yet. Start listening and the mistakes review will fill in automatically.
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <SummarySection
            title="Skipped / Missed"
            emptyLabel="No skipped words"
            items={skipped}
            className="summary-chip summary-chip-warning"
          />
          <SummarySection
            title="Pronunciation / Match Slips"
            emptyLabel="No mismatch words"
            items={mistakes}
            className="summary-chip summary-chip-danger"
          />
        </div>
      )}
    </section>
  );
}

export default memo(MistakesSummary);

function SummarySection({ title, emptyLabel, items, className }) {
  return (
    <div>
      <div className="mb-2 text-[0.68rem] uppercase tracking-[0.22em] text-amber-100/45">{title}</div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-2 justify-end" dir="rtl">
          {items.map((item, index) => (
            <span key={`${item.word}-${item.ayah}-${index}`} className={className}>
              {item.word}
              <span className="summary-chip-meta">({item.ayah})</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="rounded-[1.2rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-stone-400">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
