#ifndef TARTEEL_WHISPER_WRAPPER_H
#define TARTEEL_WHISPER_WRAPPER_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct tarteel_whisper_transcription_metrics {
    float max_no_speech_prob;
    float avg_token_prob;
    float min_token_prob;
    int token_count;
    int segment_count;
} tarteel_whisper_transcription_metrics;

void * tarteel_whisper_session_create(const char * model_path, bool use_gpu, bool flash_attn, int gpu_device);
void tarteel_whisper_session_destroy(void * session);

const char * tarteel_whisper_session_transcribe(
    void * session,
    const float * samples,
    int n_samples,
    const char * language,
    int threads,
    int beam_size,
    int best_of,
    float temperature,
    bool no_fallback,
    const char * initial_prompt,
    bool carry_initial_prompt,
    bool suppress_non_speech_tokens,
    bool single_segment,
    bool no_context,
    int audio_ctx,
    int max_tokens,
    tarteel_whisper_transcription_metrics * out_metrics
);

const char * tarteel_whisper_session_last_error(const void * session);
const char * tarteel_whisper_session_model_type(const void * session);

#ifdef __cplusplus
}
#endif

#endif
