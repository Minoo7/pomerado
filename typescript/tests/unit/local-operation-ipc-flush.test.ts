import { Buffer } from "node:buffer";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

const entrypoint = "src/tool.mjs";
const block = "0123456789abcdef";
const paths = ["direct", "browser"] satisfies ("direct" | "browser")[];
const source = (body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  { input: Schema.Struct({}), output: Schema.String },
  async ({ kernel, sessionId }) => { ${body} },
);`;

describe.each(paths)("local operation IPC flush through %s return", (path) => {
  describe.each([false, true])("diagnostics enabled %s", (enabled) => {
    it.each([16, 512 * 1024])("returns all %i bytes before disconnecting", async (bytes) => {
      const expected = block.repeat(bytes / block.length);
      const events: string[] = [];
      let browserCalls = 0;
      const body = path === "direct"
        ? `return "${block}".repeat(${bytes / block.length});`
        : 'return (await kernel.browsers.playwright.execute(sessionId, { code: "return syntheticResult();" })).result;';
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* createLocalWorkspace();
            return yield* runLocalOperation({
              workspace,
              entrypoint,
              sources: [[entrypoint, source(body)]],
              input: {},
              timeoutMs: 6_000,
              ...(path === "direct"
                ? { target: "pureFiles" }
                : {
                    browser: {
                      sessionId: "synthetic-session",
                      executeResponse: (code: string) => {
                        browserCalls++;
                        expect(code).toBe("return syntheticResult();");
                        return Effect.succeed({ success: true, result: expected });
                      },
                    },
                  }),
              ...(enabled ? { diagnostic: (kind: string) => events.push(kind) } : {}),
            });
          }),
        ),
      );
      expect(result.output).toBe(expected);
      if (typeof result.output !== "string") throw new Error("Expected a string result");
      expect(Buffer.byteLength(result.output, "utf8")).toBe(bytes);
      expect(browserCalls).toBe(path === "browser" ? 1 : 0);
      expect(events).toEqual(enabled ? ["operation.result", "operation.process"] : []);
    }, 15_000);
  });
});

describe("local operation IPC send failures", () => {
  it.each([
    {
      name: "a synchronous send throw",
      body: `const original = process.send;
process.send = () => {
  process.send = original;
  throw Object.assign(new Error("synthetic IPC failure"), { code: "SYNTHETIC_IPC_FAILURE" });
};
return "synthetic result";`,
      message: "synthetic IPC failure",
      code: "SYNTHETIC_IPC_FAILURE",
    },
    {
      name: "an asynchronous send callback failure",
      body: `const original = process.send;
process.send = (_message, callback) => {
  process.send = original;
  queueMicrotask(() => callback(Object.assign(new Error("synthetic IPC failure"), { code: "SYNTHETIC_IPC_FAILURE" })));
  return false;
};
return "synthetic result";`,
      message: "synthetic IPC failure",
      code: "SYNTHETIC_IPC_FAILURE",
    },
    {
      name: "a result exceeding the IPC limit",
      body: 'return "x".repeat(1024 * 1024);',
      message: "Local operation IPC exceeds output limit",
      code: undefined,
    },
  ])("reports $name through the operation error channel", async ({ body, message, code }) => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, source(body)]],
            input: {},
            target: "pureFiles",
            timeoutMs: 6_000,
          }).pipe(Effect.either);
        }),
      ),
    );
    if (result._tag === "Right") throw new Error("Expected an IPC send failure");
    expect(result.left).toBeInstanceOf(LocalOperationFailure);
    expect(result.left).toMatchObject({ message, code, reported: true });
  }, 15_000);

  it("handles a late send callback failure after a browser call is interrupted", async () => {
    const body = `const stop = new AbortController();
const original = process.send;
process.send = (message, callback) => {
  if (message.kind !== "execute") return original.call(process, message, callback);
  return original.call(process, message, () => {
    stop.abort();
    queueMicrotask(() => callback(new Error("synthetic late send failure")));
  });
};
try {
  await kernel.browsers.playwright.execute(sessionId, { code: "return syntheticPendingResult();" }, { signal: stop.signal });
  return "unexpected browser result";
} catch {
  return "interrupted browser call";
}`;
    let browserCalls = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, source(body)]],
            input: {},
            browser: {
              sessionId: "synthetic-session",
              executeResponse: () => {
                browserCalls++;
                return Effect.never;
              },
            },
            timeoutMs: 6_000,
          });
        }),
      ),
    );
    expect(result.output).toBe("interrupted browser call");
    expect(browserCalls).toBe(1);
    expect(result.stderr).not.toContain("synthetic late send failure");
    expect(result.stderr).not.toContain("Unhandled");
  }, 15_000);
});
