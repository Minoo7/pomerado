import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { DiagnosticSelection, resolveDiagnosticSelection, type OperationDiagnostics } from "../execution/local-operation-supervisor.js";
import { encodeReplayValue, operationSnapshot, requestDigest, runtimeIdentity, type ReplayBundle } from "../execution/local-operation-replay.js";
import { assertNoSymlinkComponents } from "../execution/local-path.js";
import { join } from "node:path";
import { Effect, Exit, type Scope } from "effect";
import { makeRunSecrets, type RunSecrets } from "../inputs/secrets.js";
import { traceValue } from "../privacy/trace-value.js";

export interface JobTrace {
  readonly event: (kind: string, data: unknown, ref?: string) => void;
  readonly secrets: RunSecrets;
  readonly operations?: OperationDiagnostics;
}
export const validateTraceDirectory = (directory: string) => {
  assertNoSymlinkComponents(directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Trace directory must be an owned directory with mode 0700.");
};

const stderrNotice = (text: string) => {
  try { writeSync(2, text); } catch {}
};

export const openJobTrace = (
  directory: string,
  jobId: string,
  io: {
    readonly selection?: DiagnosticSelection;
    readonly jobBytes?: number;
    readonly profileCount?: number;
    readonly write?: (fd: number, bytes: Uint8Array, offset: number, length: number, position: null) => number;
    readonly sync?: (fd: number) => void;
    readonly notice?: (text: string) => unknown;
  } = {},
) => {
  const selection = resolveDiagnosticSelection(io.selection ?? {});
  const { write = writeSync, sync = fsyncSync, notice = stderrNotice } = io;
  if (!/^[0-9a-f-]{36}$/u.test(jobId)) throw new Error("Invalid trace job ID.");
  assertNoSymlinkComponents(directory);
  validateTraceDirectory(directory);
  const fd = openSync(join(directory, `${jobId}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const secrets = makeRunSecrets();
  let state: "open" | "broken" | "closed" = "open";
  let seq = 0;
  let bytesUsed = 0;
  let profileCount = 0;
  let profileCapReported = false;
  let captureBytes = 0;
  let budgetGap = false;
  const maximumBytes = io.jobBytes ?? 128 * 1024 * 1024;
  const terminalReserve = Math.min(64 * 1024, maximumBytes / 2);
  const artifact = (suffix: string, bytes: Uint8Array) => {
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u.test(suffix) || state !== "open" || bytes.length > 32 * 1024 * 1024 || bytesUsed + bytes.length > maximumBytes - terminalReserve) return false;
    let artifactFd: number | undefined;
    const file = `${jobId}.${randomUUID()}.${suffix}`;
    try {
      artifactFd = openSync(join(directory, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      bytesUsed += bytes.length;
      let offset = 0;
      while (offset < bytes.length) { const count = write(artifactFd, bytes, offset, bytes.length - offset, null); if (count <= 0) throw new Error("Incomplete artifact"); offset += count; }
      sync(artifactFd); return file;
    } catch { return false; }
    finally { if (artifactFd !== undefined) { try { closeSync(artifactFd); } catch {} } }
  };
  const metadataKinds = new Set(["span.start", "span.end", "operation.child", "span.unfinished", "operation.stall", "diagnostic.gap", "artifact.profile", "artifact.replay"]);
  const stopped = () => {
    if (state !== "open") return;
    state = "broken";
    try { notice("Private job trace stopped after a write failure.\n"); } catch {}
  };
  const trace = {
    secrets,
    event: (kind: string, data: unknown, ref?: string) => {
      if (state !== "open") return;
      const event = { seq: seq + 1, at: new Date().toISOString(), job: jobId, kind, ...(ref === undefined ? {} : { ref }) };
      let line: Buffer;
      try {
        const captured = selection.capture === "none" && !metadataKinds.has(kind) ? { traceCapture: "disabled" } : data;
        line = Buffer.from(JSON.stringify(traceValue({ ...event, data: captured }, secrets.redact)) + "\n");
      } catch {
        line = Buffer.from(JSON.stringify(traceValue({ ...event, data: { traceCapture: "failed" } }, secrets.redact)) + "\n");
      }
      if (kind === "job.end" && line.length > terminalReserve / 2) line = Buffer.from(JSON.stringify({ ...event, data: { traceCapture: "job_cap" } }) + "\n");
      if (kind === "span.unfinished" && line.length > terminalReserve / 4) line = Buffer.from(JSON.stringify({ ...event, data: { traceCapture: "job_cap" } }) + "\n");
      const reserved = kind === "job.end" ? 0 : kind === "span.unfinished" ? terminalReserve / 2 : kind === "diagnostic.gap" ? terminalReserve * 3 / 4 : terminalReserve;
      if (bytesUsed + line.length > maximumBytes - reserved) {
        if (!budgetGap) { budgetGap = true; trace.event("diagnostic.gap", { reason: "job_cap" }); }
        return;
      }
      seq++;
      bytesUsed += line.length;
      try {
        let offset = 0;
        while (offset < line.length) {
          const written = write(fd, line, offset, line.length - offset, null);
          if (written <= 0) throw new Error("Incomplete trace write.");
          offset += written;
        }
        sync(fd);
      } catch { stopped(); }
    },
  };
  const close = () => {
    if (state === "closed") return;
    try { if (state === "open") sync(fd); } catch { stopped(); }
    try { closeSync(fd); } catch { stopped(); }
    state = "closed";
    secrets.clear();
  };
  const operations: OperationDiagnostics = {
    open: (options) => {
      const operation = randomUUID();
      const gaps = new Set<string>();
      const exchanges: { order: number; digest: string; request: string; reply: string; delivery: number }[] = [];
      let snapshot = "";
      const capture = (value: unknown) => {
        const encoded = encodeReplayValue(value, secrets.redact);
        if (captureBytes + encoded.length > 32 * 1024 * 1024) throw new Error("job_capture_cap");
        captureBytes += encoded.length; return encoded;
      };
      let delivery = 0;
      let ended = false;
      if (selection.capture === "replay") {
        try { snapshot = capture(operationSnapshot(options)); } catch (error) { gaps.add(error instanceof Error ? error.message : "unsafe"); }
        if (options.http !== undefined) gaps.add("unsupported_capability");
      }
      return {
        id: operation,
        selection,
        event: trace.event,
        gap: (reason) => { if (gaps.size < 100) gaps.add(reason); },
        request: (request) => {
          if (selection.capture !== "replay") return -1;
          if (exchanges.length >= 4096) { gaps.add("exchange_cap"); return -1; }
          const order = exchanges.length;
          try { exchanges.push({ order, digest: requestDigest(request), request: capture(request), reply: "", delivery: -1 }); }
          catch (error) { gaps.add(error instanceof Error ? error.message : "unsafe"); }
          return order;
        },
        reply: (order, reply) => {
          if (selection.capture !== "replay" || order < 0) return;
          const exchange = exchanges[order]; if (exchange === undefined) { gaps.add("missing_request"); return; }
          exchange.delivery = delivery++;
          try { exchange.reply = capture(reply); } catch (error) { gaps.add(error instanceof Error ? error.message : "unsafe"); }
        },
        reserveProfile: () => {
          if (profileCount >= (io.profileCount ?? 5)) {
            if (!profileCapReported) { profileCapReported = true; trace.event("diagnostic.gap", { reason: "profile_cap", operation }); }
            return false;
          }
          profileCount++; return true;
        },
        profile: (bytes) => {
          if (bytes.length > 16 * 1024 * 1024) { trace.event("diagnostic.gap", { reason: "profile_cap", operation }); return; }
          const screened = Buffer.from(JSON.stringify(traceValue(JSON.parse(Buffer.from(bytes).toString("utf8")), secrets.redact)));
          const file = artifact("cpuprofile", screened);
          if (!file) trace.event("diagnostic.gap", { reason: "profile_write_failed", operation });
          else trace.event("artifact.profile", { operation, file, bytes: screened.length, sha256: createHash("sha256").update(screened).digest("hex") });
        },
        finish: () => {
          if (ended) return; ended = true;
          if (selection.capture !== "replay") return;
          for (const exchange of exchanges) if (exchange.reply === "") gaps.add("missing_reply");
          try {
            const screen = (value: string) => {
              try { encodeReplayValue(deserialize(Buffer.from(value, "base64")), secrets.redact); return value; }
              catch { gaps.add("redacted_or_invalid"); return ""; }
            };
            snapshot = screen(snapshot);
            for (const exchange of exchanges) { exchange.request = screen(exchange.request); exchange.reply = screen(exchange.reply); }
            const bundle: ReplayBundle = { version: 1, operation, runtime: runtimeIdentity(), snapshot, exchanges, gaps: [...gaps] };
            const file = artifact("replay.json", Buffer.from(JSON.stringify(bundle)));
            if (!file) trace.event("diagnostic.gap", { reason: "replay_write_failed", operation });
            else trace.event("artifact.replay", { operation, file, coverage: gaps.size === 0 ? "complete" : "incomplete", gaps: [...gaps] });
          } catch { trace.event("diagnostic.gap", { operation, reason: "runtime_identity_unavailable" }); }
        },
      };
    },
  };
  return { ...trace, operations, artifact, close };
};

export const tracedEffect = <A, E, R>(trace: JobTrace | undefined, kind: string, effect: Effect.Effect<A, E, R>, ref?: string) =>
  trace === undefined ? effect : effect.pipe(
    Effect.tap((result) => Effect.sync(() => trace.event(`${kind}.result`, result, ref))),
    Effect.tapErrorCause((cause) => Effect.sync(() => trace.event(`${kind}.error`, cause, ref))),
  );

export const withJobTrace = <A>(directory: string, jobId: string, work: (trace: JobTrace) => Effect.Effect<A, Error, Scope.Scope>, selection?: DiagnosticSelection) =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => openJobTrace(directory, jobId, { ...(selection === undefined ? {} : { selection }) }), catch: (cause) => new Error("Could not open private job trace.", { cause }) }),
    (trace) => Effect.scoped(Effect.suspend(() => {
      trace.event("job.start", { jobId });
      return work(trace);
    })),
    (trace, exit) => Effect.sync(() => { trace.event("job.end", Exit.isSuccess(exit) ? { _tag: "Success", value: exit.value } : { _tag: "Failure", cause: exit.cause }); trace.close(); }),
  );
