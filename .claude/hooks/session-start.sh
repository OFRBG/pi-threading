#!/bin/bash
set -euo pipefail

# Only needed for Claude Code on the web / remote sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install project dependencies (pulls in the pi coding agent as a devDependency).
npm install

# Configure pi to default to OpenRouter, with a curated set of cheap models
# scoped to different task types (Ctrl+P cycling). Relies on OPENROUTER_API_KEY
# already being present in the environment. Merges into any existing global
# settings.json instead of clobbering it.
node <<'NODE'
const fs = require("fs");
const path = require("path");

const settingsPath = path.join(process.env.HOME, ".pi", "agent", "settings.json");
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
}

settings.defaultProvider = "openrouter";
settings.defaultModel = "qwen/qwen3-coder";
settings.enabledModels = [
  "openrouter/qwen/qwen3-coder", // coding / worker (heavy hitter)
  "openrouter/deepseek/deepseek-r1-0528", // planning / architecture (heavy hitter)
  "openrouter/google/gemini-2.5-flash-lite", // scout / recon
  "openrouter/z-ai/glm-4.5-air", // code review
  "openrouter/openai/gpt-oss-20b", // journal / summarization
  "openrouter/qwen/qwen3-30b-a3b-instruct-2507", // coordinator / routing
  "openrouter/openai/gpt-4o-mini", // quick chat / Q&A
  "openrouter/qwen/qwen3.5-flash-02-23", // long-context / large docs
];

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
NODE
