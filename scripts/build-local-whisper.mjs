import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const version = '1.8.4';
const archiveName = `whisper.cpp-${version}.tar.gz`;
const sourceDirName = `whisper.cpp-${version}`;
const vendorDir = path.join(rootDir, 'native', 'vendor');
const tarballPath = path.join(vendorDir, archiveName);
const sourceDir = path.join(vendorDir, sourceDirName);
const buildDir = path.join(rootDir, 'native', 'build', 'whisper-local');
const installDir = path.join(rootDir, 'native', 'build', 'whisper-install');
const installWhisperCliPath = path.join(installDir, 'bin', 'whisper-cli');
const installWhisperLibPath = path.join(installDir, 'lib', 'libwhisper.1.dylib');
const installGgmlConfigPath = path.join(installDir, 'lib', 'cmake', 'ggml', 'ggml-config.cmake');
const sourceUrl = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${version}.tar.gz`;
const cmakeBin = process.env.CMAKE_BIN ?? 'cmake';
const shouldForceRebuild = process.env.FORCE_LOCAL_WHISPER_REBUILD === '1';

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function ensureCmake() {
  try {
    execFileSync(cmakeBin, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'CMake is required to build the local whisper.cpp runtime. Install it with `brew install cmake` or set CMAKE_BIN.'
    );
  }
}

function hasExpectedWhisperBuild() {
  if (!existsSync(installWhisperCliPath) || !existsSync(installWhisperLibPath) || !existsSync(installGgmlConfigPath)) {
    return false;
  }

  try {
    const ggmlConfig = readFileSync(installGgmlConfigPath, 'utf8');
    return /set\(GGML_METAL "ON"\)/u.test(ggmlConfig);
  } catch {
    return false;
  }
}

mkdirSync(vendorDir, { recursive: true });
ensureCmake();

if (!shouldForceRebuild && hasExpectedWhisperBuild()) {
  process.exit(0);
}

if (!existsSync(tarballPath)) {
  run('curl', ['-L', sourceUrl, '-o', tarballPath]);
}

rmSync(sourceDir, { recursive: true, force: true });
rmSync(buildDir, { recursive: true, force: true });
rmSync(installDir, { recursive: true, force: true });

run('tar', ['-xzf', tarballPath, '-C', vendorDir]);
run(cmakeBin, [
  '-S', sourceDir,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_INSTALL_PREFIX=${installDir}`,
  '-DBUILD_SHARED_LIBS=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DGGML_BACKEND_DL=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DGGML_BLAS=OFF',
  '-DGGML_CCACHE=OFF',
]);
run(cmakeBin, ['--build', buildDir, '--parallel', '4']);
run(cmakeBin, ['--install', buildDir]);
