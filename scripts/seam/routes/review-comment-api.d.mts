import type { Plugin } from "vite";

// The poster's contract, as the handler exercises it: the enumerated
// request fields plus the host repo root, answered with the runner's
// `{ ok, result | status, error, ... }` outcome.
export declare type ReviewCommentPoster = (request: {
  engine: string;
  pr: number;
  findings: string;
  cwd: string | undefined;
}) => Promise<unknown>;

export declare const isReviewCommentApiRoute: (pathname: string) => boolean;
export declare const handleReviewCommentApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  postComment: ReviewCommentPoster;
  cwd: string | undefined;
}) => Promise<{ status: number; json: unknown } | null>;
export declare const reviewCommentApiPlugin: (options?: {
  postComment?: ReviewCommentPoster;
}) => Plugin;
