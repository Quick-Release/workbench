import type { Plugin } from "vite";

type ApiResponse = { status: number; json: unknown } | null;
type ToolStatus = (rootDirectory: string) => Promise<unknown> | unknown;
type ToolSetup = (rootDirectory: string, id: string) => Promise<string> | string;

export declare const isToolsApiRoute: (pathname: string) => boolean;
export declare const handleToolsApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  rootDirectory: string;
  getStatus?: ToolStatus;
  setupTool?: ToolSetup;
}) => Promise<ApiResponse>;
export declare const toolsApiPlugin: (options?: {
  getStatus?: ToolStatus;
  setupTool?: ToolSetup;
}) => Plugin;
