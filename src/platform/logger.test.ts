import { describe, expect, it } from "vitest";
import { __internal } from "./logger.js";

describe("log redaction", () => {
  it("redacts sensitive fields by name, case-insensitively, at any depth", () => {
    const input = {
      msg: "session restored",
      ANTHROPIC_API_KEY: "sk-ant-123",
      nested: {
        sessionState: "storage-state-blob",
        note: "safe to log",
      },
      list: [{ token: "abc" }, { name: "safe" }],
    };

    const redacted = __internal.redact(input) as Record<string, unknown>;

    expect(redacted.ANTHROPIC_API_KEY).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).sessionState).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).note).toBe("safe to log");
    expect(((redacted.list as unknown[])[0] as Record<string, unknown>).token).toBe("[REDACTED]");
    expect(((redacted.list as unknown[])[1] as Record<string, unknown>).name).toBe("safe");
  });

  it("does not choke on circular references", () => {
    const obj: Record<string, unknown> = { name: "safe" };
    obj.self = obj;
    expect(() => __internal.redact(obj)).not.toThrow();
  });
});
