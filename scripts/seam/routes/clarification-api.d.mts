import type { Plugin } from "vite";

// The Owned-clarification posture: the typed state every clarification
// route gates on (spec #221, ticket #222). Values come from
// scripts/seam/clarification/posture.mjs.
export declare type ClarificationPosture =
  | { posture: "disabled"; available: false }
  | { posture: "invalid"; available: false; reasons: readonly string[] }
  | { posture: "enabled"; available: false };

type ApiResponse = { status: number; json: unknown } | null;

export declare const isClarificationApiRoute: (pathname: string) => boolean;
export declare const statusResultFor: (posture: ClarificationPosture) => unknown;
export declare const handleClarificationStatus: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  posture: ClarificationPosture;
}) => ApiResponse;
export declare const handleClarificationStart: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  posture: ClarificationPosture;
}) => ApiResponse;
export declare const handleClarificationApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body?: string | undefined;
  posture: ClarificationPosture;
}) => Promise<ApiResponse>;
export declare const clarificationPostureLoader: (
  loadClarificationConfig: () => Promise<unknown>,
) => () => Promise<ClarificationPosture>;
export declare const clarificationApiPlugin: () => Plugin;
