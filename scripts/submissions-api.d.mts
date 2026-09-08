import type { Plugin } from "vite";

export declare const isSubmissionsApiRoute: (pathname: string) => boolean;
export declare const submissionsWorkerClient: (
  env: Record<string, string | undefined>,
) => ((path: string, init?: RequestInit) => Promise<Response>) | null;
export declare const handleSubmissionsApi: (input: {
  method: string | undefined;
  pathname: string;
  body: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  repoRemote: string | undefined;
  workerFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
}) => Promise<{ status: number; json: unknown } | null>;
export declare const submissionsApiPlugin: (options?: { repoRemote?: string }) => Plugin;
