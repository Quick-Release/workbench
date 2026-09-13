import type { Plugin } from "vite";

type ApiResponse = { status: number; json: unknown } | null;
type CatalogEntry = { id: string; [key: string]: unknown };
type SkillStatus = (
  rootDirectory: string,
  catalog?: readonly CatalogEntry[],
) => Promise<unknown> | unknown;
type SkillInstall = (rootDirectory: string, id: string) => Promise<string> | string;
type SkillSetup = (rootDirectory: string) => Promise<string> | string;

export declare const isSkillsApiRoute: (pathname: string) => boolean;
export declare const handleSkillsApi: (input: {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  rootDirectory: string;
  catalog?: readonly CatalogEntry[];
  catalogAvailable?: boolean;
  getStatus?: SkillStatus;
  install?: SkillInstall;
  installAll?: SkillSetup;
}) => Promise<ApiResponse>;
export declare const skillsApiPlugin: (options?: {
  getStatus?: SkillStatus;
  install?: SkillInstall;
  installAll?: SkillSetup;
}) => Plugin;
