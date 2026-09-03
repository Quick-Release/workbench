import * as React from "react";

import { cn } from "@/lib/utils";

function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "w-full min-h-[42px] rounded-none border border-line-strong bg-field px-[11px] py-2 text-base text-foreground outline-none transition-[color,box-shadow] placeholder:text-faint focus-visible:border-acid focus-visible:ring-[3px] focus-visible:ring-acid/15 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { NativeSelect };
