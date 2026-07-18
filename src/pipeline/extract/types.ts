// Shared job-context shape (Spec 2 §2.1). Every stage takes this same shape
// rather than loose positional args so a P3 worker can wrap the identical
// stage functions without a signature refactor.
export interface JobContext {
  jobId: string;
  jobDir: string;
  sourceUrl: string;
}
