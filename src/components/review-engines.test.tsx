import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ReviewEngines } from "./ReviewEngines";
import type { ReviewEngineHealth } from "../types";

// Ticket #24's UI contract: each engine renders as ready or not-ready with
// its specific remediation command, and no engine is ever given a start
// affordance — starting a review belongs to a later epic #20 slice. Health
// arrives as data — the route probes on load.

const ready: ReviewEngineHealth = {
  engine: "coderabbit",
  state: "ready",
  version: "coderabbit 1.2.3",
};
const unconfigured: ReviewEngineHealth = {
  engine: "zcode",
  state: "provider_missing",
  version: "0.16.5",
  remediation: "run `zcode login` to configure a model provider",
};

const renderPanel = (health: readonly ReviewEngineHealth[] | null) =>
  renderToString(<ReviewEngines health={health} />);

describe("the review-engines health panel", () => {
  it("renders a ready engine with its version and no start affordance", () => {
    const html = renderPanel([ready]);
    expect(html).toContain('data-engine="coderabbit"');
    expect(html).toContain('data-engine-state="ready"');
    expect(html).toContain("coderabbit 1.2.3");
    expect(html).not.toContain("Run review");
  });

  it("renders a not-ready engine with its exact remediation command and no start affordance", () => {
    const html = renderPanel([unconfigured]);
    expect(html).toContain('data-engine="zcode"');
    expect(html).toContain('data-engine-state="provider_missing"');
    expect(html).toContain("run `zcode login` to configure a model provider");
    expect(html).not.toContain("Run review");
  });

  it("renders the probing state before the health verdict arrives", () => {
    const html = renderPanel(null);
    expect(html).toContain('data-slot="review-engines-unknown"');
    expect(html).not.toContain('data-engine="coderabbit"');
    expect(html).not.toContain("Run review");
  });

  it("renders both engines in the runner's fixed order", () => {
    const html = renderPanel([ready, unconfigured]);
    expect(html.indexOf('data-engine="coderabbit"')).toBeLessThan(
      html.indexOf('data-engine="zcode"'),
    );
  });

  it("labels the auth and install failure states with their own commands", () => {
    const html = renderPanel([
      {
        engine: "coderabbit",
        state: "auth_missing",
        version: "coderabbit 1.2.3",
        remediation: "run `coderabbit auth login --api-key <your Agentic API key>`",
      },
      {
        engine: "zcode",
        state: "binary_missing",
        remediation: "install the ZCode desktop app — the zcode CLI ships inside it",
      },
    ]);
    expect(html).toContain('data-engine-state="auth_missing"');
    expect(html).toContain("coderabbit auth login");
    expect(html).toContain('data-engine-state="binary_missing"');
    expect(html).toContain("ZCode desktop app");
  });
});

describe("the issue-agent engine's health states (issue #40)", () => {
  const readyAgent: ReviewEngineHealth = {
    engine: "opencode",
    state: "ready",
    version: "opencode 1.0.197",
    models: ["qwen3-coder:30b"],
    defaultModel: "ollama/qwen3-coder:30b",
  };

  it("renders the agent's unreachable-server state with its start command", () => {
    const html = renderPanel([
      {
        engine: "opencode",
        state: "ollama_unreachable",
        version: "opencode 1.0.197",
        remediation:
          "start the Ollama server (`ollama serve`) — the issue agent runs local models only",
      },
    ]);
    expect(html).toContain('data-engine-state="ollama_unreachable"');
    expect(html).toContain("start the Ollama server");
  });

  it("renders the unpulled-model state with the pull command", () => {
    const html = renderPanel([
      {
        engine: "opencode",
        state: "model_missing",
        version: "opencode 1.0.197",
        model: "ollama/qwen3-coder:30b",
        models: ["llama3.2:latest"],
        remediation: "run `ollama pull qwen3-coder:30b`, or pick a pulled model in the panel",
      },
    ]);
    expect(html).toContain('data-engine-state="model_missing"');
    expect(html).toContain("ollama pull qwen3-coder:30b");
  });

  it("renders the ready agent with its model inventory and warning", () => {
    const html = renderPanel([
      { ...readyAgent, warning: "Ollama is using its small default context (4096 tokens)." },
    ]);
    expect(html).toContain('data-engine-state="ready"');
    expect(html).toContain("qwen3-coder:30b");
    expect(html).toContain("4096 tokens");
  });
});
