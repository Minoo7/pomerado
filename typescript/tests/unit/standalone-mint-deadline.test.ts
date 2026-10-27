import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import type { PlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { mintError } from "../../src/standalone/errors.js";
import { openJobTrace } from "../../src/standalone/job-trace.js";
import { localLiveTests } from "../../src/standalone/mint-live-tests.js";
import { mintPublication } from "../../src/standalone/mint-publication.js";
import { mintState } from "../../src/standalone/mint-state.js";
import { requestContext } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

const unused = () => Effect.dieMessage("This fixture must not use a browser or ask for input");
const browser: PlaywrightExecutor = {
  sessionId: "synthetic-session",
  targetId: "synthetic-target",
  execute: unused,
  executeResponse: unused,
  watchTyping: () => ({ executeResponse: unused, typed: () => new Set<number>() }),
  keyboard: { insertText: unused },
  close: Effect.void,
};
const entrypoint = "src/tool.mjs";
const source = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
process.exit(7);
export default defineOperation({ input: Schema.Struct({}), output: Schema.Unknown }, async () => ({}));`;
const eventSchema = Schema.Struct({ kind: Schema.String, data: Schema.Unknown });

it.each([
  { path: "live schemas", timeoutMs: undefined },
  { path: "live schemas", timeoutMs: 90_000 },
  { path: "live case", timeoutMs: undefined },
  { path: "live case", timeoutMs: 90_000 },
  { path: "publication contract", timeoutMs: undefined },
  { path: "publication contract", timeoutMs: 90_000 },
])("reports the inherited mint deadline for $path with timeout $timeoutMs", async ({ path, timeoutMs }) => {
  const directory = mkdtempSync(join(tmpdir(), "pomerado-mint-deadline-"));
  const id = randomUUID();
  const trace = openJobTrace(directory, id, { selection: { depth: "debug", capture: "none" } });
  let elapsedMs = 0;
  const budgetMs = timeoutMs ?? 1_200_000;
  const deadline = Deadline.after(budgetMs, () => elapsedMs);
  const operations = trace.operations;
  if (operations === undefined) throw new Error("Expected operation diagnostics");
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const secrets = trace.secrets;
      const session: StandaloneSession = {
        trace: {
          ...trace,
          operations: {
            open: (options) => {
              const recorder = operations.open(options);
              return {
                ...recorder,
                event: (kind, data) => {
                  elapsedMs = 733;
                  recorder.event(kind, data);
                },
              };
            },
          },
        },
        options: {
          ask: unused,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          guardianProvider: { getModel: () => { throw new Error("No live model requests allowed"); } },
        },
        browser,
        policy: "{{ tenant_policy_config }}",
        secrets,
        mutex: yield* Effect.makeSemaphore(1),
        trustedSources: new Map(yield* localRuntimeAssets),
        projection: {
          text: (value) => Effect.sync(() => secrets.redact(value)),
          json: (value) => secrets.json(value).pipe(Effect.mapError(mintError)),
          source: (_path, value) => secrets.assertAbsent(value).pipe(Effect.as(value), Effect.mapError(mintError)),
        },
        ask: unused,
        signInTyping: { typed: false },
      };
      const request = { intent: "Read synthetic totals", url: "https://totals.example.test/", effect: "read" } as const;
      const context = yield* requestContext(session, request);
      const initial = yield* mintState(session, {
        ...context,
        review: () => Effect.succeed({ reviewId: "synthetic-review", decision: { outcome: "allow", rationale: "Synthetic allow.", action: "read" } }),
      }, request, { files: [], resolve: () => undefined });
      const state = { ...initial, deadline, start: { ...initial.start, before: () => Effect.void } };
      yield* state.workspace.write(entrypoint, source);
      if (path === "live schemas") {
        expect(yield* Effect.either(localLiveTests(state).schemas(entrypoint))).toMatchObject({ _tag: "Left" });
      } else if (path === "live case") {
        expect(yield* localLiveTests(state).run({
          entrypoint,
          sourceDigest: "synthetic-digest",
          cases: [{ id: "synthetic-case", input: {} }],
          workers: 1,
          deadlineAt: Date.now() + 120_000,
        })).toMatchObject({ status: "ran", cases: [{ id: "synthetic-case", outcome: { status: "inconclusive", reason: "host" } }] });
      } else {
        state.runs.set("synthetic-example", {
          sources: [[entrypoint, source]], entrypoint, input: {}, output: {}, purpose: "example",
          journal: { effect: "not_sent", commits: [] },
        });
        expect(yield* Effect.either(mintPublication(state)({
          entrypoint,
          executionId: "synthetic-example",
          metadata: { name: "synthetic_totals", description: "Read synthetic totals" },
          coverage: "One synthetic example.",
        }, {
          executionId: "synthetic-example", status: "completed", effect: "verified", resultRef: "local:synthetic-example", observations: {},
        }))).toMatchObject({ _tag: "Left" });
      }
    })));
    trace.close();
    const events = readFileSync(join(directory, `${id}.jsonl`), "utf8").trim().split("\n")
      .map((line) => Schema.decodeUnknownSync(eventSchema)(JSON.parse(line)));
    const unfinished = events.filter((event) => event.kind === "span.unfinished");
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.data).toMatchObject({
      reason: "error",
      inheritedDeadline: { name: "mint", budgetMs, remainingMs: budgetMs - 733 },
    });
  } finally {
    trace.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
