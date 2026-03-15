import { toFile } from "openai";
import { getOpenAIClient } from "./llm";

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  openaiSecretArn: string
): Promise<TranscriptionResult> {
  const client = await getOpenAIClient(openaiSecretArn);

  const file = await toFile(audioBuffer, "audio.webm", { type: "audio/webm" });

  const transcription = await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
  });

  return {
    text: transcription.text,
    language: transcription.language,
    durationSeconds: transcription.duration,
  };
}

export async function transcribeFromBase64(
  base64Audio: string,
  openaiSecretArn: string
): Promise<TranscriptionResult> {
  const buffer = Buffer.from(base64Audio, "base64");
  return transcribeAudio(buffer, openaiSecretArn);
}
