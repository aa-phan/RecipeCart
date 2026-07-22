import { useSearchParams } from "react-router-dom";
import "./Login.css";

// Sign-in screen (multi-tenancy Slice 1, 2026-07-21) — replaces the old
// unauthenticated "generate a device token" front door
// (screens/Setup/Setup.tsx) that was the original open-mint vulnerability.
// AuthGate now sends any genuinely unauthenticated visitor here instead of
// /setup; /setup is authenticated-only from here on (adding an ADDITIONAL
// device, e.g. the iOS Shortcut, once already signed in).
//
// The Google button is a plain `<a>` doing a full browser navigation (NOT a
// fetch/XHR) — same reasoning as ConnectKroger.tsx: OAuth redirects need
// the browser itself to follow Google's redirect chain to
// /api/auth/google/start -> Google's consent page ->
// /api/auth/google/callback, which redirects back here with `?error=...`
// on failure or to `/?loggedIn=true` on success (that landing needs no
// special handling — the callback already set the auth cookie, so the app
// just renders normally once AuthGate re-checks).
const ERROR_COPY: Record<string, string> = {
  denied: "You declined Google's sign-in request. Sign in to continue.",
  invalid_request: "That sign-in link expired or was already used. Try again.",
  exchange_failed: "Something went wrong finishing sign-in with Google. Please try again.",
  email_unverified: "Your Google account's email isn't verified. Sign in with a verified account.",
  not_invited:
    "This Google account isn't invited to RecipeCart yet. Ask whoever set this up to add your email.",
};

export default function Login() {
  const [searchParams] = useSearchParams();
  const errorParam = searchParams.get("error");
  const errorMessage = errorParam
    ? (ERROR_COPY[errorParam] ?? "Couldn't sign in. Please try again.")
    : undefined;

  return (
    <div className="login">
      <p className="login__message">Sign in to RecipeCart</p>
      {errorMessage && (
        <p className="login__error" role="alert">
          {errorMessage}
        </p>
      )}
      <a href="/api/auth/google/start" className="login__action">
        Sign in with Google
      </a>
    </div>
  );
}
