import type { Plugin } from "vite";

export declare const isReviewCommentApiRoute: (pathname: string) => boolean;
export declare const handleReviewCommentApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  postComment: (request: {
    engine: string;
    pr: number;
    findings: string;
    cwd: string | undefined;
  }) => Promise<unknown>;
  cwd: string | undefined;
}) => Promise<{ status: number; json: unknown } | null>;
export declare const reviewCommentApiPlugin: (options?: {
  postComment?: (request: {
    engine: string;
    pr: number;
    findings: string;
    cwd: string | undefined;
  }) => Promise<unknown>;
}) => Plugin;
