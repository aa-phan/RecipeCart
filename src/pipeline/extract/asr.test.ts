import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { whisperModel: "fake/whisper-model" }, dataDir: "/fake/data" },
}));

/** Builds a minimal valid 16-bit PCM mono WAV file buffer from raw int16
 * samples, so tests exercise the real parseWavPcm16Mono() parsing logic
 * rather than mocking it away. */
function buildWavBuffer(samples: number[], sampleRate = 16000): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // audioFormat = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((s, i) => buffer.writeInt16LE(s, 44 + i * 2));

  return buffer;
}

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: { readFile: readFileMock },
}));

const transcribeMock = vi.fn();
const pipelineMock = vi.fn().mockResolvedValue(transcribeMock);
vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

const { transcribeAudio } = await import("./asr.js");

beforeEach(() => {
  readFileMock.mockReset();
  transcribeMock.mockReset();
  pipelineMock.mockClear();
  readFileMock.mockResolvedValue(buildWavBuffer([0, 100, -100, 200]));
});

describe("transcribeAudio", () => {
  it("returns [] without loading the model when audioPath is null", async () => {
    const result = await transcribeAudio(null);
    expect(result).toEqual([]);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("loads the configured multilingual whisper model", async () => {
    transcribeMock.mockResolvedValue({ text: "", chunks: [] });
    await transcribeAudio("/tmp/audio.wav");
    expect(pipelineMock).toHaveBeenCalledWith("automatic-speech-recognition", "fake/whisper-model", {
      cache_dir: "/fake/data",
    });
  });

  it("maps timestamped chunks to AsrSegment[], trimming text", async () => {
    transcribeMock.mockResolvedValue({
      text: "two cups flour and a pinch of salt",
      chunks: [
        { text: " two cups flour ", timestamp: [0, 2.1] },
        { text: " and a pinch of salt ", timestamp: [2.1, 4.5] },
      ],
    });
    const result = await transcribeAudio("/tmp/audio.wav");
    expect(result).toEqual([
      { text: "two cups flour", start: 0, end: 2.1 },
      { text: "and a pinch of salt", start: 2.1, end: 4.5 },
    ]);
  });

  it("falls back to start when a chunk's end timestamp is missing", async () => {
    transcribeMock.mockResolvedValue({
      text: "trailing",
      chunks: [{ text: "trailing", timestamp: [5, null] }],
    });
    const result = await transcribeAudio("/tmp/audio.wav");
    expect(result).toEqual([{ text: "trailing", start: 5, end: 5 }]);
  });

  it("treats an empty/no-speech transcript as a normal result, not an error", async () => {
    transcribeMock.mockResolvedValue({ text: "", chunks: [] });
    const result = await transcribeAudio("/tmp/silence.wav");
    expect(result).toEqual([]);
  });

  it("falls back to unsegmented text if chunks are missing but text is present", async () => {
    transcribeMock.mockResolvedValue({ text: "some narration" });
    const result = await transcribeAudio("/tmp/audio.wav");
    expect(result).toEqual([{ text: "some narration", start: 0, end: 0 }]);
  });

  it("parses real WAV PCM data end-to-end (not mocked) and passes samples to the pipeline", async () => {
    // int16 100 / 32768 = 0.030517578125, -100 / 32768 = -0.030517578125
    readFileMock.mockResolvedValue(buildWavBuffer([0, 16384, -16384, 32767]));
    transcribeMock.mockResolvedValue({ text: "", chunks: [] });

    await transcribeAudio("/tmp/audio.wav");

    const passedSamples = transcribeMock.mock.calls[0]?.[0] as Float32Array;
    expect(passedSamples).toBeInstanceOf(Float32Array);
    expect(passedSamples[0]).toBeCloseTo(0);
    expect(passedSamples[1]).toBeCloseTo(0.5, 3);
    expect(passedSamples[2]).toBeCloseTo(-0.5, 3);
  });

  it("throws a clear error on a non-WAV file", async () => {
    readFileMock.mockResolvedValue(Buffer.from("not a wav file at all"));
    await expect(transcribeAudio("/tmp/bad.wav")).rejects.toThrow("not a RIFF/WAVE file");
  });
});
