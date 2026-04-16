import { memo, useEffect, useRef, useState } from 'react';
import { SURAHS, TOTAL_PAGES } from '../data/quranMeta.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ModeButton({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        active
          ? 'bg-[#ead6ac] text-stone-900 shadow-[0_10px_18px_rgba(0,0,0,0.12)]'
          : 'text-stone-300/80 hover:bg-white/5 hover:text-stone-100'
      }`}
    >
      {label}
    </button>
  );
}

function ReadingNavigator({
  mode,
  pageNum,
  surahNum,
  ayahNum,
  onModeChange,
  onPageChange,
  onSurahAyahChange,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);

  const selectedSurah = SURAHS.find(surah => surah.num === surahNum);
  const maxAyah = selectedSurah?.ayahs ?? 1;
  const ayahOptions = Array.from({ length: maxAyah }, (_, index) => index + 1);
  const filtered = query
    ? SURAHS.filter(surah =>
        surah.name.toLowerCase().includes(query.toLowerCase()) ||
        String(surah.num).includes(query)
      )
    : SURAHS;

  useEffect(() => {
    const handlePointerDown = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
        setQuery('');
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const commitPage = value => {
    if (Number.isNaN(value)) return;
    onPageChange(clamp(value, 1, TOTAL_PAGES));
  };

  const selectSurah = surah => {
    onSurahAyahChange({ surahNum: surah.num, ayahNum: 1 });
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Navigator</div>
        <h2 className="kitab-heading mt-1 text-2xl text-stone-50">Choose How To Read</h2>
        <p className="mt-1 text-sm text-stone-300/70">
          Jump straight to a Madani page or begin from a specific surah and ayah.
        </p>
      </div>

      <div className="flex rounded-full border border-white/10 bg-[#0b1711] p-1">
        <ModeButton active={mode === 'page'} label="Page" onClick={() => onModeChange('page')} />
        <ModeButton active={mode === 'surah'} label="Surah / Ayah" onClick={() => onModeChange('surah')} />
      </div>

      {mode === 'page' ? (
        <div className="rounded-[1.75rem] border border-white/10 bg-[#0b1711] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Madani Page</div>
              <div className="mt-1 text-sm text-stone-300/70">Flip through the Mushaf page by page.</div>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-stone-300">
              1 to {TOTAL_PAGES}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-[auto,1fr,auto] gap-2">
            <button
              onClick={() => commitPage(pageNum - 1)}
              disabled={pageNum <= 1}
              className="navigator-arrow"
            >
              ‹
            </button>

            <label className="rounded-[1.3rem] border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-[0.62rem] uppercase tracking-[0.2em] text-amber-100/45">Page</span>
              <input
                type="number"
                min="1"
                max={TOTAL_PAGES}
                value={pageNum}
                onChange={event => commitPage(Number(event.target.value))}
                className="mt-1 w-full bg-transparent text-lg font-medium text-stone-50 outline-none"
              />
            </label>

            <button
              onClick={() => commitPage(pageNum + 1)}
              disabled={pageNum >= TOTAL_PAGES}
              className="navigator-arrow"
            >
              ›
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-[1.75rem] border border-white/10 bg-[#0b1711] p-4">
          <div>
            <div className="text-[0.68rem] uppercase tracking-[0.24em] text-amber-100/45">Surah & Ayah</div>
            <div className="mt-1 text-sm text-stone-300/70">Start anywhere and continue through the rest of the surah.</div>
          </div>

          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setOpen(value => !value)}
              className="flex w-full items-center justify-between rounded-[1.3rem] border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-stone-100 transition hover:bg-white/10"
            >
              <span>{selectedSurah ? `${selectedSurah.num}. ${selectedSurah.name}` : 'Select Surah'}</span>
              <span className={`text-stone-400 transition ${open ? 'rotate-180' : ''}`}>⌄</span>
            </button>

            {open && (
              <div className="absolute left-0 top-full z-50 mt-2 w-full overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#08110c] shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
                <div className="border-b border-white/10 p-3">
                  <input
                    autoFocus
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search surah..."
                    className="w-full rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-stone-50 outline-none placeholder:text-stone-400"
                  />
                </div>

                <div className="max-h-72 overflow-y-auto">
                  {filtered.map(surah => (
                    <button
                      key={surah.num}
                      onClick={() => selectSurah(surah)}
                      className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition ${
                        surah.num === surahNum
                          ? 'bg-[#ead6ac]/12 text-amber-100'
                          : 'text-stone-200 hover:bg-white/5'
                      }`}
                    >
                      <span>
                        <span className="mr-2 text-stone-500">{surah.num}.</span>
                        {surah.name}
                      </span>
                      <span className="text-xs text-stone-500">{surah.ayahs} ayahs</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-[auto,1fr] items-center gap-3 rounded-[1.3rem] border border-white/10 bg-white/5 px-4 py-3">
            <span className="text-sm text-stone-400">Ayah</span>
            <select
              value={ayahNum}
              onChange={event => onSurahAyahChange({ surahNum, ayahNum: Number(event.target.value) })}
              className="bg-transparent text-right text-lg font-medium text-stone-50 outline-none"
            >
              {ayahOptions.map(ayahOption => (
                <option key={ayahOption} value={ayahOption} className="bg-[#0b1711] text-stone-50">
                  {ayahOption}
                </option>
              ))}
            </select>
          </div>

          {selectedSurah && (
            <div className="rounded-[1.2rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-stone-300/70">
              {selectedSurah.ayahs - ayahNum + 1} ayahs remain from this starting point.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ReadingNavigator);
