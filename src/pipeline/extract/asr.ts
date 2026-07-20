// asr stage (Spec 2 §2.1). Full-audio transcription via a LOCAL Whisper
// model (transformers.js/ONNX runtime, downloaded once from Hugging Face
// Hub and run entirely on-device — no cloud AI call at inference time), in
// line with the project's online-AI-usage constraint: Claude is the only
// cloud AI dependency. Runs regardless of whether the caption gate skipped
// OCR — captions carry ingredients but essentially never carry method steps,
// so narration is still needed for `steps`. An empty/no-speech transcript
// (or no audio at all — silent video, photo-mode post) is a NORMAL result,
// not an error: return an empty segment list and let reconcile fall back to
// null + null_reason for anything only narration could have evidenced.
//
// A multilingual model is used deliberately (not an English-only "*.en"
// variant) — Spec 2's design explicitly requires ASR/OCR auto-detection
// with no English special-casing anywhere.
import fs from "node:fs/promises";
import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";

export interface AsrSegment {
  text: string;
  start: number;
  end: number;
}

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    // Without an explicit cache_dir, transformers.js caches the ~145MB
    // Whisper model under node_modules/@huggingface/transformers/.cache —
    // fine for local dev, but on a Railway worker that directory is reset
    // on every deploy (only DATA_DIR is a persistent volume), so the model
    // would silently re-download on every deploy. Mirror ocr.ts's cachePath
    // convention and point it at the same persistent data dir.
    //
    // dtype: "q8" — REAL production bug, not a preemptive optimization:
    // transformers.js's default dtype in Node.js (device "cpu"/onnxruntime-
    // node) is full fp32 (it only auto-picks a quantized dtype for WASM/
    // browser environments) — measured locally at ~930MB RSS just to load
    // this "base" model, which OOM-killed the Railway worker (1024MB limit)
    // on every real job, including caption-sufficient ones (ASR runs
    // unconditionally, not just on the OCR/vision-escalation path). The q8
    // quantized variant measured ~365MB RSS to load — same model family,
    // Xenova's standard published quantized ONNX export, not a smaller/
    // different model. Some transcription-accuracy loss vs fp32 is a known,
    // accepted tradeoff of int8 quantization — acceptable here since ASR
    // output feeds Claude's reconciliation as one evidence source among
    // several (caption, OCR), not the sole source of truth.
    transcriberPromise = pipeline("automatic-speech-recognition", config.extraction.whisperModel, {
      cache_dir: config.dataDir,
      dtype: "q8",
    });
  }
  return transcriberPromise;
}

/** Parses a 16-bit PCM mono WAV file (exactly what media_split.ts's
 * `ffmpeg -ar 16000 -ac 1 audio.wav` produces) into a Float32Array of
 * samples normalized to [-1, 1], the input shape transformers.js's ASR
 * pipeline expects. Doesn't use transformers.js's own `read_audio()` helper
 * because that requires a browser `AudioContext`, unavailable in Node. */
function parseWavPcm16Mono(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("asr: not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkBodyStart = offset + 8;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkBodyStart),
        channels: buffer.readUInt16LE(chunkBodyStart + 2),
        sampleRate: buffer.readUInt32LE(chunkBodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkBodyStart + 14),
      };
    } else if (chunkId === "data") {
      dataStart = chunkBodyStart;
      dataLength = chunkSize;
    }

    // Chunks are padded to even byte offsets.
    offset = chunkBodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error("asr: WAV file has no fmt chunk");
  if (dataStart < 0) throw new Error("asr: WAV file has no data chunk");
  if (fmt.audioFormat !== 1) {
    throw new Error(`asr: expected PCM (format 1), got format ${fmt.audioFormat}`);
  }
  if (fmt.channels !== 1) {
    throw new Error(`asr: expected mono audio, got ${fmt.channels} channels`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`asr: expected 16-bit samples, got ${fmt.bitsPerSample}-bit`);
  }

  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768;
  }

  return { sampleRate: fmt.sampleRate, samples };
}

/** @param audioPath path to a 16kHz mono WAV, or null when media_split found
 * no audio to extract (photo-mode / silent video) — returns [] immediately
 * without loading the model. */
export async function transcribeAudio(audioPath: string | null): Promise<AsrSegment[]> {
  if (!audioPath) {
    return [];
  }

  const buffer = await fs.readFile(audioPath);
  const { samples } = parseWavPcm16Mono(buffer);

  const transcriber = await getTranscriber();
  const output = await transcriber(samples, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  // The pipeline's return type is a union keyed on whether the input was a
  // batch; a single Float32Array input always yields a single (non-array)
  // AutomaticSpeechRecognitionOutput, but narrow defensively anyway.
  const result = (Array.isArray(output) ? output[0] : output) as AutomaticSpeechRecognitionOutput;

  if (!result?.chunks || result.chunks.length === 0) {
    if (result?.text && result.text.trim()) {
      // Some responses may carry text without a chunks array; keep the text
      // as one unsegmented block rather than dropping it.
      return [{ text: result.text.trim(), start: 0, end: 0 }];
    }
    logger.info("asr: empty/no-speech transcript", { audioPath });
    return [];
  }

  return result.chunks
    .filter((c) => c.text.trim())
    .map((c) => ({
      text: c.text.trim(),
      start: c.timestamp[0] ?? 0,
      // Whisper occasionally omits the end timestamp of the final chunk;
      // fall back to start rather than propagating null/undefined.
      end: c.timestamp[1] ?? c.timestamp[0] ?? 0,
    }));
}
