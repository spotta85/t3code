/**
 * AnyagentTextGeneration - T3's commit message, PR, branch and title generation
 * over anyagent's one-shot `generate` (a tool-less throwaway session).
 *
 * @module AnyagentTextGeneration
 */
import {
  type ChatAttachment,
  type ModelSelection,
  type ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { AgentDetails } from "anyagent-ts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
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
import { AnyagentRuntime, type Launch } from "./AnyagentRuntime.ts";
import { selectedOptions } from "./AnyagentSnapshot.ts";

type Service = TextGeneration["Service"];
type Operation = keyof Service;

/** Same budget as T3's own CLI-based generators. */
const TIMEOUT = "180 seconds";

/**
 * Text generation for `kind` over the agent `launch` names: each call builds T3's prompt, asks anyagent for one reply,
 * and decodes the JSON in it. `details()` (the newest probe) limits which picked options reach the agent.
 */
export const makeAnyagentTextGeneration = (
  kind: ProviderDriverKind,
  launch: Launch,
  details: () => AgentDetails | null,
) =>
  Effect.gen(function* () {
    const { use } = yield* AnyagentRuntime;
    const { attachmentsDir } = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    /** One reply for `prompt` in `cwd`, with the images among `attachments`, decoded with `schema`; every failure is a TextGenerationError. */
    const runJson = <S extends Schema.Top>(
      operation: Operation,
      cwd: string,
      modelSelection: ModelSelection,
      { prompt, outputSchema }: { prompt: string; outputSchema: S },
      attachments: ReadonlyArray<ChatAttachment> = [],
    ): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.tryPromise({
        try: () =>
          use((runtime) =>
            runtime.generate(
              launch.agent,
              {
                ...launch.options,
                dir: cwd,
                configure: selectedOptions(kind, modelSelection, details()),
                attachments: imagePaths(attachmentsDir, attachments),
              },
              prompt,
            ),
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
          input.attachments,
        ).pipe(Effect.map((out) => ({ branch: sanitizeBranchFragment(out.branch) }))),
      // Titles need only the prompt, so they run in an empty temp dir, not the checkout.
      generateThreadTitle: (input) =>
        fileSystem.makeTempDirectoryScoped({ prefix: "t3code-title-" }).pipe(
          Effect.mapError((cause) =>
            failure("generateThreadTitle", "Failed to create the title directory.", cause),
          ),
          Effect.flatMap((dir) =>
            runJson(
              "generateThreadTitle",
              dir,
              input.modelSelection,
              buildThreadTitlePrompt({
                message: input.message,
                previousTitle: input.previousTitle,
                linkedContext: input.linkedContext,
                attachments: input.attachments,
              }),
              input.attachments,
            ),
          ),
          Effect.scoped,
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

/** The stored files of the image attachments; other attachments stay names in the prompt. */
function imagePaths(attachmentsDir: string, attachments: ReadonlyArray<ChatAttachment>): string[] {
  return attachments.flatMap((attachment) =>
    attachment.type === "image"
      ? (resolveAttachmentPath({ attachmentsDir, attachment }) ?? [])
      : [],
  );
}

/** T3's text generation error for `operation`. */
function failure(operation: Operation, detail: string, cause?: unknown) {
  return new TextGenerationError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });
}

/** An error's message, or the value as text. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
