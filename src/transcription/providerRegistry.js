import { CAPTURE_MODE } from '../audio/captureModes.js';

export const WEB_SPEECH_PROVIDER = {
  id: 'web-speech-prototype',
  label: 'Web Speech Prototype',
  supportStatus: 'Prototype backend',
  summary: 'The current live transcription path still depends on browser/Electron speech recognition and capture permissions.',
  roadmap: 'Target desktop backend: native macOS system-audio capture plus a non-browser ASR engine.',
  captureModes: [
    {
      id: CAPTURE_MODE.MICROPHONE,
      label: 'Microphone',
      description: 'Use the laptop mic or the current system input device.',
    },
    {
      id: CAPTURE_MODE.DISPLAY_AUDIO,
      label: 'Share Zoom Audio',
      description: 'Choose a tab, window, or screen and enable audio sharing.',
    },
    {
      id: CAPTURE_MODE.DISPLAY_AUDIO_WITH_MIC,
      label: 'Share Audio + Mic',
      description: 'Mix the shared source with the microphone into one live track.',
    },
  ],
};

function formatLocalBackendLabel(info) {
  const engine = info?.engine ?? 'whisper';

  if (engine === 'wav2vec2') {
    return info?.wav2vec2ModelId
      ? `Wav2Vec2 Quran (${info.wav2vec2ModelId})`
      : 'Wav2Vec2 Quran';
  }

  if (!info?.modelName) {
    return 'whisper.cpp';
  }

  return `Whisper ${info.modelName}`;
}

export function createLocalMacProvider(info = null) {
  const modelLabel = formatLocalBackendLabel(info);
  const supportStatus = info?.ready
    ? 'Local macOS backend'
    : 'Local macOS backend unavailable';

  const summary = info?.ready
    ? `This app captures desktop audio plus microphone directly through macOS and transcribes locally with ${modelLabel}.`
    : info?.missing?.length
      ? info.missing.join(' ')
      : 'The native backend is only available from the packaged macOS desktop app.';

  return {
    id: 'local-mac-whisper',
    label: 'Local Mac Audio',
    supportStatus,
    summary,
    roadmap: 'No browser speech service or screen-sharing flow is involved when the native desktop backend is active.',
    captureModes: [
      {
        id: CAPTURE_MODE.DISPLAY_AUDIO_WITH_MIC,
        label: 'Desktop Audio + Mic',
        description: 'Capture Zoom or system audio together with the microphone as one local desktop session.',
      },
    ],
  };
}
