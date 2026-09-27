// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  createProviderVersionAdvisory,
  type ProviderMaintenanceCapabilitiesResolver,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { CURSOR_UPDATE, GROK_UPDATE, makeCodexMaintenanceResolver } from "./maintenance.ts";

// The `#!/bin/sh` stubs below cannot be resolved as executables on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

// Resolving never downloads: the latest version comes from a seeded cache.
const testLayer = Layer.merge(
  NodeServices.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Resolving an update must not make an HTTP request")),
  ),
);

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Resolving an update must not spawn a process"),
);

/** Resolves `resolver` for `binaryPath` the way a driver does; by default nothing may be spawned. */
const resolve = (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  spawner = noSpawn,
) =>
  resolveProviderMaintenanceCapabilitiesEffect(resolver, { binaryPath, env }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

/** The codex resolver for a shared home inside `tempDir`. */
const codexIn = (tempDir: string) =>
  makeCodexMaintenanceResolver(NodePath.join(tempDir, "codex-home"));

/** Writes an executable `#!/bin/sh` stub at `filePath`. */
const writeStub = (filePath: string, content = "#!/bin/sh\n") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(NodePath.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
    yield* fs.chmod(filePath, 0o755);
  });

it.layer(testLayer)("codex update", (it) => {
  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-update-" });
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* writeStub(binaryPath);

        const capabilities = yield* resolve(makeCodexMaintenanceResolver(sharedHome), binaryPath);
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const binaryPath = NodePath.join(NodeOS.tmpdir(), "t3-codex-missing", "codex");
      expect((yield* resolve(codexIn(NodeOS.tmpdir()), binaryPath)).update).toBeNull();
    }),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-installer-" });
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const update = (yield* resolve(codexIn(tempDir), binaryPath)).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(Effect.scoped),
    );
  }

  for (const layout of ["direct", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`leaves a mise ${layout} installation manual-only`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: `t3-codex-mise-${layout}-` });
        const binaryPath =
          layout === "direct"
            ? NodePath.join(tempDir, "mise", "installs", "codex", "0.110.0", "codex")
            : NodePath.join(tempDir, "omarchy", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(
          binaryPath,
          layout === "direct"
            ? "#!/bin/sh\n"
            : '#!/bin/sh\nmise use -g --quiet "codex" || exit 1\nexec mise x "codex" -- "codex" "$@"\n',
        );
        yield* fs.chmod(binaryPath, 0o755);

        expect((yield* resolve(codexIn(tempDir), binaryPath)).update).toBeNull();
      }).pipe(Effect.scoped),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" });
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args);
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const capabilities = yield* resolve(
          codexIn(tempDir),
          fixture.commandName,
          { ...process.env, PATH: lookupPath },
          metadataSpawner,
        );
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideService(
            ProviderVersionCache,
            new Map([
              ["@openai/codex", { expiresAt: Number.MAX_SAFE_INTEGER, version: "0.153.4" }],
            ]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: ProviderDriverKind.make("codex"),
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining(["--prefix", npmPrefix, "@openai/codex@latest"]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});

it.layer(testLayer)("cursor update", (it) => {
  it.effect.skipIf(windowsHost)(
    "quotes a configured executable path in the copyable update command",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-update-" });
        const binaryPath = NodePath.join(tempDir, "Cursor Tools", "bin", "cursor-agent");
        yield* writeStub(binaryPath);

        const capabilities = yield* resolve(CURSOR_UPDATE, binaryPath);
        expect(capabilities.update).toMatchObject({
          command: `'${binaryPath}' update`,
          executable: binaryPath,
          args: ["update"],
        });
      }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const binaryPath = NodePath.join(NodeOS.tmpdir(), "t3-cursor-missing", "cursor-agent");
      expect((yield* resolve(CURSOR_UPDATE, binaryPath)).update).toBeNull();
    }),
  );
});

it.layer(testLayer)("grok update", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-update-" });
      const grokHome = NodePath.join(tempDir, "Grok Home");
      const binaryPath = NodePath.join(grokHome, "bin", "grok");
      yield* writeStub(binaryPath);

      const capabilities = yield* resolve(GROK_UPDATE, binaryPath, {
        ...process.env,
        GROK_HOME: grokHome,
      });
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this environment's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      expect((yield* resolve(GROK_UPDATE, NodePath.join(tempDir, "grok"))).update).toBeNull();
    }).pipe(Effect.scoped),
  );
});
