import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared chrome for the TanStack-backed tables so the ticket and plan tables
 * stay one edit apart. Classes that used to live in `.signal-table` CSS.
 */
export const sortableHeadClass =
  "sticky top-0 z-[2] h-auto bg-panel-hi/97 px-[15px] py-3.5 align-top font-mono text-[0.64rem] font-normal tracking-[0.08em] uppercase text-faint";

export const sortableBodyRowClass = "hover:bg-acid/3";

export const sortableBodyCellClass =
  "border-b-0 px-[15px] py-3.5 align-top whitespace-normal";

export const tableEmptyCellClass = "p-[35px] text-center text-muted-foreground";

export function SortButton({
  sorted,
  onClick,
  children,
}: Readonly<{
  sorted: false | "asc" | "desc";
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 border-0 bg-none p-0 text-left hover:text-acid focus-visible:text-acid",
        sorted && "text-acid",
      )}
      onClick={onClick}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn("text-[0.5rem]", sorted ? "opacity-100" : "opacity-40")}
      >
        {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
      </span>
    </button>
  );
}
