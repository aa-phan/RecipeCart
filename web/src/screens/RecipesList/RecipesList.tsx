import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../../api/client";
import type { AccountDto, RecipeListItemDto, SubmitRecipeResponse } from "../../api/types";
import { usePolling } from "../../hooks/usePolling";
import RecipeCard from "./RecipeCard";
import "./RecipesList.css";

// Statuses that mean "nothing more will happen without user/system action" —
// used to decide whether polling should run at the fast (active) cadence.
const TERMINAL_STATUSES = new Set([
  "completed",
  "partially_completed",
  "failed",
  "expired",
]);

// Cart-terminal statuses only (see src/kroger/cart_runner.ts's CartRunStatus)
// — a real cart run finished, successfully or partially. These are the
// "Done" / auto-archived recipes: nothing server-side changes, they're just
// grouped out of the main view client-side so they don't clutter it, while
// staying visible and linkable from the Done section. `failed` is NOT
// included here — a failed job stays in the main list with its existing
// FailureCard-linked treatment, since it never reached a cart outcome.
const CART_DONE_STATUSES = new Set(["completed", "partially_completed"]);

// Interim substitute for the iOS Shortcut (Phase 4) — Spec 4's Phase 3 exit
// criteria explicitly allows "curl or a simple form" for submission, so this
// form is spec-sanctioned, not a permanent product surface.
export default function RecipesList() {
  const navigate = useNavigate();
  const [recipes, setRecipes] = useState<RecipeListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  // Set only when a submission comes back as a duplicate (`created: false`)
  // — carries the existing job's id so we can offer "view existing" /
  // "reprocess" actions alongside the note. Cleared on the next submit.
  const [duplicateJob, setDuplicateJob] = useState<{ jobId: string } | null>(
    null,
  );
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);

  // Onboarding status (multi-tenancy Slice 3, 2026-07-22 — closes the "new
  // sign-ins aren't prompted to connect Kroger or set a store" gap). This
  // is the landing screen right after sign-in, so it's the natural place
  // for the nudge. Store is hard-blocking (submitting with none configured
  // guarantees the job fails outright — worker/state_machine.ts has no
  // recipe row yet to attach a friendly FailureCard to at that point, so
  // preventing the submission here is the real fix, not a nicer error
  // message after the fact). Kroger is a soft nudge only — cart-approval
  // already degrades gracefully with its own FailureCard when missing.
  const [account, setAccount] = useState<AccountDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<AccountDto>("/api/account");
        if (!cancelled) setAccount(data);
      } catch {
        // Non-critical — if this fails, the onboarding banner just doesn't
        // show; submission still works normally (the worker's own
        // no-store failure is the fallback safety net either way).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchRecipes = useCallback(async () => {
    try {
      const data = await apiGet<RecipeListItemDto[]>("/api/recipes");
      setRecipes(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recipes");
    }
  }, []);

  useEffect(() => {
    fetchRecipes();
  }, [fetchRecipes]);

  const hasActiveJob = (recipes ?? []).some(
    (item) => !TERMINAL_STATUSES.has(item.status),
  );

  const activeRecipes = (recipes ?? []).filter(
    (item) => !CART_DONE_STATUSES.has(item.status),
  );
  const doneRecipes = (recipes ?? []).filter((item) =>
    CART_DONE_STATUSES.has(item.status),
  );

  usePolling(fetchRecipes, { active: hasActiveJob });

  const handleDeleted = useCallback(
    (id: string) => {
      setRecipes((prev) => (prev ? prev.filter((item) => item.id !== id) : prev));
      // Re-sync with the server in the background in case anything else
      // changed (e.g. dedup window state).
      fetchRecipes();
    },
    [fetchRecipes],
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchRecipes();
    setIsRefreshing(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = sourceUrl.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNote(null);
    setDuplicateJob(null);
    setReprocessError(null);
    try {
      const result = await apiPost<SubmitRecipeResponse>("/api/recipes", {
        sourceUrl: trimmed,
      });
      setSourceUrl("");
      setSubmitNote(
        result.created
          ? "Submitted — it'll appear below as it processes."
          : "Already submitted recently — showing its current status below.",
      );
      if (!result.created) {
        setDuplicateJob({ jobId: result.jobId });
      }
      await fetchRecipes();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : "Couldn't submit that URL.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleReprocess = async () => {
    if (!duplicateJob) return;
    setReprocessing(true);
    setReprocessError(null);
    try {
      const response = await apiPost<SubmitRecipeResponse>(
        `/api/recipes/${duplicateJob.jobId}/reprocess`,
      );
      navigate(`/recipes/${response.jobId}`);
    } catch {
      setReprocessError("Couldn't restart processing. Please try again.");
      setReprocessing(false);
    }
  };

  const storeMissing = account !== null && !account.hasStoreLocation;
  const krogerMissing = account !== null && !account.krogerConnected;

  return (
    <main className="recipes-list">
      <header className="recipes-list__header">
        <h1>Your recipes</h1>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="recipes-list__refresh"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {(storeMissing || krogerMissing) && (
        <div className="recipes-list__onboarding" role="status">
          <p className="recipes-list__onboarding-heading">Finish setting up your account</p>
          <ul className="recipes-list__onboarding-list">
            {storeMissing && (
              <li>
                <Link to="/preferences">Set your store</Link> — recipes can't be matched
                to products until this is done.
              </li>
            )}
            {krogerMissing && (
              <li>
                <Link to="/connect-kroger">Connect Kroger</Link> — needed before you can add
                anything to a real cart.
              </li>
            )}
          </ul>
        </div>
      )}

      <form className="recipes-list__submit" onSubmit={handleSubmit}>
        <label htmlFor="submit-url" className="visually-hidden">
          TikTok recipe URL
        </label>
        <input
          id="submit-url"
          type="url"
          inputMode="url"
          placeholder="Paste a TikTok recipe URL…"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          disabled={submitting || storeMissing}
        />
        <button
          type="submit"
          disabled={submitting || storeMissing || sourceUrl.trim().length === 0}
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </form>
      {storeMissing && (
        <p className="recipes-list__onboarding-hint">
          <Link to="/preferences">Set your store</Link> before submitting a recipe —
          without one, processing fails immediately.
        </p>
      )}
      {submitNote && (
        <p className="recipes-list__submit-note" role="status">
          {submitNote}
        </p>
      )}
      {duplicateJob && (
        <div className="recipes-list__duplicate-actions">
          <Link
            to={`/recipes/${duplicateJob.jobId}`}
            className="recipes-list__duplicate-link"
          >
            View existing
          </Link>
          <button
            type="button"
            onClick={handleReprocess}
            disabled={reprocessing}
            className="recipes-list__duplicate-reprocess"
          >
            {reprocessing ? "Reprocessing…" : "Reprocess"}
          </button>
        </div>
      )}
      {reprocessError && (
        <p className="recipes-list__submit-error" role="alert">
          {reprocessError}
        </p>
      )}
      {submitError && (
        <p className="recipes-list__submit-error" role="alert">
          {submitError}
        </p>
      )}

      {error && (
        <p className="recipes-list__error" role="alert">
          Couldn't load recipes: {error}
        </p>
      )}

      {recipes === null && !error && (
        <p className="recipes-list__loading">Loading recipes…</p>
      )}

      {recipes !== null && recipes.length === 0 && (
        <p className="recipes-list__empty">
          No recipes yet — submit one to get started.
        </p>
      )}

      {recipes !== null && recipes.length > 0 && (
        <>
          <ul className="recipes-list__items">
            {activeRecipes.map((item) => (
              <RecipeCard key={item.id} item={item} onDeleted={handleDeleted} />
            ))}
          </ul>

          {doneRecipes.length > 0 && (
            <details className="recipes-list__done" open={activeRecipes.length === 0}>
              <summary className="recipes-list__done-summary">
                Done ({doneRecipes.length})
              </summary>
              <ul className="recipes-list__items recipes-list__items--done">
                {doneRecipes.map((item) => (
                  <RecipeCard key={item.id} item={item} onDeleted={handleDeleted} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </main>
  );
}
