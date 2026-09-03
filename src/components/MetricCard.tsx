import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const valueTones = {
  neutral: "text-ink",
  good: "text-good",
  warn: "text-warn",
  hot: "text-hot",
  info: "text-info",
} as const;

export function MetricCard({
  value,
  label,
  tone = "neutral",
  detail,
}: Readonly<{
  value: string | number;
  label: string;
  tone?: keyof typeof valueTones;
  detail?: string;
}>) {
  return (
    <Card className="min-h-[135px] gap-0 rounded-none border-line bg-gradient-to-br from-panel-hi/93 to-panel/93 p-[17px] shadow-panel max-[780px]:min-h-[115px] max-[780px]:p-[13px]">
      <strong
        className={cn(
          "mb-3 block font-mono text-[clamp(1.9rem,3.8vw,3.1rem)] font-bold leading-none tracking-[-0.11em] max-[780px]:mb-2",
          valueTones[tone],
        )}
      >
        {value}
      </strong>
      <span className="block max-w-[130px] text-[0.76rem] leading-[1.3] text-muted-foreground">
        {label}
      </span>
      {detail && <small className="mt-[7px] block text-[0.65rem] text-faint">{detail}</small>}
    </Card>
  );
}
