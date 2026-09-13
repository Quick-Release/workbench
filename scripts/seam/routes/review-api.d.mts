import type { Plugin } from "vite";

export declare const isReviewApiRoute: (pathname: string) => boolean;
export declare const handleReviewApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  probeHealth: () => Promise<unknown> | unknown;
}) => Promise<{ status: number; json: unknown } | null>;
export declare const reviewApiPlugin: (options?: {
  probeHealth?: () => Promise<unknown> | unknown;
}) => Plugin;
