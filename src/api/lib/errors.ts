// Shared error contract for API routes (Spec 1 "never raw errors" rule).
// Every route throws AppError (or a helper below) instead of a bare Error;
// server.ts's global error handler catches AppError and renders
// `{ error: { code, message } }` at the right HTTP status — anything else
// (an unexpected thrown Error) is logged server-side and rendered as an
// opaque 500, never with the raw message/stack sent to the client.
import type { FailureClass } from "../../pipeline/extract/failures.js";
import { userFacingReasonFor } from "../../pipeline/extract/failures.js";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(resource: string): AppError {
  return new AppError(`${resource} not found.`, 404, "not_found");
}

export function badRequest(message: string): AppError {
  return new AppError(message, 400, "bad_request");
}

export function unauthorized(): AppError {
  return new AppError("Authentication required.", 401, "unauthorized");
}

/** Maps a pipeline FailureClass to the same plain-language, user-facing
 * string the CLI's failure card uses (Spec 1) — routes surfacing a failed
 * recipe should use this rather than inventing their own wording. */
export function failureClassMessage(failureClass: FailureClass, detail?: string): string {
  return userFacingReasonFor(failureClass, detail);
}
