import { useMemo } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition.js';
import { useNativeDesktopTranscription } from './useNativeDesktopTranscription.js';
import { WEB_SPEECH_PROVIDER } from '../transcription/providerRegistry.js';

export function useLiveTranscription({ nativeEngine = null, ...options }) {
  const nativeBridge = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    return window.tarteelDesktopAudio ?? null;
  }, []);

  const preferNative = Boolean(nativeBridge?.isAvailable);
  const nativeRecognition = useNativeDesktopTranscription({
    ...options,
    enabled: preferNative,
    engine: nativeEngine,
  });
  const webRecognition = useSpeechRecognition({
    ...options,
    enabled: !preferNative,
  });
  const provider = useMemo(() => WEB_SPEECH_PROVIDER, []);

  if (preferNative) {
    return nativeRecognition;
  }

  return {
    ...webRecognition,
    provider,
  };
}
