// Shared confidence badge (Spec 1): icon + label + color, never color alone —
// colorblind users and screen readers must be able to tell levels apart
// without relying on hue. "amount_unclear" is its own visual treatment, not
// folded into "low".
import "./ConfidenceBadge.css";

export type ConfidenceLevel = "high" | "medium" | "low" | "amount_unclear";

interface ConfidenceMeta {
  icon: string;
  label: string;
  modifier: string;
}

const META: Record<ConfidenceLevel, ConfidenceMeta> = {
  high: { icon: "✓", label: "High confidence", modifier: "high" },
  medium: { icon: "◐", label: "Medium confidence", modifier: "medium" },
  low: { icon: "!", label: "Low confidence", modifier: "low" },
  amount_unclear: { icon: "?", label: "Amount unclear", modifier: "amount-unclear" },
};

export interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  className?: string;
}

export default function ConfidenceBadge({ level, className }: ConfidenceBadgeProps) {
  const meta = META[level];
  const classes = ["confidence-badge", `confidence-badge--${meta.modifier}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} role="img" aria-label={meta.label}>
      <span className="confidence-badge__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <span>{meta.label}</span>
    </span>
  );
}
