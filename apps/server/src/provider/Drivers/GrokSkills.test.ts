import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverGrokSkills, parseGrokInspectSkills } from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

describe("parseGrokInspectSkills", () => {
  it("maps inspect entries onto provider skills, sorted by name", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "writing-docs",
          description: "Write user docs.",
          source: { type: "user", path: "/home/dev/.grok/skills/writing-docs/SKILL.md" },
          userInvocable: true,
        },
        {
          name: "deploy",
          description: "Deploy the app.",
          source: {
            type: "plugin",
            path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
          },
          userInvocable: true,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "deploy",
        description: "Deploy the app.",
        path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
        scope: "plugin",
        enabled: true,
      },
      {
        name: "writing-docs",
        description: "Write user docs.",
        path: "/home/dev/.grok/skills/writing-docs/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("keeps Windows SKILL.md paths and Grok's global user scope", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "tdd",
          description: "Test-driven development.",
          source: {
            type: "user",
            path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
          },
        },
        {
          name: "create-skill",
          source: {
            type: "bundled",
            path: "C:\\Users\\Drew\\.grok\\bundled\\skills\\create-skill\\SKILL.md",
          },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "create-skill",
        path: "C:\\Users\\Drew\\.grok\\bundled\\skills\\create-skill\\SKILL.md",
        scope: "bundled",
        enabled: true,
      },
      {
        name: "tdd",
        description: "Test-driven development.",
        path: "C:\\Users\\Drew\\.grok\\skills\\tdd\\SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("accepts source.kind as an alias for source.type", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "kept",
          source: { kind: "project", path: "/repo/.grok/skills/kept/SKILL.md" },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "kept",
        path: "/repo/.grok/skills/kept/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("disables skills the CLI marks as not user-invocable", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "internal-helper",
          source: { type: "bundled", path: "/opt/grok/bundled/skills/internal-helper/SKILL.md" },
          userInvocable: false,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "internal-helper",
        path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
        scope: "bundled",
        enabled: false,
      },
    ]);
  });

  it("keeps the first entry when inspect repeats a skill name", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "review",
          source: { type: "user", path: "/home/dev/.grok/skills/review/SKILL.md" },
        },
        {
          name: "review",
          source: { type: "bundled", path: "/opt/grok/bundled/skills/review/SKILL.md" },
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "review",
        path: "/home/dev/.grok/skills/review/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("skips entries without a name or a filesystem path", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
        { name: "no-path", source: { type: "user" } },
        { name: "no-source" },
        { name: 42, source: { type: "user", path: "/tmp/skills/wrong-name/SKILL.md" } },
        { name: "wrong-source", source: "user" },
        "not-an-object",
        {
          name: "kept",
          source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" },
          ignoredByT3: true,
        },
      ]),
    );

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("parses JSON with a UTF-8 BOM or a warning preamble", () => {
    const body = inspectPayload([
      { name: "kept", source: { type: "user", path: "/home/dev/.grok/skills/kept/SKILL.md" } },
    ]);

    expect(parseGrokInspectSkills(`\uFEFF${body}`).map((skill) => skill.name)).toEqual(["kept"]);
    expect(
      parseGrokInspectSkills(`warn: inspect starting\n${body}`).map((skill) => skill.name),
    ).toEqual(["kept"]);
  });

  it("returns an empty list for malformed or unexpected output", () => {
    expect(parseGrokInspectSkills("not json")).toEqual([]);
    expect(parseGrokInspectSkills("null")).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({ skills: "nope" }))).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({}))).toEqual([]);
  });
});

describe("discoverGrokSkills", () => {
  it.effect("spawns the inspect probe in the configured cwd", () => {
    const spawnCwds: Array<string | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      spawnCwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.make(
              inspectPayload([
                {
                  name: "kept",
                  source: { type: "project", path: "/workspaces/demo/.grok/skills/kept/SKILL.md" },
                },
              ]),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

    return Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {}, "/workspaces/demo").pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    });
  });
});
