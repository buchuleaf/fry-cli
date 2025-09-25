#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef } from 'react';
import { render, Text, Box, useInput, useApp, useStdout } from 'ink';
import Gradient from 'ink-gradient';
import SelectInput from 'ink-select-input';
import { OpenAI } from 'openai/index.mjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import meow from 'meow';
// import open from 'open'; // removed with auth/dashboard flows
import { LocalToolExecutor, ToolCall, ToolResult } from './tools.js';
import * as https from 'https';
import { spawnSync } from 'child_process';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

// ===== Helpers: directory listing (workspace snapshot) =====
async function getRootDirectoryListing(maxChars: number = 4000): Promise<string> {
  try {
    const dir = process.cwd();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    let totalChars = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      const isDir = entry.isDirectory();
      const line = isDir ? `${entry.name}/` : `${entry.name}`;
      if (totalChars + line.length > maxChars) {
        lines.push('... (listing truncated)');
        break;
      }
      lines.push(line);
      totalChars += line.length;
    }
    return lines.length > 0 ? lines.join('\n') : 'Directory is empty.';
  } catch (error: any) {
    return `Error reading directory: ${error?.message || String(error)}`;
  }
}

// ===== Self-update (kept) =====
async function getCurrentPkgVersion(): Promise<string | null> {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const data = await readFile(fileURLToPath(pkgUrl), 'utf-8');
    const json = JSON.parse(data);
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0; const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
async function fetchLatestVersion(pkgName: string, timeoutMs = 3000): Promise<string | null> {
  return await new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const latest = json?.['dist-tags']?.latest;
          resolve(typeof latest === 'string' ? latest : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
  });
}
async function maybeSelfUpdate(opts?: { skip?: boolean, timeoutMs?: number }) {
  try {
    const envSkip = String(process.env.FRYCLI_NO_UPDATE || process.env.NO_UPDATE || '').toLowerCase();
    if (opts?.skip || envSkip === '1' || envSkip === 'true') return;
    const primary = '@buchuleaf/fry-cli';
    const fallback = '@buchuleaf/frycli';
    const current = await getCurrentPkgVersion();
    if (!current) return;
    let latest = await fetchLatestVersion(primary, opts?.timeoutMs ?? 3000);
    let pkgName = primary;
    if (!latest) {
      latest = await fetchLatestVersion(fallback, opts?.timeoutMs ?? 3000);
      if (latest) pkgName = fallback;
    }
    if (!latest) return;
    if (compareSemver(latest, current) <= 0) return;

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const rootProbe = spawnSync(npmCmd, ['root', '-g'], { encoding: 'utf8', timeout: 3000 });
    let canWriteGlobal = false;
    let globalRoot = '';
    if (!rootProbe.error && rootProbe.status === 0 && typeof rootProbe.stdout === 'string') {
      globalRoot = rootProbe.stdout.trim();
      try {
        fsSync.accessSync(globalRoot, fsSync.constants.W_OK);
        canWriteGlobal = true;
      } catch {
        canWriteGlobal = false;
      }
    }

    if (!canWriteGlobal) {
      const hintCmd = process.platform === 'win32'
        ? `npm i -g ${pkgName}@latest`
        : `sudo npm i -g ${pkgName}@latest`;
      console.log(`A new version of Fry CLI is available (${current} → ${latest}).`);
      console.log('Auto-update skipped: no write access to global npm directory.');
      console.log(`To update manually, run: ${hintCmd}`);
      return;
    }

    console.log(`A new version of Fry CLI is available (${current} → ${latest}). Updating...`);
    const args = ['i', '-g', `${pkgName}@latest`];
    const result = spawnSync(npmCmd, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 15000
    });
    if (result.error) {
      console.log('Auto-update skipped (npm not available).');
    } else if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      const tail = stderr.split('\n').slice(-1)[0] || 'unknown error';
      console.log(`Auto-update failed: ${tail}. Continuing with current version.`);
    } else {
      console.log('Fry CLI updated successfully. You may need to re-run to use the new version.');
    }
  } catch {
    // swallow
  }
}

// ===== Types =====
interface SessionData { session_id: string; tier: 'local'; }
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// Streaming delta (loosely typed to match OpenAI-compatible chunks)
type ToolDelta = {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  }
};
type ChoiceDelta = {
  delta?: {
    content?: string;
    tool_calls?: ToolDelta[];
  }
};
type StreamChunk = {
  choices?: ChoiceDelta[];
};

// ===== Local tool definitions (exec + fs.*) =====
const getLocalTools = () => {
  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'exec',
        description: "Execute code via a local runtime. Set runtime to 'shell' or 'python'. Use this for tasks like text searching (no fs.search_files tool). Returns labeled STDOUT/STDERR; large output is paginated.",
        parameters: {
          type: 'object',
          properties: {
            runtime: { type: 'string', description: "Runtime to use: 'shell' | 'python'." },
            command: { type: 'string', description: "Shell command when runtime='shell'." },
            code: { type: 'string', description: "Python code when runtime='python'." },
            page: { type: 'integer', description: 'Page number (1-indexed), default 1.' },
            page_size: { type: 'integer', description: 'Characters per page, default 2000.' }
          },
          required: ['runtime']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs.ls',
        description: 'List files and folders under a directory (relative to project root).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: "Directory to list (relative). Defaults to '.' if omitted." }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs.read',
        description: 'Read lines from a text file. Returns { content, start_line, end_line, total_lines, has_more, next_start_line }.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative).' },
            start_line: { type: 'integer', description: '1-indexed start line (default: 1).' },
            end_line: { type: 'integer', description: '1-indexed end line (inclusive). If omitted, returns 50 lines.' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs.write',
        description: 'Write text content to a file (creates or overwrites).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target file path (relative).' },
            content: { type: 'string', description: 'Full text content to write.' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs.mkdir',
        description: 'Create a directory (recursively). No error if it already exists.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to create (relative).' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs.apply_patch',
        description: "Apply multi-file edits using the pseudo-unified patch format bounded by '*** Begin Patch' and '*** End Patch'.",
        parameters: {
          type: 'object',
          properties: {
            patch: { type: 'string', description: 'Patch text to apply.' }
          },
          required: ['patch']
        }
      }
    }
  ];
  return tools;
};

const clearTerminalOutput = () => {
  console.clear();

  if (!process.stdout.isTTY) return;

  // Clear scrollback and move cursor to top-left for a clean slate
  process.stdout.write('\u001B[3J\u001B[2J\u001B[H');
};

// ===== Chat Component =====

const ChatInterface: React.FC<{
  sessionData: SessionData;
  modelEndpoint: string;
  modelName: string;
  onResetSession: (data: SessionData) => void;
}> = ({ sessionData, modelEndpoint, modelName, onResetSession }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const stdoutRef = useRef(stdout);
  useEffect(() => {
    stdoutRef.current = stdout;
  }, [stdout]);

  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const isInterruptedRef = useRef(false);
  const clearedNoticeRef = useRef(false);

  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({ baseURL: modelEndpoint, apiKey: 'dummy' }));
  const conversationHistory = useRef<Message[]>([]);
  const turnMessages = useRef<Message[]>([]);

  useEffect(() => {
    if (!stdoutRef.current) return;
    stdoutRef.current.write(`\nFryCLI | Session: ${sessionData.session_id.substring(0, 8)}... | ${sessionData.tier.toUpperCase()}\n`);
    stdoutRef.current.write(`Working directory: ${process.cwd()}\n`);
    if (clearedNoticeRef.current) {
      stdoutRef.current.write('History cleared. New session started.\n');
      clearedNoticeRef.current = false;
    }
  }, [sessionData]);

  const write = (text: string) => {
    if (!stdoutRef.current) return;
    stdoutRef.current.write(text);
  };

  const writeLine = (text: string) => {
    write(text.endsWith('\n') ? text : `${text}\n`);
  };

  const executeToolCall = async (toolCall: ToolCall): Promise<ToolResult> => {
    const toolName = toolCall.function.name;

    let argsStr = '...';
    try {
      const argsObj = JSON.parse(toolCall.function.arguments || '{}');
      argsStr = Object.entries(argsObj)
        .map(([k, v]) => {
          const s = String(v);
          return `${k}='${s.length > 35 ? s.slice(0, 35) + '...' : s}'`;
        })
        .join(', ');
    } catch {}

    writeLine(`\n🔧 Executing: ${toolName}(${argsStr})`);

    let result: ToolResult;
    try {
      if (
        toolName === 'workspace' ||
        toolName === 'exec' ||
        toolName.startsWith('fs.') ||
        toolName === 'python' ||
        toolName === 'shell' ||
        toolName === 'apply_patch'
      ) {
        result = await localExecutor.current.execute(toolCall);
      } else {
        result = { status: 'error', data: `Unknown or unsupported tool: ${toolName}` } as ToolResult;
      }
    } catch (error: any) {
      result = { status: 'error', data: `Tool failed: ${error?.message || String(error)}` };
    }

    const resultRaw: any = result?.data;
    let resultText: string;

    const isPaginated = (
      result &&
      result.status === 'success' &&
      resultRaw && typeof resultRaw === 'object' && typeof (resultRaw as any).content === 'string' &&
      Number.isFinite((resultRaw as any).page) && Number.isFinite((resultRaw as any).total_pages)
    );

    if (
      result.status === 'success' &&
      typeof resultRaw === 'object' &&
      resultRaw !== null &&
      'path' in resultRaw &&
      'content' in resultRaw
    ) {
      const { path, content, start_line, end_line, total_lines, has_more } = resultRaw as any;
      const header = `--- Reading ${path} (lines ${start_line}-${end_line} of ${total_lines}) ---`;
      const footer = has_more ? `--- (more lines available) ---` : `--- (end of file) ---`;
      resultText = [header, content, footer].join('\n');
    } else if (isPaginated) {
      const { page, total_pages, page_size, total_chars, has_prev, has_next } = resultRaw as any;
      const header = `--- Page ${page}/${total_pages} (page_size=${page_size}, total_chars=${total_chars}) ---`;
      const footerParts = [header];
      if (has_prev || has_next) {
        footerParts.push(`Note: To view additional pages, call "${toolName}" again with the same arguments and set "page" to the desired page number.`);
      }
      resultText = [header, (resultRaw as any).content, footerParts.join('\n')].join('\n');
    } else {
      resultText = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw, null, 2);
      if (resultText === undefined || resultText === null) {
        try { resultText = String(resultRaw ?? ''); } catch { resultText = ''; }
      }
    }

    const indented = resultText.split('\n').map(l => `  ${l}`).join('\n');
    writeLine(`[${toolName}] ${result.status}:`);
    writeLine(indented);
    write('\n');

    return result;
  };

  const processChatTurn = async (userInput: string) => {
    setIsProcessing(true);
    isInterruptedRef.current = false;

    conversationHistory.current.push({ role: 'user', content: userInput });
    turnMessages.current = [{ role: 'user', content: userInput }];

    try {
      const workspaceContents = await getRootDirectoryListing();
      const includeFs = true;
      const includeExec = true;
      const fsGuidance = includeFs
        ? "\nFilesystem tools (fs.*): fs.ls, fs.read, fs.write, fs.mkdir, fs.apply_patch.\n" +
          "- Paths are relative to the current working directory.\n" +
          "- Use only relative paths, not absolute paths.\n" +
          "- There is no fs.search_files tool; use the exec tool (runtime 'shell' or 'python') for searches and filtering.\n" +
          "- fs.read: returns up to 200 lines. Params: { path, start_line?, end_line? }. If end_line is omitted, returns 50 lines starting at start_line (default 1).\n" +
          "  The response includes metadata: { content, start_line, end_line, total_lines, has_more, next_start_line }.\n" +
          "- For multi-file edits, use fs.apply_patch with the pseudo-unified patch format bounded by '*** Begin Patch' and '*** End Patch'.\n"
        : '';
      const execGuidance = includeExec
        ? "\nExec tool: use { runtime: 'shell' | 'python' } to run local commands/code.\n" +
          "- Runs in the current working directory.\n" +
          "- Use shell commands (e.g. rg/grep/find) or Python snippets via exec for any search or traversal tasks.\n" +
          "- Large outputs are paginated with metadata for navigation.\n"
        : '';

      const developerContent = (
        "You are a helpful terminal assistant. Follow all user requests to the best of your abilities\n" +
        fsGuidance + execGuidance + "\n" +
        `The current directory contains the following files:\n${workspaceContents}\n`
      );

      const messagesForLlm: any[] = [
        { role: 'developer', content: developerContent },
        ...conversationHistory.current
      ];
      const toolsForLlm = getLocalTools();

      while (true) {
        if (isInterruptedRef.current) break;

        let accumulatedOutput = '';
        let headerPrinted = false;

        const ensureHeader = () => {
          if (headerPrinted) return;
          headerPrinted = true;
          write('\n🤖 Fry:\n');
        };

        const builtinToolsKw: string[] = [];
        const stream = await (openaiClient.current.chat.completions as any).create({
          model: modelName,
          messages: messagesForLlm,
          tools: toolsForLlm,
          tool_choice: 'auto',
          stream: true,
          extra_body: { add_generation_prompt: true, builtin_tools: builtinToolsKw }
        });

        const toolAssembler: Map<number, ToolCall> = new Map();
        type ToolDisplayState = {
          headerShown: boolean;
          id?: string;
          name?: string;
          argsLabelShown: boolean;
          lastChunkEndedWithNewline: boolean;
        };
        const toolDisplayState: Map<number, ToolDisplayState> = new Map();
        const toolCalls: ToolCall[] = [];

        for await (const chunk of stream as AsyncIterable<StreamChunk>) {
          if (isInterruptedRef.current) break;

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.tool_calls) {
            ensureHeader();
            for (const tc of delta.tool_calls) {
              if (!toolAssembler.has(tc.index)) {
                toolAssembler.set(tc.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const acc = toolAssembler.get(tc.index)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name && !acc.function.name) acc.function.name = tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;

              let display = toolDisplayState.get(tc.index);
              if (!display) {
                display = {
                  headerShown: false,
                  argsLabelShown: false,
                  lastChunkEndedWithNewline: false,
                };
                toolDisplayState.set(tc.index, display);
              }

              if (!display.headerShown) {
                write('\n');
                writeLine(`🔧 Tool call #${tc.index + 1}`);
                display.headerShown = true;
              }
              if (tc.id && tc.id !== display.id) {
                display.id = tc.id;
                writeLine(`  id: ${tc.id}`);
              }
              if (tc.function?.name && tc.function.name !== display.name) {
                display.name = tc.function.name;
                writeLine(`  name: ${tc.function.name}`);
              }
              if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
                if (!display.argsLabelShown) {
                  write('  arguments: ');
                  display.argsLabelShown = true;
                }
                write(tc.function.arguments);
                display.lastChunkEndedWithNewline = tc.function.arguments.endsWith('\n');
              }
            }
          }

          if (delta.content) {
            const piece = delta.content;
            accumulatedOutput += piece;
            ensureHeader();
            write(piece);
          }
        }

        toolDisplayState.forEach((state) => {
          if (state.argsLabelShown && !state.lastChunkEndedWithNewline) {
            write('\n');
            state.lastChunkEndedWithNewline = true;
          }
        });

        if (headerPrinted && accumulatedOutput.length > 0 && !accumulatedOutput.endsWith('\n')) {
          write('\n');
        }

        const assistantMessage: Message = { role: 'assistant' };
        if (accumulatedOutput.trim().length > 0) {
          assistantMessage.content = accumulatedOutput;
        }

        toolCalls.push(...Array.from(toolAssembler.values()));
        for (const tc of toolCalls) {
          if (!tc.id || tc.id.length === 0) tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
        }
        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls.slice(0, 1);
        }

        turnMessages.current.push(assistantMessage);
        conversationHistory.current.push(assistantMessage);
        const assistantForLlm: any = { role: 'assistant' };
        if (assistantMessage.content) assistantForLlm.content = assistantMessage.content;
        if (assistantMessage.tool_calls) assistantForLlm.tool_calls = assistantMessage.tool_calls;
        (messagesForLlm as any[]).push(assistantForLlm);

        if (isInterruptedRef.current) break;

        if ((assistantMessage.tool_calls?.length || 0) === 0) break;

        for (const toolCall of assistantMessage.tool_calls || []) {
          const result = await executeToolCall(toolCall);
          const rawData: any = result?.data;
          const looksPaginated = rawData && typeof rawData === 'object' && typeof rawData.content === 'string' && Number.isFinite(rawData.page) && Number.isFinite(rawData.total_pages);
          const dataForModel = looksPaginated && rawData.total_pages > 1
            ? `${rawData.content}\n\nNote: To view additional pages, call the "${toolCall.function.name}" tool again with the same arguments and set "page" to the desired page number.`
            : rawData.content;

          const payloadForModel = looksPaginated
            ? {
                status: result.status,
                data: dataForModel,
                pagination: {
                  page: rawData.page,
                  page_size: rawData.page_size,
                  total_chars: rawData.total_chars,
                  total_pages: rawData.total_pages,
                  has_prev: rawData.has_prev,
                  has_next: rawData.has_next,
                },
                tool: toolCall.function.name,
              }
            : result;
          const toolMessage: Message = {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(payloadForModel)
          };
          turnMessages.current.push(toolMessage);
          (messagesForLlm as any[]).push(toolMessage);
          conversationHistory.current.push(toolMessage);
        }
      }
    } catch (error) {
      writeLine(`\nError: ${String(error)}`);
    } finally {
      if (isInterruptedRef.current) {
        writeLine(`\n✗ Response interrupted by user.`);
        isInterruptedRef.current = false;
      }
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;

    const userInput = value.trim();
    setInput('');

    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      exit();
      return;
    }

    if (userInput.toLowerCase() === '/clear') {
      try {
        setIsProcessing(true);
        isInterruptedRef.current = false;
        turnMessages.current = [];
        conversationHistory.current = [];

        clearTerminalOutput();
        const newSessionInfo: SessionData = { session_id: Math.random().toString(36).slice(2, 10), tier: 'local' };
        clearedNoticeRef.current = true;
        onResetSession(newSessionInfo);
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    write('\n');
    writeLine('👤 You:');
    writeLine(userInput);

    await processChatTurn(userInput);
  };

  useInput((char, key) => {
    if (key.escape) {
      exit();
    }

    if (key.ctrl && (char || '').toLowerCase() === 'c') {
      if (isProcessing) {
        isInterruptedRef.current = true;
      } else {
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column">
      {isProcessing ? (
        <Box marginTop={1}>
          <Text color="cyan">Processing... (Ctrl+C to interrupt)</Text>
        </Box>
      ) : (
        <ChatPrompt
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
        />
      )}

      <Box marginTop={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text dimColor>Shift+Enter for newline, Enter to submit</Text>
          <Text dimColor>Commands: /clear, /exit</Text>
        </Box>
      </Box>
    </Box>
  );
};

const ChatPrompt: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  isActive?: boolean;
}> = ({ value, onChange, onSubmit, isActive = true }) => {
  useInput(
    (input, key) => {
      if (key.return && !key.shift) {
        if (value.trim()) {
          onSubmit(value);
        }
        return;
      }
      if (key.return && key.shift) {
        onChange(value + '\n');
        return;
      }

      // Ctrl+Backspace → delete previous word
      if (key.ctrl && key.backspace) {
        const next = value.replace(/\s+$/, '');
        const removed = next.replace(/\S+$/, '');
        onChange(removed);
        return;
      }

      if (key.backspace) {
        onChange(value.slice(0, -1));
        return;
      }

      if (
        !key.ctrl && !key.meta && !key.return && !key.backspace &&
        !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow &&
        !key.tab && !key.escape
      ) {
        onChange(value + input);
      }
    }, { isActive });

  return (
    <Box>
      <Text color="blue" bold>👤 You: </Text>
      <Text>{value}</Text>
    </Box>
  );
};

const EndpointSelector: React.FC<{ onSelect: (url: string) => void }> = ({ onSelect }) => {
  const presets = [
    { label: '(1) Ollama (http://localhost:11434/v1)', value: 'http://localhost:11434/v1' },
    { label: '(2) vLLM (http://localhost:8000/v1)', value: 'http://localhost:8000/v1' },
    { label: '(3) LM Studio (http://localhost:1234/v1)', value: 'http://localhost:1234/v1' },
    { label: '(4) llama.cpp (http://localhost:8080/v1)', value: 'http://localhost:8080/v1' },
    { label: '(5) Custom URL (http://localhost:10000/v1)', value: 'http://localhost:10000/v1' }
  ];

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customUrl, setCustomUrl] = useState('');

  const handleSelect = (item: any) => {
    if (item.value === 'custom') {
      setShowCustomInput(true);
    } else {
      onSelect(item.value);
    }
  };

  const handleCustomSubmit = (value: string) => {
    onSelect(value);
  };

  if (showCustomInput) {
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>Enter custom endpoint URL:</Text>
        <ChatPrompt value={customUrl} onChange={setCustomUrl} onSubmit={handleCustomSubmit} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>Select LLM endpoint:</Text>
      <SelectInput items={presets} onSelect={handleSelect} />
    </Box>
  );
};

const App: React.FC<{ modelName: string; }> = ({ modelName }) => {
  const [stage, setStage] = useState<'endpoint' | 'chat'>('endpoint');
  const [modelEndpoint, setModelEndpoint] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);

  const handleEndpointSelect = (url: string) => {
    setModelEndpoint(url);
    const sessionInfo: SessionData = { session_id: Math.random().toString(36).slice(2, 10), tier: 'local' };
    setSessionData(sessionInfo);
    setStage('chat');
  };

  return (
    <Box flexDirection="column" padding={1}>
      {stage === 'endpoint' && (
        <Box marginBottom={1}>
          <Gradient name="pastel">
            <Text bold>Welcome to FryCLI</Text>
          </Gradient>
        </Box>
      )}

      {stage === 'endpoint' && <EndpointSelector onSelect={handleEndpointSelect} />}

      {stage === 'chat' && sessionData && modelEndpoint && (
        <ChatInterface
          sessionData={sessionData}
          modelEndpoint={modelEndpoint}
          modelName={modelName}
          onResetSession={(data) => {
            setSessionData(data);
          }}
        />
      )}
    </Box>
  );
};

// ===== CLI/bootstrap =====
const cli = meow(
  `
Usage
  $ fry

Options
  --model      Model name (default: llama)
  --no-update  Skip auto update check
`,
  {
    importMeta: import.meta,
    flags: {
      model: { type: 'string', isRequired: false },
      update: { type: 'boolean', default: true }
    }
  }
);

(async () => {
  //await maybeSelfUpdate({ skip: !cli.flags.update });
  const modelName = cli.flags.model || process.env.FRY_MODEL_NAME || 'llama';

  render(
    <App modelName={modelName} />,
    { exitOnCtrlC: false }
  );
})();
