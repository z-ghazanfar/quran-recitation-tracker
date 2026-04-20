#include "TarteelWhisperWrapper.h"

#include "whisper.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct tarteel_whisper_session {
    struct whisper_context * context;
    char * last_result;
    char last_error[1024];
} tarteel_whisper_session;

static void tarteel_clear_error(tarteel_whisper_session * session) {
    if (!session) {
        return;
    }

    session->last_error[0] = '\0';
}

static void tarteel_set_error(tarteel_whisper_session * session, const char * format, ...) {
    if (!session || !format) {
        return;
    }

    va_list args;
    va_start(args, format);
    vsnprintf(session->last_error, sizeof(session->last_error), format, args);
    va_end(args);
}

static char * tarteel_strdup(const char * text) {
    if (!text) {
        text = "";
    }

    const size_t length = strlen(text) + 1;
    char * copy = (char *) malloc(length);
    if (!copy) {
        return NULL;
    }

    memcpy(copy, text, length);
    return copy;
}

void * tarteel_whisper_session_create(const char * model_path, bool use_gpu, bool flash_attn, int gpu_device) {
    if (!model_path || model_path[0] == '\0') {
        return NULL;
    }

    tarteel_whisper_session * session = (tarteel_whisper_session *) calloc(1, sizeof(tarteel_whisper_session));
    if (!session) {
        return NULL;
    }

    struct whisper_context_params params = whisper_context_default_params();
    params.use_gpu = use_gpu;
    params.flash_attn = flash_attn;
    params.gpu_device = gpu_device;

    session->context = whisper_init_from_file_with_params(model_path, params);
    if (!session->context) {
        tarteel_set_error(session, "Failed to load Whisper model from %s", model_path);
        tarteel_whisper_session_destroy(session);
        return NULL;
    }

    return session;
}

void tarteel_whisper_session_destroy(void * opaque_session) {
    tarteel_whisper_session * session = (tarteel_whisper_session *) opaque_session;
    if (!session) {
        return;
    }

    if (session->context) {
        whisper_free(session->context);
    }

    free(session->last_result);
    free(session);
}

const char * tarteel_whisper_session_transcribe(
    void * opaque_session,
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
) {
    tarteel_whisper_session * session = (tarteel_whisper_session *) opaque_session;
    if (!session || !session->context) {
        return NULL;
    }

    tarteel_clear_error(session);
    free(session->last_result);
    session->last_result = NULL;

    if (out_metrics) {
        out_metrics->max_no_speech_prob = 1.0f;
        out_metrics->avg_token_prob = 0.0f;
        out_metrics->min_token_prob = 0.0f;
        out_metrics->token_count = 0;
        out_metrics->segment_count = 0;
    }

    if (!samples || n_samples <= 0) {
        session->last_result = tarteel_strdup("");
        return session->last_result;
    }

    const enum whisper_sampling_strategy strategy =
        beam_size > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY;
    struct whisper_full_params params = whisper_full_default_params(strategy);

    params.n_threads = threads > 0 ? threads : 1;
    params.translate = false;
    params.no_context = no_context;
    params.no_timestamps = true;
    params.single_segment = single_segment;
    params.print_special = false;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.token_timestamps = false;
    params.language = (language && language[0] != '\0') ? language : "ar";
    params.detect_language = false;
    params.suppress_blank = true;
    params.suppress_nst = suppress_non_speech_tokens;
    params.temperature = temperature;
    params.temperature_inc = no_fallback ? 0.0f : 0.2f;
    params.greedy.best_of = best_of > 0 ? best_of : params.greedy.best_of;
    params.beam_search.beam_size = beam_size > 0 ? beam_size : params.beam_search.beam_size;
    params.initial_prompt = (initial_prompt && initial_prompt[0] != '\0') ? initial_prompt : NULL;
    params.carry_initial_prompt = carry_initial_prompt;
    params.audio_ctx = audio_ctx > 0 ? audio_ctx : 0;
    params.max_tokens = max_tokens > 0 ? max_tokens : 0;

    if (whisper_full(session->context, params, samples, n_samples) != 0) {
        tarteel_set_error(session, "whisper_full failed");
        return NULL;
    }

    const int segment_count = whisper_full_n_segments(session->context);
    if (out_metrics) {
        out_metrics->segment_count = segment_count;
    }
    if (segment_count <= 0) {
        session->last_result = tarteel_strdup("");
        return session->last_result;
    }

    float total_token_prob = 0.0f;
    float min_token_prob = 1.0f;
    int token_count = 0;
    float max_no_speech_prob = 0.0f;

    size_t total_length = 1;
    for (int index = 0; index < segment_count; index += 1) {
        const char * segment_text = whisper_full_get_segment_text(session->context, index);
        const float segment_no_speech_prob =
            whisper_full_get_segment_no_speech_prob(session->context, index);
        if (segment_no_speech_prob > max_no_speech_prob) {
            max_no_speech_prob = segment_no_speech_prob;
        }

        const int segment_token_count = whisper_full_n_tokens(session->context, index);
        for (int token_index = 0; token_index < segment_token_count; token_index += 1) {
            const float token_prob = whisper_full_get_token_p(session->context, index, token_index);
            total_token_prob += token_prob;
            if (token_prob < min_token_prob) {
                min_token_prob = token_prob;
            }
            token_count += 1;
        }

        if (!segment_text) {
            continue;
        }

        total_length += strlen(segment_text);
        if (index + 1 < segment_count) {
            total_length += 1;
        }
    }

    if (out_metrics) {
        out_metrics->max_no_speech_prob = max_no_speech_prob;
        out_metrics->avg_token_prob = token_count > 0 ? total_token_prob / (float) token_count : 0.0f;
        out_metrics->min_token_prob = token_count > 0 ? min_token_prob : 0.0f;
        out_metrics->token_count = token_count;
    }

    session->last_result = (char *) calloc(total_length, sizeof(char));
    if (!session->last_result) {
        tarteel_set_error(session, "Failed to allocate transcript buffer");
        return NULL;
    }

    for (int index = 0; index < segment_count; index += 1) {
        const char * segment_text = whisper_full_get_segment_text(session->context, index);
        if (!segment_text) {
            continue;
        }

        strcat(session->last_result, segment_text);
        if (index + 1 < segment_count) {
            strcat(session->last_result, " ");
        }
    }

    return session->last_result;
}

const char * tarteel_whisper_session_last_error(const void * opaque_session) {
    const tarteel_whisper_session * session = (const tarteel_whisper_session *) opaque_session;
    if (!session || session->last_error[0] == '\0') {
        return "";
    }

    return session->last_error;
}

const char * tarteel_whisper_session_model_type(const void * opaque_session) {
    const tarteel_whisper_session * session = (const tarteel_whisper_session *) opaque_session;
    if (!session || !session->context) {
        return "";
    }

    return whisper_model_type_readable(session->context);
}
