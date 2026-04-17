import { getArabicWordVariants, splitIntoWords } from '../utils/arabicNormalize.js';

function syncProcess(transcript, isInterim) {
  const words = splitIntoWords(transcript);

  return {
    words,
    normalizedWords: words.map(getArabicWordVariants),
    wordCount: words.length,
    isInterim,
  };
}

export function createAsrProcessorService() {
  let worker = null;
  let ready = false;
  let requestId = 0;
  const callbacks = new Map();

  try {
    worker = new Worker(
      new URL('../workers/asrProcessorWorker.js', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (event) => {
      const { type, id, result } = event.data ?? {};

      if (type === 'ready') {
        ready = true;
        return;
      }

      if (type === 'processed' && typeof id === 'number') {
        const callback = callbacks.get(id);
        if (!callback) return;
        callbacks.delete(id);
        callback(result);
      }
    };

    worker.onerror = () => {
      ready = false;
    };
  } catch {
    worker = null;
    ready = false;
  }

  const process = (transcript, isInterim, callback) => {
    if (!worker || !ready) {
      callback(syncProcess(transcript, isInterim));
      return;
    }

    requestId += 1;
    callbacks.set(requestId, callback);
    worker.postMessage({
      type: isInterim ? 'process-interim' : 'process-final',
      id: requestId,
      data: { transcript },
    });
  };

  return {
    processInterim(transcript, callback) {
      process(transcript, true, callback);
    },
    processFinal(transcript, callback) {
      process(transcript, false, callback);
    },
    dispose() {
      callbacks.clear();
      worker?.terminate();
      worker = null;
      ready = false;
    },
  };
}
