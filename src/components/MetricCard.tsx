export function MetricCard({
  value,
  label,
  tone = "neutral",
  detail,
}: Readonly<{
  value: string | number;
  label: string;
  tone?: "neutral" | "good" | "warn" | "hot" | "info";
  detail?: string;
}>) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </article>
  );
}
