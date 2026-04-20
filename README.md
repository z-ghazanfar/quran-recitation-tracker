# Quran Recitation Tracker

This project is a React/Vite recitation tracker that follows spoken Arabic against a selected Mushaf page or a surah/ayah starting point.

The web app still supports browser-style capture modes:

- Microphone input
- Shared system/window audio
- Shared audio mixed with microphone input

The macOS desktop app now takes a different path: it uses a native ScreenCaptureKit helper to capture desktop audio plus microphone audio and runs local `whisper.cpp` transcription inside the packaged app. That removes the browser speech-recognition dependency from the Mac desktop workflow.

## Experimental Quran ASR (wav2vec2)

There is an optional Quran-specialized ASR backend based on the Hugging Face model `rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final` (Apache-2.0 license):

https://huggingface.co/rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final

This backend runs as a Python sidecar process (the app still uses the native ScreenCaptureKit helper for desktop + mic audio capture), so you need local Python deps and the first run will download model weights.

Install Python deps (use a venv if you prefer):

```bash
python3 -m pip install --upgrade pip
python3 -m pip install torch transformers numpy
```

Enable the engine from the desktop app UI:

- Open the macOS desktop app
- Under `ASR Engine`, choose `Wav2Vec2`

You can also force it via env vars when launching the desktop app:

```bash
TARTEEL_LOCAL_ASR_ENGINE=wav2vec2 npm run desktop:dev
```

Optionally override the model id:

```bash
TARTEEL_LOCAL_ASR_ENGINE=wav2vec2 TARTEEL_WAV2VEC2_MODEL_ID=rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final npm run desktop:dev
```

## Development

Install dependencies and run the web app:

```bash
npm install
npm run dev
```

For local macOS desktop builds, install CMake once:

```bash
brew install cmake
```

Download the default local Whisper model used by the packaged app:

```bash
npm run native:model:download
```

The default bundled model is `large-v3-turbo-q5_0` for better Arabic quality on Apple Silicon. If you want a smaller local bundle, you can override it, for example:

```bash
WHISPER_MODEL_NAME=small npm run native:model:download
```

## Desktop App For macOS

Electron packaging is wired in for macOS so this repo can produce an installable `.app` and `.dmg`.

Run the desktop shell against the Vite dev server:

```bash
npm run desktop:dev
```

Create a local unpacked desktop build:

```bash
npm run desktop:pack
```

Create distributable macOS artifacts:

```bash
npm run desktop:build
```

Artifacts are written to `release/`.

## macOS Distribution Notes

- The packaged app includes the required microphone and system-audio usage descriptions in the app plist.
- The packaged desktop runtime bundles a native Swift capture helper and a local `whisper.cpp` build so it does not depend on Chrome speech recognition or Homebrew's `whisper-cli`.
- The current local transcription build is CPU-first and self-contained so the installer can run on another Apple Silicon Mac without requiring Homebrew.
- For public distribution outside your own machine, you still need Apple Developer signing and notarization. The current setup builds unsigned local artifacts first so you can package and test immediately.
- macOS users will need to grant both Microphone and Screen Recording access in System Settings so the app can capture microphone audio and desktop/Zoom audio.

## Current Technical Notes

- The production web bundle is large because most of the recitation data currently ships in the client bundle.
- `npm run native:prepare` builds both the Swift helper and the local `whisper.cpp` runtime before copying the required binaries and libraries into `native/runtime/` for Electron packaging.
- The packaged desktop runtime bundles whichever Whisper model file is selected through `WHISPER_MODEL_NAME` or `WHISPER_MODEL_PATH`.
