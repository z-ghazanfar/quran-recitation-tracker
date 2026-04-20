import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const {
  DEFAULT_WHISPER_MODEL_NAME,
  buildModelFilename,
} = require('../electron/whisper-runtime-config.cjs');

const rootDir = process.cwd();
const modelDir = path.join(rootDir, 'native', 'models');
const modelFilename = buildModelFilename();
const modelPath = path.join(modelDir, modelFilename);
const modelUrl = process.env.WHISPER_MODEL_URL
  || `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFilename}`;

mkdirSync(modelDir, { recursive: true });

if (existsSync(modelPath)) {
  process.stdout.write(`Whisper model already present at ${modelPath}\n`);
  process.exit(0);
}

process.stdout.write(
  `Downloading Whisper model ${DEFAULT_WHISPER_MODEL_NAME} to ${modelPath}\n`,
);

execFileSync('curl', ['-L', modelUrl, '-o', modelPath], { stdio: 'inherit' });
