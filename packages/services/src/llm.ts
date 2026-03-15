import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import OpenAI from "openai";

const secretsClient = new SecretsManagerClient({});

let openaiClient: OpenAI | null = null;

async function getSecret(secretArn: string): Promise<string> {
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  if (!result.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }
  return result.SecretString;
}

export async function getOpenAIClient(secretArn: string): Promise<OpenAI> {
  if (openaiClient) return openaiClient;
  const apiKey = await getSecret(secretArn);
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json_object";
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export async function chatCompletion(
  client: OpenAI,
  messages: LLMMessage[],
  options: LLMCompletionOptions = {}
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const {
    model = "gpt-4o",
    maxTokens = 4096,
    temperature = 0.7,
    responseFormat,
    tools,
  } = options;

  return client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(responseFormat && { response_format: { type: responseFormat } }),
    ...(tools && { tools }),
  });
}
