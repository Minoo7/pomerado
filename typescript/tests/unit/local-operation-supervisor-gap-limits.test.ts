import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { superviseOperation } from "../../src/execution/local-operation-supervisor.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { openJobTrace } from "../../src/standalone/job-trace.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const Event = Schema.Struct({ kind: Schema.String, data: Schema.Record({ key: Schema.String, value: Schema.Unknown }) });
const events = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => Schema.decodeUnknownSync(Event)(JSON.parse(line)));

it.each(["normal", "trace"] as const)("bounds diagnostic flood gaps at %s depth", async (depth) => {
  const directory = mkdtempSync(join(tmpdir(), "pomerado-gap-limits-")); directories.push(directory);
  const id = randomUUID(); let syncs = 0;
  const trace = openJobTrace(directory, id, { selection: { depth, capture: "none" }, sync: () => { syncs++; } });
  const child = new ChildProcess();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      for (let operation = 0; operation < 2; operation++) {
        const supervisor = superviseOperation(trace.operations.open({ workspace, entrypoint: "src/tool.mjs", sources: [] }), 5_000, Deadline.after(5_000));
        try {
          for (let count = 0; count < 1_000; count++) {
            expect(supervisor.accept({ kind: "diagnostic", event: "forged" }, child)).toBe(true);
            expect(supervisor.accept({ kind: "diagnostic", event: "start", id: `child:${count + 1}`, parent: "operation", phase: "operation.run" }, child)).toBe(true);
            supervisor.begin("host.result.decode");
          }
          yield* supervisor.beforeKill("deadline");
        } finally { yield* supervisor.close(); }
      }
    })));
    trace.event("job.end", {});
  } finally { trace.close(); }
  const recorded = events(join(directory, `${id}.jsonl`));
  const reasons = recorded.filter((event) => event.kind === "diagnostic.gap").map((event) => event.data["reason"]);
  expect(reasons.filter((reason) => reason === "malformed_diagnostic")).toHaveLength(2);
  expect(reasons.filter((reason) => reason === "span_cap")).toHaveLength(depth === "normal" ? 0 : 2);
  expect(recorded.filter((event) => event.kind === "span.start")).toHaveLength(depth === "normal" ? 0 : 512);
  expect(recorded.filter((event) => event.kind === "span.unfinished")).toHaveLength(depth === "normal" ? 0 : 2);
  expect(syncs).toBeLessThanOrEqual(depth === "normal" ? 4 : 520);
});

it("reserves unfinished and job end records independently of gap floods", () => {
  const directory = mkdtempSync(join(tmpdir(), "pomerado-gap-reserve-")); directories.push(directory);
  const id = randomUUID(); const maximumBytes = 8_192;
  const trace = openJobTrace(directory, id, { selection: { depth: "trace", capture: "none" }, jobBytes: maximumBytes, sync: () => {} });
  try {
    for (let count = 0; count < 200; count++) trace.event("diagnostic.gap", { reason: `synthetic_${count}` });
    trace.event("span.unfinished", { reason: "deadline", active: Array.from({ length: 50 }, () => ({ phase: "operation.run", detail: "x".repeat(100) })) });
    trace.event("job.end", { output: "x".repeat(maximumBytes) });
  } finally { trace.close(); }
  const path = join(directory, `${id}.jsonl`);
  const recorded = events(path);
  expect(recorded.slice(-2).map((event) => event.kind)).toEqual(["span.unfinished", "job.end"]);
  expect(readFileSync(path).length).toBeLessThanOrEqual(maximumBytes);
});
