// Structured logging with field-name redaction (Spec 4 §2.1).
// "The one piece of platform built properly even in P1" — cheap now, painful
// to retrofit. Redaction happens at the logging layer by field NAME, not per
// call site, so no log call anywhere in the codebase can leak a secret by
// forgetting to redact it manually.

const REDACTED = "[REDACTED]";

// Field names (case-insensitive, substring match) that are always redacted
// wherever they appear in a logged object, however deeply nested.
const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /session[_-]?state/i,
  /storage[_-]?state/i,
  /authorization/i,
  /cookie/i,
  /hebsessionkey/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(val, seen);
    }
    return out;
  }

  return value;
}

type LogFields = Record<string, unknown>;

interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  timestamp: string;
  [key: string]: unknown;
}

function emit(level: LogEvent["level"], msg: string, fields?: LogFields): void {
  const event: LogEvent = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...((redact(fields ?? {}) as LogFields) ?? {}),
  };
  const line = JSON.stringify(event);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

// Exported for the P1 verification step ("grep the log output for the
// token") and for unit tests — lets us assert redaction works without
// depending on the emit/transport plumbing above.
export const __internal = { redact, isSensitiveKey };
