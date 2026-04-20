import { useEffect, useMemo, useRef, useState } from 'react';
import { createAsrProcessorService } from '../services/asrProcessorService.js';
import { createLocalMacProvider } from '../transcription/providerRegistry.js';

function getBridge() {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.tarteelDesktopAudio ?? null;
}

function getTranscriptMeta(payload) {
  return {
    averageTokenProbability: Number(payload?.avgTokenProb ?? NaN),
    minimumTokenProbability: Number(payload?.minTokenProb ?? NaN),
    noSpeechProbability: Number(payload?.noSpeechProb ?? NaN),
    audioAverageLevel: Number(payload?.audioAvgLevel ?? NaN),
    audioRms: Number(payload?.audioRms ?? NaN),
    audioPeak: Number(payload?.audioPeak ?? NaN),
    audioActiveRatio: Number(payload?.audioActiveRatio ?? NaN),
    decodeMs: Number(payload?.decodeMs ?? NaN),
    windowStartMs: Number(payload?.windowStartMs ?? NaN),
  };
}

function shouldIgnoreTranscriptPayload(payload) {
  const averageTokenProbability = Number(payload?.avgTokenProb ?? NaN);
  const noSpeechProbability = Number(payload?.noSpeechProb ?? NaN);
  const audioActiveRatio = Number(payload?.audioActiveRatio ?? NaN);
  const audioRms = Number(payload?.audioRms ?? NaN);

  if (Number.isFinite(averageTokenProbability) && averageTokenProbability < 0.24) {
    return true;
  }

  if (
    Number.isFinite(noSpeechProbability) &&
    Number.isFinite(averageTokenProbability) &&
    noSpeechProbability >= 0.6 &&
    averageTokenProbability < 0.45
  ) {
    return true;
  }

  if (
    Number.isFinite(audioActiveRatio) &&
    Number.isFinite(noSpeechProbability) &&
    audioActiveRatio < 0.01 &&
    noSpeechProbability >= 0.45
  ) {
    return true;
  }

  if (
    Number.isFinite(audioRms) &&
    Number.isFinite(averageTokenProbability) &&
    audioRms < 0.005 &&
    averageTokenProbability < 0.4
  ) {
    return true;
  }

  return false;
}

export function useNativeDesktopTranscription({ onWords, onInterim, enabled = true, engine = null }) {
  const bridge = useMemo(() => getBridge(), []);
  const [isListening, setIsListening] = useState(false);
  const [micError, setMicError] = useState(null);
  const [backendInfo, setBackendInfo] = useState(null);
  const onWordsRef = useRef(onWords);
  const onInterimRef = useRef(onInterim);
  const processorRef = useRef(null);
  const lastErrorRef = useRef(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    onWordsRef.current = onWords;
  }, [onWords]);

  useEffect(() => {
    onInterimRef.current = onInterim;
  }, [onInterim]);

  useEffect(() => {
    if (!enabled || !bridge?.isAvailable) {
      return undefined;
    }

    processorRef.current = createAsrProcessorService();
    let removeListener = () => {};
    let cancelled = false;

    bridge.getInfo(engine ? { engine } : undefined).then((info) => {
      if (!cancelled) {
        setBackendInfo(info);
      }
    }).catch((error) => {
      if (!cancelled) {
        setMicError(error.message);
      }
    });

    removeListener = bridge.onEvent((payload) => {
      if (!payload) {
        return;
      }

      if (payload.type === 'ready') {
        lastErrorRef.current = null;
        stopRequestedRef.current = false;
        setBackendInfo((previous) => ({
          ...(previous ?? {}),
          available: true,
          ready: true,
          missing: [],
          mode: payload.mode ?? previous?.mode ?? null,
          modelType: payload.modelType ?? previous?.modelType ?? null,
        }));
        setIsListening(true);
        setMicError(null);
        return;
      }

      if (payload.type === 'transcript' && typeof payload.text === 'string') {
        if (shouldIgnoreTranscriptPayload(payload)) {
          onInterimRef.current?.('');
          return;
        }

        const meta = getTranscriptMeta(payload);
        processorRef.current?.processFinal(payload.text, (processed) => {
          onWordsRef.current?.({
            ...processed,
            meta,
          });
        });
        onInterimRef.current?.('');
        return;
      }

      if (payload.type === 'error') {
        stopRequestedRef.current = false;
        lastErrorRef.current = payload.message ?? 'The native local transcription backend failed.';
        setIsListening(false);
        setMicError(payload.message ?? 'The native local transcription backend failed.');
        return;
      }

      if (payload.type === 'stopped') {
        setIsListening(false);
        if (stopRequestedRef.current) {
          stopRequestedRef.current = false;
          lastErrorRef.current = null;
          setMicError(null);
          return;
        }

        if (!lastErrorRef.current && (payload.code !== 0 || payload.signal)) {
          setMicError('The native macOS capture session stopped unexpectedly.');
        }
      }
    });

    return () => {
      cancelled = true;
      removeListener();
      processorRef.current?.dispose();
      processorRef.current = null;
    };
  }, [bridge, enabled, engine]);

  const provider = useMemo(
    () => createLocalMacProvider(backendInfo),
    [backendInfo],
  );

  return {
    provider,
    isListening,
    isSupported: Boolean(enabled && bridge?.isAvailable && backendInfo?.ready),
    isDisplayAudioSupported: Boolean(enabled && bridge?.isAvailable && backendInfo?.ready),
    micError,
    async start(startOptions = {}) {
      if (!enabled || !bridge?.isAvailable) {
        return false;
      }

      const payload = typeof startOptions === 'object' && startOptions !== null
        ? { ...startOptions }
        : {};

      if (engine && !payload.engine) {
        payload.engine = engine;
      }

      const result = await bridge.start(payload);
      if (!result?.ok) {
        stopRequestedRef.current = false;
        lastErrorRef.current = result?.error ?? 'The native local transcription backend could not start.';
        setMicError(result?.error ?? 'The native local transcription backend could not start.');
        return false;
      }

      stopRequestedRef.current = false;
      lastErrorRef.current = null;
      setMicError(null);
      return true;
    },
    async stop() {
      if (!enabled || !bridge?.isAvailable) {
        return;
      }

      stopRequestedRef.current = true;
      lastErrorRef.current = null;
      setMicError(null);
      await bridge.stop();
      setIsListening(false);
    },
  };
}
