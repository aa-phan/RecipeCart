import "./ProgressBar.css";

export interface ProgressBarProps {
  /** 0-1 completion fraction. */
  progress: number;
  className?: string;
}

/** A thin determinate progress bar for job-stage progress (see
 * lib/stageLines.ts's stageProgress()). */
export default function ProgressBar({ progress, className }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const classes = ["progress-bar", className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
