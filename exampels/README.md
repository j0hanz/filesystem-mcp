# Example clients

Small, runnable apps built on
[`@modelcontextprotocol/client`](https://ts.sdk.modelcontextprotocol.io/v2/)
that use filesystem-mcp as their workspace engine. Each one is a starting point
for your own MCP client: copy the folder, run `npm install`, and change what
you need.

## Prerequisites

- Node 24 or later (apps run as `node <file>.ts`, no build step).
- For apps that use a model: [Ollama](https://ollama.com) with a
  tool-capable model, or an API key for one of the supported providers.

## Apps

| App                               | What it does                                                          | Run                                         |
| :-------------------------------- | :-------------------------------------------------------------------- | :------------------------------------------ |
| [gatekeeper](clients/gatekeeper/) | Coding agent with a y/N/why gate on every file change                 | `node agent.ts <dir> --model <id>`          |
| [hooks](clients/hooks/)           | Runs a standing task through the model whenever the workspace changes | `node hooks.ts <dir> "<task>" --model <id>` |

## Model providers

Apps that call a model speak the OpenAI-compatible Chat Completions API over
`fetch`, with no vendor SDK. Pick a provider with `--provider`, or point
`LLM_BASE_URL` at any compatible host.

| `--provider` | Base URL                                                  | Key env var         | Tested  |
| :----------- | :-------------------------------------------------------- | :------------------ | :------ |
| `ollama`     | `http://localhost:11434/v1`                               | none                | yes     |
| `gemini`     | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`    | yes     |
| `openai`     | `https://api.openai.com/v1`                               | `OPENAI_API_KEY`    | not yet |
| `anthropic`  | `https://api.anthropic.com/v1`                            | `ANTHROPIC_API_KEY` | not yet |
