/**
 * AnyagentRuntime - the one `anyagent serve` process a T3 server shares across drivers.
 * It starts on first use, and again on the next use after it exits, so a missing
 * binary or a crash is an error on the calls that need it, never a server that won't boot.
 *
 * @module AnyagentRuntime
 */
import { AnyagentError, Runtime, type StartOptions } from "anyagent-ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The shared anyagent-ts Runtime, reached through `use`. */
export class AnyagentRuntime extends Context.Service<
  AnyagentRuntime,
  {
    /** Runs `f` on the live runtime; starts `anyagent serve` first when none is running. A failed start rejects. */
    readonly use: <A>(f: (runtime: Runtime) => Promise<A>) => Promise<A>;
  }
>()("t3/provider/anyagent/AnyagentRuntime") {}

/** The runtime for the layer's lifetime, closed on release; `options` picks the binary or a mock script. */
export const makeAnyagentRuntimeLayer = (options: StartOptions = {}) =>
  Layer.effect(
    AnyagentRuntime,
    Effect.acquireRelease(
      Effect.sync(() => lazyRuntime(options)),
      (handle) => Effect.promise(handle.close),
    ).pipe(Effect.map(({ use }) => ({ use }))),
  );

/** The server's runtime: the binary from ANYAGENT_BIN, else anyagent-ts's platform package. */
export const AnyagentRuntimeLive = makeAnyagentRuntimeLayer();

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** A runtime started on demand and forgotten when its start fails or its process exits. */
function lazyRuntime(options: StartOptions) {
  let current: Promise<Runtime> | undefined;
  let closed = false;

  /** Starts one `anyagent serve`; once it is gone (or never came up) the next use starts another. */
  const start = () => {
    const started = Runtime.start(options);
    current = started;
    void started
      .then(
        (runtime) => runtime.exited,
        () => undefined,
      )
      .then(() => {
        if (current === started) current = undefined;
      });
    return started;
  };

  return {
    use: <A>(f: (runtime: Runtime) => Promise<A>): Promise<A> =>
      closed
        ? Promise.reject(
            new AnyagentError({ kind: "SessionClosed", message: "anyagent runtime closed" }),
          )
        : (current ?? start()).then(f),
    close: async () => {
      closed = true;
      const running = current;
      current = undefined;
      await running?.then(
        (runtime) => runtime.close(),
        () => undefined,
      );
    },
  };
}
