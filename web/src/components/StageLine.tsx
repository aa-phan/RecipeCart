import { stageLineFor } from "../lib/stageLines";

export interface StageLineProps {
  status: string | undefined;
  itemCount?: number;
  className?: string;
}

/** Renders the plain-language line for a job status (see lib/stageLines.ts). */
export default function StageLine({ status, itemCount, className }: StageLineProps) {
  return <p className={className}>{stageLineFor(status, itemCount)}</p>;
}
