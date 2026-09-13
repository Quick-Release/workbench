import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { z } from "zod";

import { buildDraftPrompt } from "./ai-prompt.mjs";

// The real model call: one typed round-trip of TanStack AI `chat()` with a
// structured-output schema, against the Anthropic adapter. The key comes from
// the environment the dev scripts already load (.env via dotenvx); the model
// defaults sensibly and is overridable. Exact-pinned dependencies — upgrade
// the @tanstack/ai family as a unit.

const DEFAULT_DRAFT_MODEL = "claude-haiku-4-5";

const DraftOutput = z.object({
  title: z.string(),
  body: z.string(),
});

export const providerConfigured = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY);

export const createDraftModelCall = (env = process.env) => {
  const model = env.ANTHROPIC_MODEL || DEFAULT_DRAFT_MODEL;
  // The adapter types the model as its known-ids union; the env override is
  // deliberately allowed past it so a model swap never needs a code change.
  return async ({ pr, commitSubjects }) =>
    await chat({
      adapter: anthropicText(model),
      messages: [{ role: "user", content: buildDraftPrompt({ pr, commitSubjects }) }],
      outputSchema: DraftOutput,
    });
};
