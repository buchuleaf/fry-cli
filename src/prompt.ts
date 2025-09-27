import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

let cachedBasePrompt: string | null = null;

async function loadBasePrompt(): Promise<string> {
  if (cachedBasePrompt) {
    return cachedBasePrompt;
  }

  const promptPath = fileURLToPath(new URL('../assets/prompts/codex_base_prompt.md', import.meta.url));
  cachedBasePrompt = await readFile(promptPath, 'utf-8');
  return cachedBasePrompt;
}

export interface PromptOptions {
  workspaceListing: string;
  includeFsTools: boolean;
  includeExecTool: boolean;
  cwd: string;
}

export async function buildDeveloperPrompt(options: PromptOptions): Promise<string> {
  const base = await loadBasePrompt();
  const sections: string[] = [base.trim()];

  const localToolSections: string[] = [];

  if (options.includeFsTools) {
    localToolSections.push([
      '## Local filesystem tools',
      '',
      '**Filesystem tools**',
      '- `fs.ls`: List directories relative to the current workspace.',
      '- `fs.read`: Read file slices with metadata `{ content, start_line, end_line, total_lines, has_more, next_start_line }` (defaults to 50 lines, capped at 200).',
      '- `fs.write`: Create or overwrite files with the provided `content`.',
      '- `fs.mkdir`: Create directories recursively; succeeds if the directory already exists.',
      '- `fs.apply_patch`: Apply multi-file edits using the pseudo-unified diff format bounded by `*** Begin Patch` and `*** End Patch`.',
      '',
      '*Usage notes:*',
      '- Use only relative paths under the current workspace.',
      '- Prefer batching related edits into a single `fs.apply_patch` call.',
      '- There is no `fs.search_files`; rely on the execution tools for searching.',
    ].join('\n'));
  }

  if (options.includeExecTool) {
    localToolSections.push([
      '## Local execution tools',
      '',
      '**Execution tool**',
      '- `exec`: Run local commands with `{ runtime: "shell" | "python" }`. Provide `command` for shell tasks or `code` for Python snippets.',
      '- Commands run in the current working directory; prefer `rg`/`rg --files` for search tasks.',
      '- Outputs are paginated. Use the optional `page` and `page_size` fields to navigate longer outputs.',
      '- Results include labeled STDOUT/STDERR to aid debugging.',
    ].join('\n'));
  }

  if (localToolSections.length > 0) {
    sections.push(localToolSections.join('\n\n'));
  }

  const workspaceLines: string[] = [
    '## Workspace snapshot',
    '',
    `- Current working directory: ${path.resolve(options.cwd)}`,
    '',
  ];

  const listing = options.workspaceListing?.trim();
  if (listing) {
    workspaceLines.push('```');
    workspaceLines.push(listing);
    workspaceLines.push('```');
  } else {
    workspaceLines.push('Directory is empty.');
  }

  sections.push(workspaceLines.join('\n'));

  return sections.join('\n\n');
}
