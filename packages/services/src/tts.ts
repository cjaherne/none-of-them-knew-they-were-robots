import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getOpenAIClient } from "./llm";

const s3 = new S3Client({});

export interface TTSResult {
  audioKey: string;
  audioUrl: string;
}

export async function generateSpeech(
  text: string,
  openaiSecretArn: string,
  audioBucket: string,
  taskId: string
): Promise<TTSResult> {
  const client = await getOpenAIClient(openaiSecretArn);

  const response = await client.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
    response_format: "mp3",
  });

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const audioKey = `responses/${taskId}.mp3`;

  await s3.send(
    new PutObjectCommand({
      Bucket: audioBucket,
      Key: audioKey,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    })
  );

  return {
    audioKey,
    audioUrl: `https://${audioBucket}.s3.amazonaws.com/${audioKey}`,
  };
}

export function buildSummaryText(result: {
  filesModified?: number;
  testsPassed?: boolean;
  commitCreated?: boolean;
  errors?: string[];
}): string {
  const parts: string[] = ["Task completed."];

  if (result.filesModified !== undefined) {
    parts.push(`${result.filesModified} file${result.filesModified !== 1 ? "s" : ""} modified.`);
  }
  if (result.testsPassed !== undefined) {
    parts.push(result.testsPassed ? "All tests passed." : "Some tests failed.");
  }
  if (result.commitCreated) {
    parts.push("Commit created.");
  }
  if (result.errors?.length) {
    parts.push(`${result.errors.length} error${result.errors.length !== 1 ? "s" : ""} encountered.`);
  }

  return parts.join(" ");
}
