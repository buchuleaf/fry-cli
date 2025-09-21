# Fry-CLI

`Fry` is a project to see how far [gpt-oss](https://huggingface.co/openai/gpt-oss-20b) can be pushed through prompt/tool definition formatting.

## Features

### Tools:
- Web browsing
- Exec (shell or Python)
- Filesystem (fs.*: file ops + patching)

## Example test

### Coding/File browsing
>**Prompt:** Go through `examples/gpt-oss` and explain how  implement a chat interface with the model `gpt-oss`.
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