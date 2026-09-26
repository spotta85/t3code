/**
 * Errors - anyagent-ts failures as T3's adapter errors.
 *
 * @module AnyagentErrors
 */
import { AnyagentError } from "anyagent-ts";

import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
} from "../Errors.ts";

/** What AnyagentAdapter fails with: T3's own adapter errors, so ProviderService handles them as usual. */
export type AnyagentAdapterError = ProviderAdapterError;

/** A rejected anyagent-ts call as a T3 adapter error; the anyagent error (kind, message, data) is the `cause`. */
export function toAdapterError(
  provider: string,
  threadId: string,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const kind = cause instanceof AnyagentError ? cause.kind : "Error";
  const detail = `${kind}: ${cause instanceof Error ? cause.message : String(cause)}`;
  return kind === "ProcessExited" || kind === "SpawnFailed"
    ? new ProviderAdapterProcessError({ provider, threadId, detail, cause })
    : new ProviderAdapterRequestError({ provider, method, detail, cause });
}
