const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const nativeRuntimeRoot = path.join(appPath, 'Contents', 'Resources', 'native');
  const nativeCodePaths = [
    path.join(nativeRuntimeRoot, 'bin', 'TarteelMacAudioBackend'),
    path.join(nativeRuntimeRoot, 'bin', 'whisper-cli'),
    path.join(nativeRuntimeRoot, 'lib', 'libggml-base.0.dylib'),
    path.join(nativeRuntimeRoot, 'lib', 'libggml-cpu.0.dylib'),
    path.join(nativeRuntimeRoot, 'lib', 'libggml.0.dylib'),
    path.join(nativeRuntimeRoot, 'lib', 'libwhisper.1.dylib'),
  ];

  execFileSync('xattr', ['-cr', appPath]);
  try {
    for (const nativeCodePath of nativeCodePaths) {
      if (!fs.existsSync(nativeCodePath)) {
        continue;
      }

      execFileSync('codesign', ['--force', '--sign', '-', nativeCodePath], {
        stdio: 'inherit',
      });
    }

    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn('[after-pack] Ad-hoc signing skipped:', error.message);
  }
};
