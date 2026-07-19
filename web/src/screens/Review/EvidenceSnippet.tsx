import type { EvidenceRef } from "../../../../src/pipeline/schema.js";

export interface EvidenceSnippetProps {
  evidence: EvidenceRef[];
}

const SOURCE_LABELS: Record<string, string> = {
  ocr: "on-screen text",
  caption: "caption",
  asr: "spoken audio",
};

/** Renders the evidence trail behind one ingredient's extracted value — the
 * "why?" affordance's expanded content (Spec 1). Each EvidenceRef may carry a
 * source type, a timestamp, and/or a short text snippet; render whatever is
 * actually present rather than assuming every field is populated. */
export default function EvidenceSnippet({ evidence }: EvidenceSnippetProps) {
  if (evidence.length === 0) {
    return <p className="evidence-snippet evidence-snippet--empty">No evidence recorded for this ingredient.</p>;
  }

  return (
    <ul className="evidence-snippet">
      {evidence.map((item, index) => {
        const label = SOURCE_LABELS[item.source_type] ?? item.source_type;
        const timestamp =
          typeof item.timestamp === "number" ? formatTimestamp(item.timestamp) : null;
        return (
          <li key={index} className="evidence-snippet__item">
            <span className="evidence-snippet__source">
              {label}
              {timestamp ? ` @ ${timestamp}` : ""}
            </span>
            {item.snippet && <span className="evidence-snippet__text">&ldquo;{item.snippet}&rdquo;</span>}
          </li>
        );
      })}
    </ul>
  );
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}
