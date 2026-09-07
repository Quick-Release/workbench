import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import * as p from "@clack/prompts";

import { loadWorkbenchConfig } from "./config.mjs";

const execFileAsync = promisify(execFile);

const NON_INTERACTIVE_RECIPE = [
  "Non-interactive environment detected: skipping workbench init.",
  "",
  "Instead, either:",
  "  1. Re-run `workbench init` inside a terminal, or",
  "  2. Copy workbench.config.example.json from the installed @quick-release/workbench",
  "     package to workbench.config.json and edit it by hand.",
  "",
  "Runtime options are environment-driven and need no config:",
  "  WORKBENCH_SOURCE_ROOT  directory to serve (default: cwd)",
  "  WORKBENCH_PORT         dev server port (default: 4051)",
  "",
].join("\n");

// The environments clack must never prompt in: stdin alone is not enough —
// automation (CI=true, hosted CI variables) attaches a TTY-less or unmanned stdin.
const isCiEnvironment = () => {
  const ci = String(process.env.CI ?? "").toLowerCase();
  return (
    ci === "true" ||
    ci === "1" ||
    Boolean(
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.CIRCLECI ||
      process.env.BUILD_NUMBER,
    )
  );
};

// Prompt-level schemas give instant feedback. They mirror (never replace) the
// config loader, which stays the single authority via the staging gate below.
const requiredText = (message, max = 200) =>
  z.string().trim().min(1, message).max(max, `Keep this under ${max} characters`);

const projectNameSchema = requiredText("A project name is required", 100);

const repositoryUrlSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (value.length === 0)
      return ctx.addIssue({ code: "custom", message: "A repository URL is required" });
    if (value.length > 500)
      return ctx.addIssue({ code: "custom", message: "Keep the URL under 500 characters" });
    let url;
    try {
      url = new URL(value);
    } catch {
      return ctx.addIssue({ code: "custom", message: "Repository must be an http(s) URL" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return ctx.addIssue({ code: "custom", message: "Repository must be an http(s) URL" });
    if (url.username || url.password || url.hash)
      ctx.addIssue({
        code: "custom",
        message: "Repository URL cannot contain credentials or a fragment",
      });
  });

const tokenEnvSchema = requiredText("A token environment variable name is required", 80).regex(
  /^[A-Z][A-Z0-9_]*$/,
  "Use an environment variable name like GITHUB_TOKEN",
);

const githubRepoSchema = requiredText("A repository is required", 300).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  "Use owner/name format",
);

const gitlabProjectIdSchema = requiredText("A project ID is required", 40).regex(
  /^\d+$/,
  "GitLab project ID must be numeric",
);

const gitlabProjectPathSchema = requiredText("A project path is required", 300).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/,
  "Use group/project format",
);

const genericIdSchema = (label) => requiredText(`${label} is required`);

const SERVICE_TYPES = ["github", "gitlab", "asana", "notion"];

const TOKEN_ENV_PLACEHOLDER = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  asana: "ASANA_TOKEN",
  notion: "NOTION_TOKEN",
};

// git remote get-url origin, translated to the http(s) form the config wants.
const inferOriginUrl = async (rootDirectory) => {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: rootDirectory,
    });
    const url = stdout.trim();
    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
    if (/^https?:\/\//.test(url)) return url.replace(/\.git$/, "");
    return undefined;
  } catch {
    return undefined;
  }
};

const inferGithubRepo = (repositoryUrl) => {
  if (!repositoryUrl) return undefined;
  const match = repositoryUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
};

// The single seam for the interactive init flow. Everything observable happens
// through these parameters: streams carry prompts and output, rootDirectory is
// where workbench.config.json is written, and interactive gates prompting.
export const runInit = async ({
  rootDirectory = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  interactive = Boolean(process.stdin.isTTY) && !isCiEnvironment(),
} = {}) => {
  if (!interactive) {
    output.write(`${NON_INTERACTIVE_RECIPE}\n`);
    return { status: "blocked" };
  }

  const streams = { input, output };
  const checkCancel = (value) => {
    if (!p.isCancel(value)) return null;
    p.cancel("No changes written.", streams);
    return { status: "cancelled" };
  };

  p.intro("workbench init", streams);

  const configPath = join(rootDirectory, "workbench.config.json");
  const hasExisting = await stat(configPath).then(
    () => true,
    () => false,
  );
  let existing;
  if (hasExisting) {
    try {
      existing = await loadWorkbenchConfig(rootDirectory);
    } catch {
      existing = undefined;
    }
  }

  if (hasExisting) {
    const overwrite = await p.confirm({
      message: `${configPath} already exists. Overwrite?`,
      initialValue: false,
      ...streams,
    });
    const stop = checkCancel(overwrite);
    if (stop) return stop;
    if (!overwrite) {
      p.cancel("No changes written.", streams);
      return { status: "cancelled" };
    }
  }

  const projectName = await p.text({
    message: "Project name",
    initialValue: existing?.projectName ?? basename(rootDirectory),
    validate: projectNameSchema,
    ...streams,
  });
  const projectStop = checkCancel(projectName);
  if (projectStop) return projectStop;

  const originUrl = await inferOriginUrl(rootDirectory);
  const repositoryUrl = await p.text({
    message: "Repository URL",
    initialValue: existing?.repositoryUrl ?? originUrl,
    placeholder: "https://github.com/owner/repo",
    validate: repositoryUrlSchema,
    ...streams,
  });
  const repositoryStop = checkCancel(repositoryUrl);
  if (repositoryStop) return repositoryStop;

  const priorServices = existing?.services ?? [];
  const selectedTypes = await p.multiselect({
    message: "Which services should pull data into the overview?",
    options: SERVICE_TYPES.map((type) => ({ value: type, label: type })),
    initialValues: [...new Set(priorServices.map((service) => service.type))].filter((type) =>
      SERVICE_TYPES.includes(type),
    ),
    required: false,
    ...streams,
  });
  const selectionStop = checkCancel(selectedTypes);
  if (selectionStop) return selectionStop;

  const takenIds = new Set(priorServices.map((service) => service.id));
  const nextId = (type) => {
    let candidate = type;
    for (let n = 2; takenIds.has(candidate); n += 1) candidate = `${type}-${n}`;
    takenIds.add(candidate);
    return candidate;
  };

  // Existing same-type services are offered as defaults, first-in first-out;
  // a re-run tweaks values instead of re-entering them and keeps stable ids.
  const prefillByType = new Map(SERVICE_TYPES.map((type) => [type, []]));
  for (const service of priorServices) {
    if (prefillByType.has(service.type)) prefillByType.get(service.type).push(service);
  }

  const promptTokenEnv = async (type, prior) => {
    const answer = await p.text({
      message: `Environment variable holding the ${type} token`,
      placeholder: TOKEN_ENV_PLACEHOLDER[type],
      initialValue: prior?.tokenEnv,
      validate: tokenEnvSchema,
      ...streams,
    });
    // The cancel symbol flows through untouched so the caller's isCancel
    // check sees it; trimming it here would crash the flow (#69).
    if (p.isCancel(answer)) return answer;
    return answer.trim();
  };

  const promptFieldThenTokenEnv = async (type, prior, promptFields) => {
    const fields = await promptFields();
    if (p.isCancel(fields)) return fields;
    const tokenEnv = await promptTokenEnv(type, prior);
    if (p.isCancel(tokenEnv)) return tokenEnv;
    return { ...fields, tokenEnv };
  };

  const promptServiceFields = {
    github: (prior) =>
      promptFieldThenTokenEnv("github", prior, async () => {
        const repo = await p.text({
          message: "GitHub repository",
          initialValue: prior?.repo ?? inferGithubRepo(repositoryUrl),
          placeholder: "owner/repo",
          validate: githubRepoSchema,
          ...streams,
        });
        return p.isCancel(repo) ? repo : { repo };
      }),
    gitlab: (prior) =>
      promptFieldThenTokenEnv("gitlab", prior, async () => {
        const mode = await p.select({
          message: "Identify the GitLab project by",
          options: [
            { value: "projectPath", label: "project path (group/project)" },
            { value: "projectId", label: "numeric project ID" },
          ],
          initialValue: prior?.projectId ? "projectId" : "projectPath",
          ...streams,
        });
        if (p.isCancel(mode)) return mode;
        const project =
          mode === "projectId"
            ? await p.text({
                message: "GitLab project ID",
                placeholder: "1234",
                initialValue: prior?.projectId,
                validate: gitlabProjectIdSchema,
                ...streams,
              })
            : await p.text({
                message: "GitLab project path",
                placeholder: "group/project",
                initialValue: prior?.projectPath,
                validate: gitlabProjectPathSchema,
                ...streams,
              });
        if (p.isCancel(project)) return project;
        return mode === "projectId" ? { projectId: project } : { projectPath: project };
      }),
    asana: (prior) =>
      promptFieldThenTokenEnv("asana", prior, async () => {
        const projectGid = await p.text({
          message: "Asana project GID",
          initialValue: prior?.projectGid,
          validate: genericIdSchema("A project GID"),
          ...streams,
        });
        return p.isCancel(projectGid) ? projectGid : { projectGid };
      }),
    notion: (prior) =>
      promptFieldThenTokenEnv("notion", prior, async () => {
        const dataSourceId = await p.text({
          message: "Notion data source ID",
          initialValue: prior?.dataSourceId,
          validate: genericIdSchema("A data source ID"),
          ...streams,
        });
        return p.isCancel(dataSourceId) ? dataSourceId : { dataSourceId };
      }),
  };

  const services = [];
  for (const type of selectedTypes) {
    let another = true;
    while (another) {
      const prior = prefillByType.get(type)?.shift();
      const fields = await promptServiceFields[type](prior);
      const stop = checkCancel(fields);
      if (stop) return stop;
      let id;
      if (prior) {
        takenIds.add(prior.id);
        id = prior.id;
      } else {
        id = nextId(type);
      }
      services.push({ id, type, ...fields });
      another = await p.confirm({
        message: `Add another ${type} service?`,
        initialValue: false,
        ...streams,
      });
      const moreStop = checkCancel(another);
      if (moreStop) return moreStop;
    }
  }

  const config = {
    projectName: projectName.trim(),
    repositoryUrl: repositoryUrl.trim().replace(/\/+$/, ""),
    services,
  };

  // Staging gate: the assembled object must load through the existing config
  // loader before anything is written to the real target. All-or-nothing.
  const staging = await mkdtemp(join(tmpdir(), "workbench-init-check-"));
  try {
    await writeFile(join(staging, "workbench.config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await loadWorkbenchConfig(staging);
  } catch (error) {
    p.log.error(
      `The collected answers do not form a valid config: ${error instanceof Error ? error.message : "unknown error"}`,
      streams,
    );
    p.cancel("No changes written.", streams);
    return { status: "error" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  p.outro(`Created ${configPath}`, streams);
  return { status: "written" };
};
