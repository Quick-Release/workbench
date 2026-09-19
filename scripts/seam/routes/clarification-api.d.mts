import type { Plugin } from "vite";

// The Owned-clarification posture: the typed state every clarification
// route gates on (spec #221, ticket #222). Values come from
// scripts/seam/clarification/posture.mjs.
export declare type ClarificationPosture =
  | { posture: "disabled"; available: false }
  | { posture: "invalid"; available: false; reasons: readonly string[] }
  | { posture: "enabled"; available: false };

type ApiResponse = { status: number; json: unknown } | null;

// The live-observation stream response part: an SSE stream with its
// detach — and deliberately no cancel, so a viewer hang-up can never
// cancel an attempt (spec #221, ADR 0020).
type StreamResponse = {
  status: number;
  contentType: "text/event-stream";
  stream: AsyncIterable<unknown>;
  detach: () => void;
};

type HandlerResponse = ApiResponse | StreamResponse;

type ObservationRequest = {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  query: URLSearchParams | undefined;
  coordinator: unknown;
};

export declare const isClarificationApiRoute: (pathname: string) => boolean;
export declare const statusResultFor: (posture: ClarificationPosture) => unknown;
export declare const handleClarificationStatus: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  posture: ClarificationPosture;
}) => ApiResponse;
export declare const handleClarificationManifest: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  query: URLSearchParams | undefined;
  posture: ClarificationPosture;
  coordinator: unknown;
}) => Promise<ApiResponse>;
export declare const handleClarificationStart: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  posture: ClarificationPosture;
  coordinator: unknown;
}) => Promise<ApiResponse>;
export declare const handleClarificationRun: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  query: URLSearchParams | undefined;
  posture: ClarificationPosture;
  coordinator: unknown;
}) => Promise<ApiResponse>;
export declare const handleClarificationConversationCommand: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  posture: ClarificationPosture;
  coordinator: unknown;
}) => Promise<ApiResponse>;
export declare const handleClarificationConversationState: (
  input: ObservationRequest,
) => ApiResponse;
export declare const handleClarificationDraft: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body: string | undefined;
  posture: ClarificationPosture;
  coordinator: unknown;
}) => Promise<ApiResponse>;
export declare const handleClarificationObservation: (input: ObservationRequest) => HandlerResponse;
export declare const handleClarificationEvents: (input: ObservationRequest) => HandlerResponse;
export declare const handleClarificationApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  body?: string | undefined;
  query?: URLSearchParams | undefined;
  posture?: ClarificationPosture | undefined;
  coordinator?: unknown;
}) => Promise<HandlerResponse>;
export declare const clarificationPostureLoader: (
  loadClarificationConfig: () => Promise<unknown>,
) => () => Promise<ClarificationPosture>;
export declare const clarificationApiPlugin: (options?: { coordinator?: unknown }) => Plugin;
