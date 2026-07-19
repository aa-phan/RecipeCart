import { useSearchParams } from "react-router-dom";

// Spec 1: shown when a job is in `requires_user_intervention` state due to a
// missing/expired Kroger token. This screen is a standalone entry point —
// a Review or FailureCard screen would typically deep-link here.
//
// The connect link is a plain `<a>` doing a full browser navigation (NOT a
// fetch/XHR): OAuth redirects need the browser itself to follow Kroger's
// redirect chain to /api/kroger/auth/start -> Kroger's consent page ->
// /api/kroger/auth/callback. That callback route (owned by a different
// subagent) is responsible for handling the return trip.
export default function ConnectKroger() {
  const [searchParams] = useSearchParams();
  const resumeRecipeId = searchParams.get("resumeRecipeId");

  // The OAuth round-trip navigates away from and back to the browser, so any
  // React state would be lost. sessionStorage survives same-tab navigation,
  // letting a future callback-landing page read this back to resume the
  // right recipe.
  if (resumeRecipeId) {
    sessionStorage.setItem("krogerConnectResumeRecipeId", resumeRecipeId);
  }

  return (
    <div style={{ maxWidth: 480, margin: "4rem auto", textAlign: "center" }}>
      <p style={{ fontSize: "1.1rem", marginBottom: "1.5rem" }}>
        Connect your Kroger account to add items to your cart.
      </p>
      <a
        href="/api/kroger/auth/start"
        style={{
          display: "inline-block",
          padding: "0.75rem 1.5rem",
          fontSize: "1rem",
          fontWeight: 600,
          textDecoration: "none",
          border: "1px solid currentColor",
          borderRadius: 4,
        }}
      >
        Connect Kroger
      </a>
    </div>
  );
}
