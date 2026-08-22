/**
 * GrokSkills — skill discovery for the `$` picker via `grok inspect --json`.
 *
 * Unlike Claude Code, the Grok CLI already resolves its full catalog:
 * `grok inspect --json` returns `skills[]` with `name`, `description`,
 * `source.type` (`user` / `project` / `bundled` / `plugin` / `config` /
 * `server`), `source.path` (the absolute `SKILL.md` path), and
 * `userInvocable`. Asking the CLI beats scanning the filesystem because
 * the catalog honors Grok's own ignore/disable config and includes plugin
 * skills, which live several levels deep under `~/.grok/installed-plugins/`
 * where a flat scan cannot see them. This mirrors how the Codex app-server
 * reports skills over `skills/list`.
 *
 * Discovery is best-effort: an older CLI without `inspect`, a timeout, a
 * non-zero exit, or malformed output yields an empty list and never
 * degrades the provider snapshot.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

function parseInspectDocument(stdout: string): unknown {
  const trimmed = stdout.replace(/^\uFEFF/, "").trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Grok may print a warning line before the JSON object, especially on
    // Windows. Take the outermost object if it is valid JSON.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function inspectSourceScope(source: Record<string, unknown> | undefined): string {
  const raw = source?.type ?? source?.kind;
  return typeof raw === "string" ? raw.trim() : "";
}

function inspectSourcePath(
  record: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
): string {
  const fromSource = typeof source?.path === "string" ? source.path.trim() : "";
  if (fromSource.length > 0) {
    return fromSource;
  }
  return typeof record.path === "string" ? record.path.trim() : "";
}

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped; `userInvocable: false` skills are
 * kept but disabled so pickers that filter on `enabled` hide them. Grok
 * already deduplicates by name with its own precedence; if a payload still
 * repeats a name, the first entry wins.
 */
export function parseGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> {
  const parsed = parseInspectDocument(stdout);
  const root = asRecord(parsed);
  const entries = root?.skills;
  if (!Array.isArray(entries)) {
    return [];
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source = asRecord(record.source);
    const path = inspectSourcePath(record, source);
    if (!name || !path || skillsByName.has(name)) {
      continue;
    }
    const scope = inspectSourceScope(source);
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Run `grok inspect --json` and map the reported catalog onto provider
 * skills. Never fails: any spawn error, non-zero exit, or timeout resolves
 * to an empty list.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = grokSettings.binaryPath || "grok";
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(inspectResult)) {
    yield* Effect.logDebug("Grok skill discovery failed; continuing without skills.", {
      errorTag: errorTag(inspectResult.failure),
    });
    return [];
  }
  if (Option.isNone(inspectResult.success)) {
    yield* Effect.logDebug("Grok skill discovery timed out; continuing without skills.");
    return [];
  }

  const output = inspectResult.success.value;
  if (output.code !== 0) {
    yield* Effect.logDebug("Grok skill discovery exited non-zero; continuing without skills.", {
      exitCode: output.code,
    });
    return [];
  }
  return parseGrokInspectSkills(output.stdout);
});
