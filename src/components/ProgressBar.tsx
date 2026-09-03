import { Progress } from "@/components/ui/progress";

/** The workbench skin for the vendored Progress track: square, thin, acid fill. */
export function ProgressBar({
  value,
  label,
}: Readonly<{ value: number; label?: string }>) {
  return (
    <Progress
      value={value}
      aria-label={label}
      className="mb-[7px] h-[5px] rounded-none bg-panel-hi"
    />
  );
}
