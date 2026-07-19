import { useEffect, useRef, useState } from "react";

export interface UsePollingOptions {
  /** Poll interval (ms) while the page is visible and `active` is true. Default 3000. */
  activeMs?: number;
  /** Poll interval (ms) while the page is visible but `active` is false. Default 15000. */
  idleMs?: number;
  /** Whether polling should use the faster `activeMs` cadence. Default true. */
  active?: boolean;
}

export interface UsePollingResult {
  /** True whenever a poll tick is scheduled to run (i.e. the page is visible). */
  isPolling: boolean;
}

/**
 * Polls `fn` on an interval that adapts to page visibility and an
 * caller-supplied `active` flag:
 *  - visible + active:   every `activeMs` (default 3000)
 *  - visible + !active:  every `idleMs` (default 15000)
 *  - hidden (any state): paused entirely, resumes on becoming visible
 *
 * Drop-in for screens that need to re-poll a job/recipe status, e.g.:
 *   const { isPolling } = usePolling(() => refetch(), { active: status !== "completed" });
 */
export function usePolling(fn: () => void, opts: UsePollingOptions = {}): UsePollingResult {
  const { activeMs = 3000, idleMs = 15000, active = true } = opts;
  const [isPolling, setIsPolling] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );

  // Keep the latest fn/active without re-triggering the interval effect.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (document.visibilityState !== "visible") {
        setIsPolling(false);
        return;
      }
      setIsPolling(true);
      const delay = activeRef.current ? activeMs : idleMs;
      timer = setTimeout(() => {
        fnRef.current();
        scheduleNext();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (document.visibilityState === "visible") {
        scheduleNext();
      } else {
        setIsPolling(false);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleNext();

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMs, idleMs]);

  return { isPolling };
}
