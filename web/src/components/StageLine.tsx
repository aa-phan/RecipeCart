import { stageLineFor } from "../lib/stageLines";
import "./StageLine.css";

export interface StageLineProps {
  status: string | undefined;
  itemCount?: number;
  className?: string;
}

/** Renders the plain-language line for a job status (see lib/stageLines.ts). */
export default function StageLine({ status, itemCount, className }: StageLineProps) {
  const classes = ["stage-line", className].filter(Boolean).join(" ");
  return <p className={classes}>{stageLineFor(status, itemCount)}</p>;
}
