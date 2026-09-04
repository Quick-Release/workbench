import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Demo checkout used when demo mode is requested (WORKBENCH_DEMO_SOURCE=1 or
// the dev:demo / sync:demo scripts). A non-empty request can also name any
// other checkout to read instead. Demo data is a preview corpus only: any
// enclosing git checkout that is not this package's own repository — npm
// installs, vendored copies, submodules — counts as a proper host and always
// supplies the data itself, ignoring the demo source.
export const demoSourceRoot = (request = "") => {
  const value = String(request).trim();
  if (value && value !== "1" && value.toLowerCase() !== "true")
    return resolve(value.replace(/^~(?=\/|$)/, homedir()));
  return join(homedir(), "workspaces", "getquick", "banquinha");
};

export const resolveSourceRoot = ({
  appDirectory,
  configuredSourceRoot,
  superprojectDirectory,
  gitDirectory,
  demoDirectory,
  fallbackDirectory,
  fallbackGitDirectory,
}) => {
  const packageIsInItsOwnRepository =
    gitDirectory && resolve(gitDirectory) === resolve(appDirectory);
  const insideHostRepository = Boolean(
    superprojectDirectory ||
    (gitDirectory && !packageIsInItsOwnRepository) ||
    (!gitDirectory && fallbackGitDirectory),
  );
  const usingDemoSource = Boolean(!configuredSourceRoot && !insideHostRepository && demoDirectory);
  const usingSelfRepository = Boolean(
    !configuredSourceRoot && !insideHostRepository && !usingDemoSource,
  );
  const rootDirectory =
    configuredSourceRoot ||
    (insideHostRepository ? superprojectDirectory || gitDirectory || fallbackGitDirectory : "") ||
    (insideHostRepository ? "" : demoDirectory || gitDirectory) ||
    fallbackDirectory;
  return {
    rootDirectory: resolve(rootDirectory),
    usingDemoSource,
    usingSelfRepository,
  };
};
