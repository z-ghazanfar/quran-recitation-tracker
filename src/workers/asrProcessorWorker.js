import { getArabicWordVariants, splitIntoWords } from '../utils/arabicNormalize.js';

function processTranscript(transcript, isInterim) {
  const words = splitIntoWords(transcript);
  const tokens = words.map(text => ({
    text,
    variants: getArabicWordVariants(text),
  }));

  return {
    words,
    tokens,
    normalizedWords: tokens.map(token => token.variants),
    wordCount: words.length,
    isInterim,
  };
}

self.postMessage({ type: 'ready' });

self.onmessage = (event) => {
  const { type, id, data } = event.data ?? {};

  if (type !== 'process-interim' && type !== 'process-final') {
    return;
  }

  const result = processTranscript(
    data?.transcript ?? '',
    type === 'process-interim',
  );

  self.postMessage({
    type: 'processed',
    id,
    result,
  });
};
