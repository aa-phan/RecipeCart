// Shared confidence badge (Spec 1): icon + label + color, never color alone —
// colorblind users and screen readers must be able to tell levels apart
// without relying on hue. "amount_unclear" is its own visual treatment, not
// folded into "low".

export type ConfidenceLevel = "high" | "medium" | "low" | "amount_unclear";

interface ConfidenceMeta {
  icon: string;
  label: string;
  background: string;
  foreground: string;
}

const META: Record<ConfidenceLevel, ConfidenceMeta> = {
  high: { icon: "✓", label: "High confidence", background: "#e6f4ea", foreground: "#1e7e34" },
  medium: {
    icon: "◐",
    label: "Medium confidence",
    background: "#fff4e0",
    foreground: "#a15c00",
  },
  low: { icon: "!", label: "Low confidence", background: "#fdeaea", foreground: "#b3261e" },
  amount_unclear: {
    icon: "?",
    label: "Amount unclear",
    background: "#eee8fd",
    foreground: "#5b3ec4",
  },
};

export interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  className?: string;
}

export default function ConfidenceBadge({ level, className }: ConfidenceBadgeProps) {
  const meta = META[level];
  return (
    <span
      className={className}
      role="img"
      aria-label={meta.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35em",
        padding: "0.15em 0.6em",
        borderRadius: "999px",
        fontSize: "0.85em",
        fontWeight: 600,
        background: meta.background,
        color: meta.foreground,
      }}
    >
      <span aria-hidden="true">{meta.icon}</span>
      <span>{meta.label}</span>
    </span>
  );
}
