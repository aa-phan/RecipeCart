import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDelete } from "../../api/client";
import "./Privacy.css";

export default function Privacy() {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  const handleDeleteAll = async () => {
    const confirmed = window.confirm(
      "This will permanently delete all your recipes, ingredients, product matches, and cart history. This cannot be undone. Continue?",
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    try {
      await apiDelete("/api/account/data");
      setDeleted(true);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete data");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="privacy">
      <h1>Privacy</h1>

      <p>
        RecipeCart stores your submitted recipes, extracted ingredients,
        product matches, and cart results so you can review your history.
        Your Kroger connection token is encrypted at rest.
      </p>
      <p>
        You can delete an individual recipe (and its associated data) at any
        time from the recipes list. Use the button below to delete
        everything at once.
      </p>

      {error && (
        <p className="privacy__error" role="alert">
          {error}
        </p>
      )}

      {deleted && (
        <p className="privacy__success" role="status">
          Your data has been deleted.
        </p>
      )}

      <button
        type="button"
        onClick={handleDeleteAll}
        disabled={deleting}
        className="privacy__delete"
      >
        {deleting ? "Deleting…" : "Delete all my data"}
      </button>
    </main>
  );
}
