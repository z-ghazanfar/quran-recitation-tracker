const path = require('node:path');

const DEFAULT_WHISPER_MODEL_NAME = process.env.WHISPER_MODEL_NAME || 'large-v3-turbo-q5_0';
const DEFAULT_WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'ar';
const DEFAULT_WHISPER_PROMPT = process.env.WHISPER_INITIAL_PROMPT || [
  'هذه تلاوة قرآنية باللغة العربية الفصحى.',
  'تعرف على ألفاظ القرآن الكريم بدقة مثل الرحمن الرحيم مالك يوم الدين وإياك نعبد وإياك نستعين والصراط المستقيم.',
].join(' ');

const DEFAULT_WHISPER_DECODE_OPTIONS = {
  beamSize: Number.parseInt(process.env.WHISPER_BEAM_SIZE ?? '2', 10),
  bestOf: Number.parseInt(process.env.WHISPER_BEST_OF ?? '2', 10),
  temperature: Number.parseFloat(process.env.WHISPER_TEMPERATURE ?? '0'),
  noFallback: process.env.WHISPER_NO_FALLBACK !== '0',
  carryInitialPrompt: process.env.WHISPER_CARRY_INITIAL_PROMPT === '1',
  suppressNonSpeechTokens: process.env.WHISPER_SUPPRESS_NON_SPEECH !== '0',
  chunkSeconds: Number.parseFloat(process.env.WHISPER_CHUNK_SECONDS ?? '2'),
  stepSeconds: Number.parseFloat(process.env.WHISPER_STEP_SECONDS ?? '0.75'),
  maxTokens: Number.parseInt(process.env.WHISPER_MAX_TOKENS ?? '48', 10),
  audioContext: Number.parseInt(process.env.WHISPER_AUDIO_CONTEXT ?? '0', 10),
  singleSegment: process.env.WHISPER_SINGLE_SEGMENT !== '0',
  noContext: process.env.WHISPER_NO_CONTEXT !== '0',
  useGpu: process.env.WHISPER_USE_GPU !== '0',
  flashAttention: process.env.WHISPER_FLASH_ATTENTION !== '0',
  gpuDevice: Number.parseInt(process.env.WHISPER_GPU_DEVICE ?? '0', 10),
};

function buildModelFilename(modelName = DEFAULT_WHISPER_MODEL_NAME) {
  if (!modelName) {
    return '';
  }

  return modelName.endsWith('.bin') ? modelName : `ggml-${modelName}.bin`;
}

function deriveModelNameFromFilename(filePath) {
  const filename = path.basename(filePath ?? '');
  if (!filename.endsWith('.bin')) {
    return filename;
  }

  return filename.replace(/^ggml-/u, '').replace(/\.bin$/u, '');
}

function getDefaultModelPath(rootDir) {
  return path.join(rootDir, 'native', 'models', buildModelFilename());
}

module.exports = {
  DEFAULT_WHISPER_DECODE_OPTIONS,
  DEFAULT_WHISPER_LANGUAGE,
  DEFAULT_WHISPER_MODEL_NAME,
  DEFAULT_WHISPER_PROMPT,
  buildModelFilename,
  deriveModelNameFromFilename,
  getDefaultModelPath,
};
