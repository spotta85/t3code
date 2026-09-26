/**
 * AnyagentRuntime - the one `anyagent serve` process a T3 server shares across drivers.
 *
 * @module AnyagentRuntime
 */
import { Runtime, type StartOptions } from "anyagent-ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The shared anyagent-ts Runtime. */
export class AnyagentRuntime extends Context.Service<
  AnyagentRuntime,
  { readonly runtime: Runtime }
>()("t3/provider/anyagent/AnyagentRuntime") {}

/** Starts `anyagent serve` for the layer's lifetime and closes it on release; `options` picks the binary or a mock script. */
export const makeAnyagentRuntimeLayer = (options: StartOptions = {}) =>
  Layer.effect(
    AnyagentRuntime,
    Effect.acquireRelease(
      Effect.promise(() => Runtime.start(options)),
      (runtime) => Effect.promise(() => runtime.close()),
    ).pipe(Effect.map((runtime) => ({ runtime }))),
  );

/** The server's runtime: the binary from ANYAGENT_BIN, else anyagent-ts's platform package. */
export const AnyagentRuntimeLive = makeAnyagentRuntimeLayer();
