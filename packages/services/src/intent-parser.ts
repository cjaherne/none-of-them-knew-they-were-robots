import OpenAI from "openai";
import { ParsedIntent } from "@agents/shared";
import { getOpenAIClient, chatCompletion } from "./llm";

const INTENT_SYSTEM_PROMPT = `You are an intent parser for a voice-controlled development automation system.
Given a natural language command, extract a structured intent.

Respond with JSON matching this schema:
{
  "action": "cursor_task" | "status_query" | "approval_response",
  "prompt": "the cleaned-up task description",
  "repo": "current" or a specific repo name if mentioned,
  "requiresApproval": true if the task involves deployment, publishing, deletion, or pushing code,
  "metadata": {} any additional extracted info
}

Rules:
- Default repo to "current" unless a specific repo is named
- Set requiresApproval=true for: git push, deploy, publish, delete files, install deps, database changes
- Set requiresApproval=false for: refactoring, adding features, running tests, code review
- For status queries like "what's the status of my task", use action "status_query"
- For approval responses like "yes approve it" or "no reject", use action "approval_response"`;

export async function parseIntent(
  rawText: string,
  openaiSecretArn: string
): Promise<ParsedIntent> {
  const client = await getOpenAIClient(openaiSecretArn);

  const response = await chatCompletion(
    client,
    [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content: rawText },
    ],
    {
      model: "gpt-4o-mini",
      maxTokens: 512,
      temperature: 0.1,
      responseFormat: "json_object",
    }
  );

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from intent parser");
  }

  return JSON.parse(content) as ParsedIntent;
}
