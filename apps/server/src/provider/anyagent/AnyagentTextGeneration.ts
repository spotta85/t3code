/**
 * AnyagentTextGeneration - T3's commit message, PR, branch and title generation
 * over anyagent's one-shot `generate` (a tool-less throwaway session).
 *
 * @module AnyagentTextGeneration
 */
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import { AnyagentRuntime } from "./AnyagentRuntime.ts";
import { selectedOptions } from "./AnyagentSnapshot.ts";

type Service = TextGeneration["Service"];
type Operation = keyof Service;

/** Same budget as T3's own CLI-based generators. */
const TIMEOUT = "180 seconds";

/**
 * Text generation for `agent`: each call builds T3's prompt, asks anyagent for one reply,
 * and decodes the JSON in it. `advertised` limits which picked options reach the agent.
 */
export const makeAnyagentTextGeneration = (agent: string, advertised: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const { runtime } = yield* AnyagentRuntime;

    /** One reply for `prompt` in `cwd`, decoded with `schema`; every failure is a TextGenerationError. */
    const runJson = <S extends Schema.Top>(
      operation: Operation,
      cwd: string,
      modelSelection: ModelSelection,
      { prompt, outputSchema }: { prompt: string; outputSchema: S },
    ): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.tryPromise({
        try: () =>
          runtime.generate(
            agent,
            { dir: cwd, configure: selectedOptions(modelSelection, advertised) },
            prompt,
          ),
        catch: (cause) =>
          failure(operation, `anyagent generate failed: ${messageOf(cause)}`, cause),
      }).pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(failure(operation, "anyagent generate timed out.")),
        }),
        Effect.flatMap((text) =>
          Schema.decodeEffect(Schema.fromJsonString(outputSchema))(extractJsonObject(text.trim())),
        ),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(failure(operation, "The agent returned invalid structured output.", cause)),
        ),
      );

    return {
      generateCommitMessage: (input) =>
        runJson(
          "generateCommitMessage",
          input.cwd,
          input.modelSelection,
          buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          }),
        ).pipe(
          Effect.map((out) => ({
            subject: sanitizeCommitSubject(out.subject),
            body: out.body.trim(),
            ...("branch" in out && typeof out.branch === "string"
              ? { branch: sanitizeFeatureBranchName(out.branch) }
              : {}),
          })),
        ),
      generatePrContent: (input) =>
        runJson(
          "generatePrContent",
          input.cwd,
          input.modelSelection,
          buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
            policy: input.policy,
            changeRequestTemplate: input.changeRequestTemplate,
          }),
        ).pipe(Effect.map((out) => ({ title: sanitizePrTitle(out.title), body: out.body.trim() }))),
      generateBranchName: (input) =>
        runJson(
          "generateBranchName",
          input.cwd,
          input.modelSelection,
          buildBranchNamePrompt({ message: input.message, attachments: input.attachments }),
        ).pipe(Effect.map((out) => ({ branch: sanitizeBranchFragment(out.branch) }))),
      generateThreadTitle: (input) =>
        runJson(
          "generateThreadTitle",
          input.cwd,
          input.modelSelection,
          buildThreadTitlePrompt({
            message: input.message,
            previousTitle: input.previousTitle,
            linkedContext: input.linkedContext,
            attachments: input.attachments,
          }),
        ).pipe(
          Effect.map((out) => ({
            title: sanitizeThreadTitle(out.title),
            ...(out.needsRefinement ? { needsRefinement: true } : {}),
          })),
        ),
    } satisfies Service;
  });

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function failure(operation: Operation, detail: string, cause?: unknown) {
  return new TextGenerationError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
