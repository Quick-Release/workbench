import type { Plugin } from "vite";

export declare const isLlmApiRoute: (pathname: string) => boolean;
export declare const ingestWorkerClient: (
  env: Record<string, string | undefined>,
) => ((path: string) => Promise<Response>) | null;
export declare const handleLlmApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  workerFetch: ((path: string) => Promise<Response>) | null;
}) => Promise<{ status: number; json: unknown } | null>;
export declare const llmApiPlugin: () => Plugin;
