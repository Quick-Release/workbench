export const SELF_REPOSITORY = "Quick-Release/workbench";
export const SELF_REPOSITORY_URL = `https://github.com/${SELF_REPOSITORY}`;

const SELF_GITHUB_SERVICE = Object.freeze({
  id: "github-issues",
  type: "github",
  label: "GitHub issues",
  repo: SELF_REPOSITORY,
});

export const servicesForSource = (services, useSelfDefault) =>
  useSelfDefault && services.length === 0 ? [SELF_GITHUB_SERVICE] : services;
