import { useEffect, useRef, useCallback, useState } from 'react';
import { createAsrProcessorService } from '../services/asrProcessorService.js';

const STABLE_INTERIM_COMMIT_MS = 320;
const AUDIO_SOURCE = {
  MICROPHONE: 'microphone',
  DISPLAY_AUDIO: 'display-audio',
  DISPLAY_AUDIO_WITH_MIC: 'display-audio-with-mic',
};

function getCommonPrefixLength(previousWords, nextWords) {
  const limit = Math.min(previousWords.length, nextWords.length);
  let index = 0;

  while (index < limit && previousWords[index] === nextWords[index]) {
    index += 1;
  }

  return index;
}

export function useSpeechRecognition({ onWords, onInterim }) {
  const recognitionRef = useRef(null);
  const [isListening, setIsListening] = useState(false);
  const [micError, setMicError] = useState(null);
  const [isSupported] = useState(
    () => !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const [isDisplayAudioSupported] = useState(
    () => !!navigator.mediaDevices?.getDisplayMedia
  );
  const activeRef = useRef(false);
  const terminalErrorRef = useRef(null);
  const emittedWordsRef = useRef(new Map());
  const latestInterimResultsRef = useRef(new Map());
  const stableCommitTimersRef = useRef(new Map());
  const sourceRef = useRef(AUDIO_SOURCE.MICROPHONE);
  const sourceTrackRef = useRef(null);
  const displayStreamRef = useRef(null);
  const micStreamRef = useRef(null);
  const mixedStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const trackEndedCleanupRef = useRef([]);

  // Keep callbacks in refs so the recognition handler always calls the latest version
  // (avoids stale closure — the effect only runs once but callbacks can change)
  const onWordsRef = useRef(onWords);
  const onInterimRef = useRef(onInterim);
  useEffect(() => { onWordsRef.current = onWords; });
  useEffect(() => { onInterimRef.current = onInterim; });

  const stopSourceCapture = useCallback(() => {
    for (const cleanup of trackEndedCleanupRef.current) {
      cleanup();
    }
    trackEndedCleanupRef.current = [];

    if (mixedStreamRef.current) {
      for (const track of mixedStreamRef.current.getTracks()) {
        track.stop();
      }
    }

    if (displayStreamRef.current) {
      for (const track of displayStreamRef.current.getTracks()) {
        track.stop();
      }
    }

    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) {
        track.stop();
      }
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {
        // Ignore close races during teardown.
      });
    }

    sourceTrackRef.current = null;
    displayStreamRef.current = null;
    micStreamRef.current = null;
    mixedStreamRef.current = null;
    audioContextRef.current = null;
    sourceRef.current = AUDIO_SOURCE.MICROPHONE;
  }, []);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const asrProcessor = createAsrProcessorService();
    const recognition = new SR();
    recognition.lang = 'ar';           // 'ar' is more compatible than 'ar-SA'
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const clearStableCommitTimer = (resultIndex) => {
      const timer = stableCommitTimersRef.current.get(resultIndex);
      if (timer) {
        clearTimeout(timer);
        stableCommitTimersRef.current.delete(resultIndex);
      }
    };

    const clearAllStableCommitTimers = () => {
      for (const timer of stableCommitTimersRef.current.values()) {
        clearTimeout(timer);
      }
      stableCommitTimersRef.current.clear();
    };

    const emitTranscriptUpdate = (resultIndex, processed) => {
      const words = processed?.words ?? [];
      const normalizedWords = processed?.normalizedWords ?? [];
      if (words.length === 0) return;

      const previousWords = emittedWordsRef.current.get(resultIndex) ?? [];
      const commonPrefixLength = getCommonPrefixLength(previousWords, words);

      if (
        commonPrefixLength === previousWords.length &&
        commonPrefixLength === words.length
      ) {
        return;
      }

      const overlapStart = Math.max(0, commonPrefixLength - 1);
      const incrementalWords = words.slice(overlapStart);
      if (incrementalWords.length === 0) return;

      onWordsRef.current?.({
        ...processed,
        words: incrementalWords,
        normalizedWords: normalizedWords.slice(overlapStart),
      });
      emittedWordsRef.current.set(resultIndex, words);
    };

    const scheduleStableCommit = (resultIndex, transcript) => {
      clearStableCommitTimer(resultIndex);

      const timer = setTimeout(() => {
        stableCommitTimersRef.current.delete(resultIndex);
        const latestEntry = latestInterimResultsRef.current.get(resultIndex);

        if (!activeRef.current || !latestEntry || latestEntry.transcript !== transcript) {
          return;
        }

        emitTranscriptUpdate(resultIndex, latestEntry.processed);
      }, STABLE_INTERIM_COMMIT_MS);

      stableCommitTimersRef.current.set(resultIndex, timer);
    };

    recognition.onstart = () => {
      emittedWordsRef.current = new Map();
      latestInterimResultsRef.current = new Map();
      clearAllStableCommitTimers();
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      let latestInterim = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();

        if (result.isFinal) {
          clearStableCommitTimer(i);
          latestInterimResultsRef.current.delete(i);
          asrProcessor.processFinal(transcript, (processed) => {
            emitTranscriptUpdate(i, processed);
          });
        } else {
          latestInterim = transcript;
          asrProcessor.processInterim(transcript, (processed) => {
            const latestWords = processed?.words ?? [];
            const previousWords = emittedWordsRef.current.get(i) ?? [];
            latestInterimResultsRef.current.set(i, { transcript, processed });

            if (latestWords.length > previousWords.length) {
              emitTranscriptUpdate(i, processed);
            } else if (
              latestWords.length > 0 &&
              latestWords.join(' ') !== previousWords.join(' ')
            ) {
              scheduleStableCommit(i, transcript);
            } else {
              clearStableCommitTimer(i);
            }
          });
        }
      }

      onInterimRef.current?.(latestInterim);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        terminalErrorRef.current = event.error;
        setMicError(
          sourceRef.current === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
            ? 'Shared audio or microphone access was denied. Start again and allow Chrome to capture the selected tab, window, or screen audio, plus the microphone.'
            : sourceRef.current === AUDIO_SOURCE.DISPLAY_AUDIO
              ? 'Shared audio access was denied. Start again and allow Chrome to capture the selected tab, window, or screen audio.'
            : 'Microphone access denied. Please allow microphone access in your browser and try again.'
        );
        activeRef.current = false;
        setIsListening(false);
        stopSourceCapture();
        return;
      }
      if (event.error === 'network') {
        terminalErrorRef.current = event.error;
        activeRef.current = false;
        setIsListening(false);
        setMicError('Speech recognition service could not be reached. Chrome built-in speech recognition needs a stable internet connection.');
        stopSourceCapture();
        return;
      }
      console.warn('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      clearAllStableCommitTimers();

      // Chrome stops recognition after silence — restart automatically if we're still active
      if (activeRef.current && !terminalErrorRef.current) {
        try {
          if (sourceRef.current !== AUDIO_SOURCE.MICROPHONE && sourceTrackRef.current) {
            recognition.start(sourceTrackRef.current);
          } else {
            recognition.start();
          }
        } catch {
          // Ignore invalid-state restarts when Chrome is already spinning up again.
        }
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      activeRef.current = false;
      clearAllStableCommitTimers();
      try {
        recognition.abort();
      } catch {
        // Ignore teardown races when recognition has already stopped.
      }
      recognitionRef.current = null;
      asrProcessor.dispose();
      stopSourceCapture();
    };
  }, [stopSourceCapture]);

  const attachEndedHandler = useCallback((track, handler) => {
    track.addEventListener('ended', handler);
    trackEndedCleanupRef.current.push(() => {
      track.removeEventListener('ended', handler);
    });
  }, []);

  const start = useCallback(async ({ source = AUDIO_SOURCE.MICROPHONE } = {}) => {
    const recognition = recognitionRef.current;
    if (!recognition || activeRef.current) return false;

    terminalErrorRef.current = null;
    setMicError(null);

    let nextTrack = null;

    if (source === AUDIO_SOURCE.DISPLAY_AUDIO || source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC) {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setMicError('Shared audio capture is not supported in this browser.');
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        const [audioTrack] = stream.getAudioTracks();

        if (!audioTrack) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          setMicError('No audio track was shared. In the Chrome share dialog, enable audio and choose the Zoom tab/window or the screen option that includes sound.');
          return false;
        }

        const handleCaptureEnded = () => {
          activeRef.current = false;
          terminalErrorRef.current = 'capture-ended';
          setIsListening(false);
          setMicError(
            source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
              ? 'Shared audio or microphone capture ended. Start again and choose the Zoom or tab audio source.'
              : 'Shared audio ended. Start again and choose the Zoom or tab audio source.'
          );
          try {
            recognition.abort();
          } catch {
            // Ignore if recognition has already stopped.
          }
          stopSourceCapture();
        };

        displayStreamRef.current = stream;

        if (source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC) {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            video: false,
          });

          const audioContext = new window.AudioContext();
          const displayAudioStream = new MediaStream([audioTrack]);
          const destination = audioContext.createMediaStreamDestination();
          const displayNode = audioContext.createMediaStreamSource(displayAudioStream);
          const microphoneNode = audioContext.createMediaStreamSource(micStream);

          displayNode.connect(destination);
          microphoneNode.connect(destination);

          const [mixedTrack] = destination.stream.getAudioTracks();
          if (!mixedTrack) {
            micStream.getTracks().forEach(track => track.stop());
            stream.getTracks().forEach(track => track.stop());
            await audioContext.close().catch(() => {
              // Ignore close races when setup fails.
            });
            setMicError('Chrome could not create a mixed audio track from the shared audio and microphone.');
            return false;
          }

          micStreamRef.current = micStream;
          mixedStreamRef.current = destination.stream;
          audioContextRef.current = audioContext;
          sourceTrackRef.current = mixedTrack;
          sourceRef.current = AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC;

          for (const track of stream.getTracks()) {
            attachEndedHandler(track, handleCaptureEnded);
          }

          for (const track of micStream.getTracks()) {
            attachEndedHandler(track, handleCaptureEnded);
          }

          nextTrack = mixedTrack;
        } else {
          sourceTrackRef.current = audioTrack;
          sourceRef.current = AUDIO_SOURCE.DISPLAY_AUDIO;

          for (const track of stream.getTracks()) {
            attachEndedHandler(track, handleCaptureEnded);
          }

          nextTrack = audioTrack;
        }
      } catch (error) {
        if (error?.name === 'NotAllowedError') {
          setMicError(
            source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
              ? 'Shared audio or microphone capture was cancelled. Start again and choose a tab/window with Share audio enabled, then allow microphone access.'
              : 'Shared audio capture was cancelled. Start again and choose a tab/window with the Share audio option enabled.'
          );
        } else {
          setMicError(
            source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
              ? 'Could not start mixed capture. Chrome must be allowed to capture the shared audio source and the microphone.'
              : 'Could not start shared audio capture. Chrome must be allowed to capture the tab or screen audio.'
          );
        }
        stopSourceCapture();
        return false;
      }
    } else {
      stopSourceCapture();
      sourceRef.current = AUDIO_SOURCE.MICROPHONE;
    }

    activeRef.current = true;
    setIsListening(true);

    try {
      if (nextTrack) {
        recognition.start(nextTrack);
      } else {
        recognition.start();
      }
      return true;
    } catch (e) {
      console.error('Failed to start recognition:', e);
      activeRef.current = false;
      setIsListening(false);
      stopSourceCapture();
      setMicError(
        source === AUDIO_SOURCE.DISPLAY_AUDIO_WITH_MIC
          ? 'Chrome could not start speech recognition from the mixed audio track.'
          : source === AUDIO_SOURCE.DISPLAY_AUDIO
            ? 'Chrome could not start speech recognition from the shared audio track.'
          : 'Failed to start microphone speech recognition.'
      );
      return false;
    }
  }, [attachEndedHandler, stopSourceCapture]);

  const stop = useCallback(() => {
    activeRef.current = false;
    setIsListening(false);
    emittedWordsRef.current = new Map();
    latestInterimResultsRef.current = new Map();
    for (const timer of stableCommitTimersRef.current.values()) {
      clearTimeout(timer);
    }
    stableCommitTimersRef.current.clear();
    try {
      recognitionRef.current?.abort();
    } catch {
      // Ignore stop requests after the recognition instance has already ended.
    }
    stopSourceCapture();
  }, [stopSourceCapture]);

  return {
    isListening,
    isSupported,
    isDisplayAudioSupported,
    micError,
    start,
    stop,
    AUDIO_SOURCE,
  };
}
