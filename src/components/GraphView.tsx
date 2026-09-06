// The GraphView seam (issue #43's decision): hand-rolled SVG styled with the
// shell's tokens, fed by pure layout modules. Rendering knows nothing about
// what it draws — nodes, edges, and region labels arrive positioned; the
// sanctioned @dagrejs/dagre swap-in lives behind the layout module, never
// inside a view.

export type GraphBox = { x: number; y: number; w: number; h: number };

export type GraphNodeDatum = {
  id: string;
  box: GraphBox;
  label: string;
  sublabel?: string;
  accent: string;
  region?: string;
  marked?: boolean;
  dimmed?: boolean;
  selected?: boolean;
  frontier?: boolean;
  broken?: boolean;
  title?: string;
  onSelect?: () => void;
};

// Two edge families share the seam: the flow graph's progression/internal
// pair and the blocker graph's gate grammar — open (solid amber), satisfied
// (dashed gray), broken (dashed red, a fail-closed reference).
export type GraphEdgeVariant =
  | "progression"
  | "internal"
  | "gate-open"
  | "gate-satisfied"
  | "gate-broken";

export type GraphEdgeDatum = {
  id: string;
  d: string;
  variant: GraphEdgeVariant;
  title?: string;
};

export type GraphLabelDatum = { x: number; y: number; text: string };

type GraphViewProps = {
  width: number;
  height: number;
  ariaLabel: string;
  labels: GraphLabelDatum[];
  edges: GraphEdgeDatum[];
  nodes: GraphNodeDatum[];
};

const ARROW_COLORS: ReadonlyArray<readonly [GraphEdgeVariant, string]> = [
  ["progression", "var(--white-dim)"],
  ["internal", "var(--faint)"],
  ["gate-open", "var(--amber)"],
  ["gate-satisfied", "var(--line-strong)"],
  ["gate-broken", "var(--coral)"],
];

const nodeClassName = (node: GraphNodeDatum) =>
  [
    "graph-node",
    node.dimmed ? "graph-node-dimmed" : "",
    node.selected ? "graph-node-selected" : "",
    node.frontier ? "graph-node-frontier" : "",
    node.broken ? "graph-node-broken" : "",
  ]
    .filter(Boolean)
    .join(" ");

export function GraphView({ width, height, ariaLabel, labels, edges, nodes }: GraphViewProps) {
  return (
    <svg
      className="graph-view"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        {ARROW_COLORS.map(([variant, color]) => (
          <marker
            key={variant}
            id={`graph-arrow-${variant}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
          </marker>
        ))}
      </defs>
      {labels.map((label) => (
        <text key={label.text} className="graph-region-label" x={label.x} y={label.y}>
          {label.text}
        </text>
      ))}
      <g>
        {edges.map((edge) => (
          <path
            key={edge.id}
            data-slot="graph-edge"
            data-from={edge.id.split("->")[0]}
            data-to={edge.id.split("->")[1]}
            className={`graph-edge graph-edge-${edge.variant}`}
            d={edge.d}
            markerEnd={`url(#graph-arrow-${edge.variant})`}
          >
            {edge.title ? <title>{edge.title}</title> : null}
          </path>
        ))}
      </g>
      <g>
        {nodes.map((node) => (
          <g
            key={node.id}
            data-slot="graph-node"
            data-id={node.id}
            data-region={node.region}
            data-frontier={node.frontier || undefined}
            className={nodeClassName(node)}
            onClick={node.onSelect}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") node.onSelect?.();
            }}
            tabIndex={0}
          >
            <title>{node.title}</title>
            <rect
              x={node.box.x}
              y={node.box.y}
              width={node.box.w}
              height={node.box.h}
              rx={8}
              stroke={node.accent}
            />
            {node.box.h > 48 ? (
              <>
                <text className="graph-node-label" x={node.box.x + 14} y={node.box.y + 25}>
                  {node.label}
                </text>
                {node.sublabel !== undefined ? (
                  <text className="graph-node-sub" x={node.box.x + 14} y={node.box.y + 41}>
                    {node.sublabel}
                  </text>
                ) : null}
              </>
            ) : (
              <>
                <text className="graph-node-label" x={node.box.x + 12} y={node.box.y + 16}>
                  {node.label}
                </text>
                {node.sublabel !== undefined ? (
                  <text className="graph-node-sub" x={node.box.x + 12} y={node.box.y + 29}>
                    {node.sublabel}
                  </text>
                ) : null}
              </>
            )}
            {node.marked ? (
              <circle
                className="graph-node-dot"
                cx={node.box.x + node.box.w - 11}
                cy={node.box.y + 11}
                r={3.5}
              />
            ) : null}
          </g>
        ))}
      </g>
    </svg>
  );
}
