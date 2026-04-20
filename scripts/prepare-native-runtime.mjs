import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { getDefaultModelPath } = require('../electron/whisper-runtime-config.cjs');

const rootDir = process.cwd();
const helperPackageDir = path.join(rootDir, 'native', 'mac-audio-backend');
const helperBinaryPath = path.join(
  helperPackageDir,
  '.build',
  'release',
  'TarteelMacAudioBackend',
);

const whisperInstallRoot = process.env.WHISPER_INSTALL_ROOT
  || path.join(rootDir, 'native', 'build', 'whisper-install');
const whisperCliPath = path.join(whisperInstallRoot, 'bin', 'whisper-cli');

const modelSourcePath = process.env.WHISPER_MODEL_PATH
  || getDefaultModelPath(rootDir);
const modelFileName = path.basename(modelSourcePath);

const runtimeRoot = path.join(rootDir, 'native', 'runtime');
const runtimeBinDir = path.join(runtimeRoot, 'bin');
const runtimeLibDir = path.join(runtimeRoot, 'lib');
const runtimeModelDir = path.join(runtimeRoot, 'models');
const librarySpecs = [
  { key: 'whisper', preferredName: 'libwhisper.1.dylib', patterns: ['libwhisper.1.dylib', /^libwhisper\..+\.dylib$/u] },
  { key: 'ggml', preferredName: 'libggml.0.dylib', patterns: ['libggml.0.dylib', /^libggml\..+\.dylib$/u] },
  { key: 'ggmlCpu', preferredName: 'libggml-cpu.0.dylib', patterns: ['libggml-cpu.0.dylib', /^libggml-cpu\..+\.dylib$/u] },
  { key: 'ggmlBase', preferredName: 'libggml-base.0.dylib', patterns: ['libggml-base.0.dylib', /^libggml-base\..+\.dylib$/u] },
  { key: 'ggmlMetal', preferredName: 'libggml-metal.0.dylib', patterns: ['libggml-metal.0.dylib', 'libggml-metal.dylib', /^libggml-metal\..+\.dylib$/u], optional: true },
];

function ensureExists(filePath, message) {
  if (!existsSync(filePath)) {
    throw new Error(message);
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function makeWritable(filePath, mode = 0o755) {
  chmodSync(filePath, mode);
}

function signAdHoc(filePath) {
  run('codesign', ['--force', '--sign', '-', filePath]);
}

function resolveInstalledLibrary(preferredName, patterns) {
  const installLibDir = path.join(whisperInstallRoot, 'lib');
  const entries = readdirSync(installLibDir);

  if (entries.includes(preferredName)) {
    return path.join(installLibDir, preferredName);
  }

  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (entries.includes(pattern)) {
        return path.join(installLibDir, pattern);
      }
      continue;
    }

    const match = entries.find((entry) => pattern.test(entry));
    if (match) {
      return path.join(installLibDir, match);
    }
  }

  return null;
}

ensureExists(
  helperBinaryPath,
  'Native helper was not built. Run `npm run native:build` first.',
);

ensureExists(
  whisperCliPath,
  'Local whisper.cpp runtime not found. Run `node scripts/build-local-whisper.mjs` or `npm run native:prepare`.',
);

ensureExists(
  modelSourcePath,
  'Whisper model not found. Run `npm run native:model:download` or set WHISPER_MODEL_PATH.',
);

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeBinDir, { recursive: true });
mkdirSync(runtimeLibDir, { recursive: true });
mkdirSync(runtimeModelDir, { recursive: true });

copyFileSync(helperBinaryPath, path.join(runtimeBinDir, 'TarteelMacAudioBackend'));
copyFileSync(whisperCliPath, path.join(runtimeBinDir, 'whisper-cli'));
copyFileSync(modelSourcePath, path.join(runtimeModelDir, modelFileName));

const bundledLibraryPaths = {};
for (const spec of librarySpecs) {
  const sourcePath = resolveInstalledLibrary(spec.preferredName, spec.patterns);
  if (!sourcePath) {
    if (spec.optional) {
      continue;
    }

    throw new Error(`Missing required Whisper runtime library ${spec.preferredName}`);
  }

  const bundledPath = path.join(runtimeLibDir, spec.preferredName);
  copyFileSync(sourcePath, bundledPath);
  bundledLibraryPaths[spec.key] = bundledPath;
}

const bundledWhisperCli = path.join(runtimeBinDir, 'whisper-cli');
const bundledHelperBinary = path.join(runtimeBinDir, 'TarteelMacAudioBackend');

makeWritable(bundledHelperBinary, 0o755);
makeWritable(bundledWhisperCli, 0o755);
for (const bundledPath of Object.values(bundledLibraryPaths)) {
  makeWritable(bundledPath, 0o644);
  run('install_name_tool', ['-id', `@rpath/${path.basename(bundledPath)}`, bundledPath]);
}

const bundledBinaries = [bundledWhisperCli, bundledHelperBinary];
for (const binaryPath of bundledBinaries) {
  for (const bundledPath of Object.values(bundledLibraryPaths)) {
    run('install_name_tool', [
      '-change',
      `@rpath/${path.basename(bundledPath)}`,
      `@executable_path/../lib/${path.basename(bundledPath)}`,
      binaryPath,
    ]);
  }
}

for (const libraryPath of Object.values(bundledLibraryPaths)) {
  for (const dependencyPath of Object.values(bundledLibraryPaths)) {
    if (libraryPath === dependencyPath) {
      continue;
    }

    run('install_name_tool', [
      '-change',
      `@rpath/${path.basename(dependencyPath)}`,
      `@loader_path/${path.basename(dependencyPath)}`,
      libraryPath,
    ]);
  }
}

for (const bundledPath of Object.values(bundledLibraryPaths)) {
  signAdHoc(bundledPath);
}
signAdHoc(bundledWhisperCli);
signAdHoc(bundledHelperBinary);
