# Fry-CLI

`Fry` is a project to see how far [gpt-oss](https://huggingface.co/openai/gpt-oss-20b) can be pushed through prompt/tool definition formatting.

## Features

### Tools:
- Web browsing
- Exec (shell or Python)
- Filesystem (fs.*: file ops + patching)

## Example test

### Coding/File browsing
>**Prompt:** Go through `examples/gpt-oss` and explain how one can implement a chat interface with the model `gpt-oss`.
![coding](assets/coding_test.gif)

## Requirements

You must provide an OpenAI Chat Completions endpoint for `fry` to connect to (e.g. `http://localhost:8080/v1/chat/completions`).

## Installation

Install Fry CLI:
```bash
npm install -g @buchuleaf/fry-cli
```

## Getting started

Run `fry` from any directory.
```bash
fry
```

## Example setup

1. `llama.cpp` to host the model
```bash
./llama-server.exe -hf ggml-org/gpt-oss-20b-GGUF -c 0 --n-cpu-moe 99 -ngl 99 --jinja --temp 1.0 --top-p 1.0 --top-k 0.0 --reasoning-format none -fa -b 8192 -ub 4096 --chat-template-kwargs "{\`"reasoning_effort\`": \`"high\`"}"
```
2. Run `fry` in any directory
3. Pick desired endpoint
4. Login to dashboard with Google OAuth
5. Generate and enter API key
6. Begin!

## MCP Server (Open WebUI)
*Under development*

How to use with Open WebUI:
- Build Fry CLI: `npm run build`
- Start via Open WebUI MCP integration by adding a server that launches: `node /path/to/fry-cli/dist/mcp/server.js` (or, if installed globally, use the bin `fry-mcp`).
- The server communicates over stdio and implements: `initialize`, `tools/list`, and `tools/call`.

## Notes:
- Outputs that are large are paginated (same behavior as the CLI). The MCP server returns text or json content depending on the tool output.
- All filesystem operations are constrained to the current working directory the server is launched from.
