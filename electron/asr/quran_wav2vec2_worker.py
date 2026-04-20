#!/usr/bin/env python3

import json
import os
import sys
import time
import wave


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _read_wav_mono_16k(path):
    import numpy as np

    with wave.open(path, "rb") as wav:
      channels = wav.getnchannels()
      sample_rate = wav.getframerate()
      sample_width = wav.getsampwidth()
      frames = wav.getnframes()
      raw = wav.readframes(frames)

    if sample_rate != 16000:
        raise ValueError(f"Expected 16kHz wav, got {sample_rate}Hz")

    if sample_width != 2:
        raise ValueError(f"Expected 16-bit PCM wav, got {sample_width * 8}-bit")

    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    if channels == 1:
        return audio

    audio = audio.reshape((-1, channels))
    return audio.mean(axis=1)


def main():
    model_id = os.environ.get(
        "TARTEEL_WAV2VEC2_MODEL_ID",
        "rabah2026/wav2vec2-large-xlsr-53-arabic-quran-v_final",
    )

    try:
        import numpy as np
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except Exception as exc:  # noqa: BLE001
        _emit(
            {
                "type": "error",
                "message": "Missing Python deps. Install torch + transformers + numpy.",
                "detail": str(exc),
            }
        )
        return 1

    device = "cpu"
    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
    except Exception:
        device = "cpu"

    try:
        processor = Wav2Vec2Processor.from_pretrained(model_id)
        model = Wav2Vec2ForCTC.from_pretrained(model_id)
        model.eval()
        model.to(device)
    except Exception as exc:  # noqa: BLE001
        _emit({"type": "error", "message": f"Failed to load model {model_id}", "detail": str(exc)})
        return 1

    _emit({"type": "ready", "model_id": model_id, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            _emit({"type": "result", "ok": False, "id": None, "error": "invalid-json"})
            continue

        req_id = payload.get("id")
        wav_path = payload.get("path")
        if not req_id or not wav_path:
            _emit({"type": "result", "ok": False, "id": req_id, "error": "missing-id-or-path"})
            continue

        started = time.time()
        try:
            audio = _read_wav_mono_16k(wav_path)
            inputs = processor(audio, sampling_rate=16000, return_tensors="pt", padding=True)
            input_values = inputs.input_values.to(device)

            with torch.inference_mode():
                logits = model(input_values).logits
            max_logits, predicted_ids = torch.max(logits, dim=-1)
            logsumexp = torch.logsumexp(logits, dim=-1)
            max_probs = (max_logits - logsumexp).exp()
            avg_token_prob = float(max_probs.mean().detach().cpu().item())
            min_token_prob = float(max_probs.min().detach().cpu().item())

            no_speech_prob = None
            blank_id = getattr(processor, "tokenizer", None)
            blank_id = getattr(blank_id, "pad_token_id", None)
            if blank_id is not None:
                blank_logits = logits[..., int(blank_id)]
                blank_probs = (blank_logits - logsumexp).exp()
                no_speech_prob = float(blank_probs.mean().detach().cpu().item())

            transcription = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]

            _emit(
                {
                    "type": "result",
                    "ok": True,
                    "id": req_id,
                    "text": transcription,
                    "avg_token_prob": avg_token_prob,
                    "min_token_prob": min_token_prob,
                    "no_speech_prob": no_speech_prob,
                    "duration_ms": int((time.time() - started) * 1000),
                }
            )
        except Exception as exc:  # noqa: BLE001
            _emit(
                {
                    "type": "result",
                    "ok": False,
                    "id": req_id,
                    "error": str(exc),
                    "duration_ms": int((time.time() - started) * 1000),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
