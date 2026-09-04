// `dotenvx run` warns about a missing .env on every script invocation, so the
// package scripts seed one from .env.example before dotenvx loads it. Existing
// files are never overwritten, and a missing example is a silent no-op so
// installs without the example (packaged copies) stay quiet.
import { copyFile, access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exists = async (path) => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const ensureEnvFile = async ({
  directory,
  exampleName = ".env.example",
  envName = ".env",
}) => {
  const envPath = join(directory, envName);
  if (await exists(envPath)) return { created: false, envPath };
  const examplePath = join(directory, exampleName);
  if (!(await exists(examplePath))) return { created: false, envPath };
  await copyFile(examplePath, envPath);
  return { created: true, envPath };
};

const main = async () => {
  const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { created } = await ensureEnvFile({ directory: appDirectory });
  if (created) console.log("[workbench] created .env from .env.example");
};

// Guard so importing this module (env.test.mjs) does not create .env.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
