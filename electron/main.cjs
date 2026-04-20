const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const {
  DEFAULT_WHISPER_DECODE_OPTIONS,
  DEFAULT_WHISPER_LANGUAGE,
  DEFAULT_WHISPER_PROMPT,
  buildModelFilename,
  deriveModelNameFromFilename,
} = require('./whisper-runtime-config.cjs');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  systemPreferences,
} = require('electron');

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;
const DIST_INDEX_PATH = path.join(__dirname, '..', 'dist', 'index.html');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
const DEV_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

let activeNativeSession = null;

function normalizeEngine(candidate) {
  const value = String(candidate ?? '').trim().toLowerCase();
  if (!value) return null;

  if (value === 'wav2vec2' || value === 'quran-wav2vec2') {
    return 'wav2vec2';
  }

  if (value === 'whisper' || value === 'whisper.cpp') {
    return 'whisper';
  }

  return null;
}

function resolveLocalAsrEngine(requestedEngine = null) {
  const requested = normalizeEngine(requestedEngine);
  if (requested) {
    return requested;
  }

  const configured = normalizeEngine(process.env.TARTEEL_LOCAL_ASR_ENGINE);
  if (configured) {
    return configured;
  }

  return 'whisper';
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleNativeHelpers(runtime, excludePid = null) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  });

  if (result.status !== 0 || !result.stdout) {
    return;
  }

  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];

    if (!Number.isFinite(pid) || pid === excludePid) {
      continue;
    }

    if (!command.includes(runtime.helperPath) || !/\scapture(?:-wav)?\s/u.test(command)) {
      continue;
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore races where the process exits while we are cleaning up.
    }
  }
}

function isAllowedOrigin(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol === 'file:') {
      return true;
    }

    return DEV_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

function isAllowedPermission(permission) {
  return permission === 'media' || permission === 'display-capture';
}

function getRequestOrigin(webContents, details = {}) {
  return details.requestingUrl
    || details.securityOrigin
    || details.embeddingOrigin
    || webContents?.getURL()
    || '';
}

function configureSessionPermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!isAllowedPermission(permission)) {
      return false;
    }

    const origin = requestingOrigin || getRequestOrigin(webContents, details);
    return isAllowedOrigin(origin);
  });

  defaultSession.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    if (!isAllowedPermission(permission)) {
      callback(false);
      return;
    }

    const origin = getRequestOrigin(webContents, details);
    if (!isAllowedOrigin(origin)) {
      callback(false);
      return;
    }

    if (permission === 'media' && process.platform === 'darwin') {
      const microphoneStatus = systemPreferences.getMediaAccessStatus('microphone');

      if (microphoneStatus === 'granted') {
        callback(true);
        return;
      }

      if (microphoneStatus === 'denied' || microphoneStatus === 'restricted') {
        callback(false);
        return;
      }

      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        callback(granted);
      } catch {
        callback(false);
      }

      return;
    }

    callback(true);
  });
}

function resolveBundledModel(runtimeRoot) {
  const modelDir = path.join(runtimeRoot, 'models');
  const configuredModelPath = path.join(modelDir, buildModelFilename());

  if (fs.existsSync(configuredModelPath)) {
    return {
      modelPath: configuredModelPath,
      modelName: deriveModelNameFromFilename(configuredModelPath),
    };
  }

  try {
    const availableModels = fs.readdirSync(modelDir)
      .filter((entry) => entry.endsWith('.bin'))
      .sort((left, right) => left.localeCompare(right));

    if (availableModels.length > 0) {
      const discoveredPath = path.join(modelDir, availableModels[0]);
      return {
        modelPath: discoveredPath,
        modelName: deriveModelNameFromFilename(discoveredPath),
      };
    }
  } catch {
    // Ignore lookup failures and report the configured model path below.
  }

  return {
    modelPath: configuredModelPath,
    modelName: deriveModelNameFromFilename(configuredModelPath),
  };
}

function resolveAsrRuntime() {
  const asrRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'asr')
    : path.join(app.getAppPath(), 'electron', 'asr');

  return {
    asrRoot,
    wav2vec2WorkerPath: path.join(asrRoot, 'quran_wav2vec2_worker.py'),
  };
}

function resolveNativeRuntime() {
  const runtimeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native', 'runtime');

  const whisperCliPath = path.join(runtimeRoot, 'bin', 'whisper-cli');
  const helperPath = path.join(runtimeRoot, 'bin', 'TarteelMacAudioBackend');
  const { modelPath, modelName } = resolveBundledModel(runtimeRoot);

  return {
    runtimeRoot,
    helperPath,
    whisperCliPath,
    modelPath,
    modelName,
  };
}

function resolveWav2Vec2ModelId(options = {}) {
  const explicit = String(options?.wav2vec2ModelId ?? '').trim();
  if (explicit) return explicit;

  const configured = String(process.env.TARTEEL_WAV2VEC2_MODEL_ID ?? '').trim();
  if (configured) return configured;

  return 'rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final';
}

function resolveWav2Vec2Python(options = {}) {
  const candidates = [];
  const explicit = String(options?.pythonExe ?? options?.pythonPath ?? '').trim();
  const envConfigured = String(process.env.TARTEEL_WAV2VEC2_PYTHON ?? '').trim();
  const home = os.homedir();

  if (explicit) candidates.push(explicit);
  if (envConfigured) candidates.push(envConfigured);
  // Finder-launched apps often don't inherit your shell PATH. Include common
  // Anaconda/Miniconda locations explicitly.
  candidates.push('/opt/homebrew/anaconda3/bin/python3');
  candidates.push('/opt/anaconda3/bin/python3');
  candidates.push(path.join(home, 'anaconda3', 'bin', 'python3'));
  candidates.push(path.join(home, 'miniconda3', 'bin', 'python3'));
  candidates.push(path.join(home, 'mambaforge', 'bin', 'python3'));
  candidates.push('/opt/homebrew/bin/python3');
  candidates.push('/usr/local/bin/python3');
  candidates.push('/usr/bin/python3');
  candidates.push('python3');

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  let hasPython = false;

  for (const exe of uniqueCandidates) {
    if (exe.includes('/') && !fs.existsSync(exe)) {
      continue;
    }

    const pythonCheck = spawnSync(exe, ['-c', 'print("ok")'], { encoding: 'utf8' });
    if (pythonCheck.status !== 0) {
      continue;
    }

    hasPython = true;
    const depsCheck = spawnSync(
      exe,
      ['-c', 'import torch, transformers, numpy; print("ok")'],
      { encoding: 'utf8' },
    );
    if (depsCheck.status === 0) {
      return { pythonExe: exe, hasPython: true, hasDeps: true };
    }
  }

  return {
    pythonExe: explicit || envConfigured || 'python3',
    hasPython,
    hasDeps: false,
  };
}

function getNativeBackendInfo(options = {}) {
  const runtime = resolveNativeRuntime();
  const asrRuntime = resolveAsrRuntime();
  const engine = resolveLocalAsrEngine(options?.engine);
  const missing = [];
  let wav2vec2Python = null;

  if (process.platform !== 'darwin') {
    missing.push('macOS desktop backend is only available on macOS.');
  }

  if (!fs.existsSync(runtime.helperPath)) {
    missing.push(`Native helper not found at ${runtime.helperPath}`);
  }

  if (engine === 'whisper') {
    if (!fs.existsSync(runtime.whisperCliPath)) {
      missing.push(`Bundled whisper-cli not found at ${runtime.whisperCliPath}`);
    }

    if (!fs.existsSync(runtime.modelPath)) {
      missing.push(`Bundled Whisper model not found at ${runtime.modelPath}`);
    }
  } else if (engine === 'wav2vec2') {
    if (!fs.existsSync(asrRuntime.wav2vec2WorkerPath)) {
      missing.push(`Wav2Vec2 worker not found at ${asrRuntime.wav2vec2WorkerPath}`);
    }

    wav2vec2Python = resolveWav2Vec2Python(options);
    if (!wav2vec2Python.hasPython) {
      missing.push('python3 was not available for the wav2vec2 backend.');
    } else if (!wav2vec2Python.hasDeps) {
      missing.push(
        `Python deps missing for wav2vec2 in ${wav2vec2Python.pythonExe}. Install torch + transformers + numpy for that Python.`,
      );
    }
  }

  return {
    available: process.platform === 'darwin',
    ready: missing.length === 0,
    missing,
    engine,
    wav2vec2ModelId: engine === 'wav2vec2' ? resolveWav2Vec2ModelId(options) : null,
    wav2vec2PythonExe: engine === 'wav2vec2' ? wav2vec2Python?.pythonExe ?? null : null,
    modelName: runtime.modelName,
    modelPath: runtime.modelPath,
  };
}

function sendNativeEvent(webContents, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send('tarteel:native-event', payload);
}

function stopNativeSession({ force = false } = {}) {
  if (!activeNativeSession) {
    return;
  }

  const sessionToStop = activeNativeSession;
  const {
    child,
    transcriber,
    stdoutInterface,
    stderrInterface,
    transcriberStdoutInterface,
    transcriberStderrInterface,
    forceKillTimer,
  } = sessionToStop;

  stdoutInterface?.close();
  stderrInterface?.close();
  transcriberStdoutInterface?.close();
  transcriberStderrInterface?.close();
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }

  if (isProcessAlive(child.pid)) {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Ignore kill failures during shutdown.
    }

    if (!force) {
      sessionToStop.forceKillTimer = setTimeout(() => {
        if (!isProcessAlive(child.pid)) {
          return;
        }

        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Ignore races where the process exits while escalating.
        }
      }, 1500);
    }
  }

  if (transcriber && isProcessAlive(transcriber.pid)) {
    try {
      transcriber.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Ignore kill failures during shutdown.
    }
  }

  activeNativeSession = null;
}

function startNativeSession(webContents, options = {}) {
  stopNativeSession();

  const runtime = resolveNativeRuntime();
  cleanupStaleNativeHelpers(runtime);

  const info = getNativeBackendInfo(options);
  if (!info.ready) {
    return {
      ok: false,
      error: info.missing.join('\n'),
    };
  }

  if (info.engine === 'wav2vec2') {
    return startNativeWav2Vec2Session(webContents, runtime, options);
  }

  const decodeOptions = DEFAULT_WHISPER_DECODE_OPTIONS;
  const spawnArgs = [
    'capture',
    '--model', runtime.modelPath,
    '--language', DEFAULT_WHISPER_LANGUAGE,
    '--chunk-seconds', String(decodeOptions.chunkSeconds),
    '--step-seconds', String(decodeOptions.stepSeconds),
    '--beam-size', String(decodeOptions.beamSize),
    '--best-of', String(decodeOptions.bestOf),
    '--temperature', String(decodeOptions.temperature),
    '--max-tokens', String(decodeOptions.maxTokens),
    '--audio-ctx', String(decodeOptions.audioContext),
    '--gpu-device', String(decodeOptions.gpuDevice),
  ];

  if (decodeOptions.noFallback) {
    spawnArgs.push('--no-fallback');
  }

  if (decodeOptions.carryInitialPrompt) {
    spawnArgs.push('--carry-initial-prompt');
  }

  if (decodeOptions.suppressNonSpeechTokens) {
    spawnArgs.push('--suppress-nst');
  }

  if (decodeOptions.singleSegment) {
    spawnArgs.push('--single-segment');
  }

  if (decodeOptions.noContext) {
    spawnArgs.push('--no-context');
  }

  if (!decodeOptions.useGpu) {
    spawnArgs.push('--no-gpu');
  }

  if (!decodeOptions.flashAttention) {
    spawnArgs.push('--no-flash-attn');
  }

  if (DEFAULT_WHISPER_PROMPT) {
    spawnArgs.push('--prompt', DEFAULT_WHISPER_PROMPT);
  }

  const child = spawn(
    runtime.helperPath,
    spawnArgs,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  const stdoutInterface = readline.createInterface({ input: child.stdout });
  const stderrInterface = readline.createInterface({ input: child.stderr });

  stdoutInterface.on('line', (line) => {
    try {
      const payload = JSON.parse(line);
      sendNativeEvent(webContents, payload);
    } catch {
      sendNativeEvent(webContents, {
        type: 'error',
        message: `Native backend emitted invalid JSON: ${line}`,
      });
    }
  });

  stderrInterface.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    sendNativeEvent(webContents, {
      type: 'log',
      message: line,
    });
  });

  const sessionRecord = {
    child,
    stdoutInterface,
    stderrInterface,
    forceKillTimer: null,
    webContents,
  };

  child.on('exit', (code, signal) => {
    if (sessionRecord.forceKillTimer) {
      clearTimeout(sessionRecord.forceKillTimer);
      sessionRecord.forceKillTimer = null;
    }

    sendNativeEvent(webContents, {
      type: 'stopped',
      code,
      signal,
    });

    if (activeNativeSession?.child === child) {
      activeNativeSession = null;
    }
  });

  child.on('error', (error) => {
    sendNativeEvent(webContents, {
      type: 'error',
      message: error.message,
    });
  });

  activeNativeSession = sessionRecord;

  return { ok: true };
}

function startNativeWav2Vec2Session(webContents, runtime, options = {}) {
  const asrRuntime = resolveAsrRuntime();
  const modelId = resolveWav2Vec2ModelId(options);
  const python = resolveWav2Vec2Python(options);
  const configuredChunkSeconds = Number.parseFloat(process.env.TARTEEL_WAV2VEC2_CHUNK_SECONDS ?? '4');
  const configuredStepSeconds = Number.parseFloat(process.env.TARTEEL_WAV2VEC2_STEP_SECONDS ?? '2');
  const chunkSeconds = Number.isFinite(configuredChunkSeconds) ? configuredChunkSeconds : 4;
  const stepSeconds = Number.isFinite(configuredStepSeconds) ? configuredStepSeconds : 2;
  const maxQueueSize = Math.max(
    1,
    Number.parseInt(process.env.TARTEEL_WAV2VEC2_QUEUE_SIZE ?? '6', 10) || 6,
  );
  const configuredMinActiveRatio = Number.parseFloat(process.env.TARTEEL_WAV2VEC2_MIN_ACTIVE_RATIO ?? '0.008');
  const configuredMinRms = Number.parseFloat(process.env.TARTEEL_WAV2VEC2_MIN_RMS ?? '0.006');
  const minActiveRatio = Number.isFinite(configuredMinActiveRatio) ? configuredMinActiveRatio : 0.008;
  const minRms = Number.isFinite(configuredMinRms) ? configuredMinRms : 0.006;

  const helperArgs = [
    'capture-wav',
    '--chunk-seconds', String(chunkSeconds),
    '--step-seconds', String(stepSeconds),
    '--model', runtime.modelPath,
  ];

  const transcriber = spawn(
    python.pythonExe || 'python3',
    [asrRuntime.wav2vec2WorkerPath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TARTEEL_WAV2VEC2_MODEL_ID: modelId,
      },
    },
  );

  const transcriberStdoutInterface = readline.createInterface({ input: transcriber.stdout });
  const transcriberStderrInterface = readline.createInterface({ input: transcriber.stderr });

  let transcriberReady = false;
  let nextRequestId = 0;
  let inFlight = null;
  const windowQueue = [];
  let lastTranscript = '';

  function safeUnlink(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, () => {});
  }

  function dropQueuedWindows(maxLength) {
    while (windowQueue.length > maxLength) {
      const dropped = windowQueue.shift();
      safeUnlink(dropped?.path);
    }
  }

  function dispatchWindow(windowEvent) {
    nextRequestId += 1;
    inFlight = { id: nextRequestId, windowEvent };
    try {
      transcriber.stdin.write(`${JSON.stringify({ id: nextRequestId, path: windowEvent.path })}\n`);
    } catch {
      // Ignore write failures; exit handler will report.
    }
  }

  function dispatchNextWindow() {
    if (!transcriberReady) return;
    if (inFlight) return;
    if (windowQueue.length === 0) return;
    dispatchWindow(windowQueue.shift());
  }

  transcriberStdoutInterface.on('line', (line) => {
    try {
      const message = JSON.parse(line);

      if (message.type === 'ready') {
        transcriberReady = true;
        sendNativeEvent(webContents, {
          type: 'log',
          message: `Quran wav2vec2 ready (${message.device ?? 'cpu'})`,
        });
        return;
      }

      if (message.type === 'error') {
        sendNativeEvent(webContents, {
          type: 'error',
          message: message.message ?? 'Failed to start Quran wav2vec2 backend.',
        });
        return;
      }

      if (message.type === 'result') {
        if (!inFlight || message.id !== inFlight.id) {
          return;
        }

        const { windowEvent } = inFlight;
        inFlight = null;

        if (message.ok && typeof message.text === 'string') {
          const cleanedText = String(message.text).trim();
          if (cleanedText && cleanedText !== lastTranscript) {
            lastTranscript = cleanedText;
            sendNativeEvent(webContents, {
              type: 'transcript',
              text: cleanedText,
              windowStartMs: windowEvent.windowStartMs,
              decodeMs: message.duration_ms,
              avgTokenProb: message.avg_token_prob,
              minTokenProb: message.min_token_prob,
              noSpeechProb: message.no_speech_prob,
              engine: 'wav2vec2',
              audioAvgLevel: windowEvent.audioAvgLevel,
              audioRms: windowEvent.audioRms,
              audioPeak: windowEvent.audioPeak,
              audioActiveRatio: windowEvent.audioActiveRatio,
            });
          }
        } else if (message.error) {
          sendNativeEvent(webContents, { type: 'log', message: `wav2vec2 error: ${message.error}` });
        }

        safeUnlink(windowEvent.path);
        dispatchNextWindow();

        return;
      }
    } catch {
      sendNativeEvent(webContents, {
        type: 'log',
        message: `wav2vec2 emitted invalid JSON: ${line}`,
      });
    }
  });

  transcriberStderrInterface.on('line', (line) => {
    if (!line.trim()) return;
    sendNativeEvent(webContents, { type: 'log', message: `[wav2vec2] ${line}` });
  });

  const child = spawn(
    runtime.helperPath,
    helperArgs,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  const stdoutInterface = readline.createInterface({ input: child.stdout });
  const stderrInterface = readline.createInterface({ input: child.stderr });

  stdoutInterface.on('line', (line) => {
    try {
      const payload = JSON.parse(line);

      if (payload.type === 'ready') {
        sendNativeEvent(webContents, payload);
        if (!transcriberReady) {
          sendNativeEvent(webContents, { type: 'log', message: 'Loading Quran wav2vec2 model…' });
        }
        return;
      }

      if (payload.type === 'audio-window') {
        if (!transcriberReady) {
          safeUnlink(payload.path);
          return;
        }

        const activeRatio = Number(payload?.audioActiveRatio ?? NaN);
        const rms = Number(payload?.audioRms ?? NaN);
        if (
          Number.isFinite(activeRatio) &&
          Number.isFinite(rms) &&
          activeRatio < minActiveRatio &&
          rms < minRms
        ) {
          safeUnlink(payload.path);
          return;
        }

        windowQueue.push(payload);
        dropQueuedWindows(maxQueueSize);
        dispatchNextWindow();
        return;
      }

      sendNativeEvent(webContents, payload);
    } catch {
      sendNativeEvent(webContents, {
        type: 'error',
        message: `Native backend emitted invalid JSON: ${line}`,
      });
    }
  });

  stderrInterface.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    sendNativeEvent(webContents, { type: 'log', message: line });
  });

  const sessionRecord = {
    child,
    transcriber,
    stdoutInterface,
    stderrInterface,
    transcriberStdoutInterface,
    transcriberStderrInterface,
    forceKillTimer: null,
    webContents,
  };

  child.on('exit', (code, signal) => {
    sendNativeEvent(webContents, { type: 'stopped', code, signal });
    if (activeNativeSession?.child === child) {
      activeNativeSession = null;
    }
  });

  child.on('error', (error) => {
    sendNativeEvent(webContents, { type: 'error', message: error.message });
  });

  transcriber.on('exit', (code) => {
    for (const queued of windowQueue.splice(0)) {
      safeUnlink(queued?.path);
    }
    if (inFlight?.windowEvent?.path) {
      safeUnlink(inFlight.windowEvent.path);
    }
    inFlight = null;
    if (code && code !== 0) {
      sendNativeEvent(webContents, { type: 'log', message: `wav2vec2 process exited (${code})` });
    }
  });

  transcriber.on('error', (error) => {
    sendNativeEvent(webContents, { type: 'error', message: `wav2vec2 failed: ${error.message}` });
  });

  activeNativeSession = sessionRecord;
  return { ok: true };
}

function registerNativeIpc() {
  ipcMain.handle('tarteel:native-info', (_event, options) => getNativeBackendInfo(options));
  ipcMain.handle('tarteel:native-start', (event, options) => startNativeSession(event.sender, options));
  ipcMain.handle('tarteel:native-stop', () => {
    stopNativeSession();
    return { ok: true };
  });
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#07120d',
    title: 'Quran Recitation Tracker',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(DIST_INDEX_PATH);
  }

  return mainWindow;
}

app.whenReady().then(() => {
  cleanupStaleNativeHelpers(resolveNativeRuntime());
  configureSessionPermissions();
  registerNativeIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  stopNativeSession({ force: true });
  cleanupStaleNativeHelpers(resolveNativeRuntime());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
