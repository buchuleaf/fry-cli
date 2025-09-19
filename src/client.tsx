#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef } from 'react';
import { render, Text, Box, useInput, useApp, Static } from 'ink';
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
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

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

// ===== Markdown renderer (terminal) =====
marked.use(markedTerminal({
  // Preserve model formatting as much as possible: avoid reflowing/wrapping text.
  width: process.stdout.columns || 80,
  reflowText: false,
  unescape: true,
  breaks: true,
}));

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
        description: "Execute code via a local runtime. Set runtime to 'shell' or 'python'. Returns labeled STDOUT/STDERR; large output is paginated.",
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
        name: 'fs.search_files',
        description: "Search for a substring across text files. Returns 'path:line:match' lines. Large result sets are paginated.",
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Substring to match (case-sensitive).' },
            file_pattern: { type: 'string', description: "Glob of files to include (default '**/*')." },
            path: { type: 'string', description: 'Optional base directory to scope the search (relative).' },
            page: { type: 'integer', description: 'Page number to retrieve (1-indexed). Defaults to 1.' },
            page_size: { type: 'integer', description: 'Number of matches per page. Defaults to 50, max 100.' }
          },
          required: ['pattern']
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

// ===== Small UI bits =====
const LoadingIndicator: React.FC<{ text: string }> = ({ text }) => (
  <Box><Text color="cyan">{text}</Text></Box>
);

// Synchronous Markdown renderer designed to work both for live streaming
// (optionally buffers unclosed code fences) and finalized transcript items.
const StreamingMarkdown: React.FC<{ content: string; streaming?: boolean }> = ({ content, streaming }) => {
  // Compute synchronously so content persists when flushed by <Static />.
  let toRender = content || '';
  try {
    if (streaming && toRender) {
      // If there's an odd number of ``` fences, temporarily close the block
      // to avoid broken formatting during streaming.
      const fences = toRender.match(/```/g) || [];
      const isCodeBlockOpen = fences.length % 2 !== 0;
      if (isCodeBlockOpen) toRender = toRender + '\n```';
    }
    toRender = marked(toRender) as unknown as string;
  } catch {
    // Fallback to raw content on parsing error
  }
  return <Text>{toRender}</Text>;
};

// ===== Chat Component =====
type TranscriptItem = React.ReactNode;

const ChatInterface: React.FC<{
  sessionData: SessionData;
  modelEndpoint: string;
  modelName: string;
  onResetSession: (data: SessionData) => void;
  streamIntervalMs: number;
}> = ({ sessionData, modelEndpoint, modelName, onResetSession, streamIntervalMs }) => {
  const { exit } = useApp();
  // Let Ink manage raw mode internally for better Windows compatibility

  const [input, setInput] = useState('');
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const isInterruptedRef = useRef(false);
  // We avoid live re-rendering during streaming to prevent terminal yank.

  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({ baseURL: modelEndpoint, apiKey: 'dummy' }));
  const conversationHistory = useRef<Message[]>([]);
  const turnMessages = useRef<Message[]>([]);

  const appendTranscript = (node: TranscriptItem) => setStaticItems(prev => [...prev, node]);
  const lastBlockRef = useRef<'assistant' | 'tool' | 'user' | 'system' | 'other' | null>(null);

  useEffect(() => {
    appendTranscript(
      <Box marginBottom={1}>
        <Text color="cyan" bold>FryCLI</Text>
        <Text> | Session: {sessionData.session_id.substring(0, 8)}... | </Text>
        <Text color={'green'} bold>
          {sessionData.tier.toUpperCase()}
        </Text>
      </Box>
    );
    appendTranscript(<Text dimColor>Working directory: {process.cwd()}</Text>);
    lastBlockRef.current = 'system';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Avoid manually toggling raw mode; fixes input echo on PowerShell

  const executeToolCall = async (toolCall: ToolCall): Promise<ToolResult> => {
    const toolName = toolCall.function.name;

    // Show tool header
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
    appendTranscript(
      <Box>
        <Text color="yellow">🔧 Executing: </Text>
        <Text color="cyan" bold>{toolName}({argsStr})</Text>
      </Box>
    );
    lastBlockRef.current = 'tool';

    // Execute locally only
    let result: ToolResult;
    try {
      if (toolName === 'workspace' || toolName === 'exec' || toolName.startsWith('fs.') || toolName === 'python' || toolName === 'shell' || toolName === 'apply_patch') {
        result = await localExecutor.current.execute(toolCall);
      } else {
        result = { status: 'error', data: `Unknown or unsupported tool: ${toolName}` } as ToolResult;
      }
    } catch (error: any) {
      result = { status: 'error', data: `Tool failed: ${error?.message || String(error)}` };
    }

    // Render result and also normalize what we send back to the model.
    const resultRaw: any = result?.data;
    let resultText: string;

    // Detect a generic pagination envelope: { content: string, page, total_pages, ... }
    const isPaginated = (
      result && result.status === 'success' &&
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
      // File read (line-ranged) formatting
      const { path, content, start_line, end_line, total_lines, has_more } = resultRaw as any;
      const header = `--- Reading ${path} (lines ${start_line}-${end_line} of ${total_lines}) ---`;
      const footer = has_more ? `--- (more lines available) ---` : `--- (end of file) ---`;
      resultText = [header, content, footer].join('\n');
    } else if (isPaginated) {
      const { page, total_pages, page_size, total_chars } = resultRaw as any;
      const header = `--- Page ${page}/${total_pages} (page_size=${page_size}, total_chars=${total_chars}) ---`;
      resultText = [header, (resultRaw as any).content].join('\n');
    } else {
      // Fallback formatting
      resultText = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw, null, 2);
      if (resultText === undefined || resultText === null) {
        try { resultText = String(resultRaw ?? ''); } catch { resultText = ''; }
      }
    }
    
    const indented = resultText.split('\n').map(l => `  ${l}`).join('\n');
    appendTranscript(
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>[{toolName}] {result.status}:</Text>
        <Text>{indented}</Text>
      </Box>
    );
    return result;
  };

  const processChatTurn = async (userInput: string) => {
    setIsProcessing(true);
    isInterruptedRef.current = false;
    let accumulatedOutput = ''; // Accumulator for the current streamed assistant message

    conversationHistory.current.push({ role: 'user', content: userInput });
    turnMessages.current = [{ role: 'user', content: userInput }];

    // No periodic re-renders; we stream directly to stdout.

    try { // Wrap main logic in try/finally to ensure cleanup
      const workspaceContents = await getRootDirectoryListing();
      const includeFs = true;
      const includeExec = true;
      const fsGuidance = includeFs
        ? "\nFilesystem tools (fs.*): fs.ls, fs.read, fs.write, fs.mkdir, fs.search_files, fs.apply_patch.\n" +
          "- Paths are relative to the current working directory.\n" +
          "- Use only relative paths, not absolute paths.\n" +
          "- fs.read: returns up to 200 lines. Params: { path, start_line?, end_line? }. If end_line is omitted, returns 50 lines starting at start_line (default 1).\n" +
          "  The response includes metadata: { content, start_line, end_line, total_lines, has_more, next_start_line }.\n" +
          "- For multi-file edits, use fs.apply_patch with the pseudo-unified patch format bounded by '*** Begin Patch' and '*** End Patch'.\n"
        : '';
      const execGuidance = includeExec
        ? "\nExec tool: use { runtime: 'shell' | 'python' } to run local commands/code.\n" +
          "- Runs in the current working directory.\n" +
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

      // === Stream assistant ===
      while (true) {
        if (isInterruptedRef.current) break;

        // Reset accumulator for each assistant streaming cycle
        accumulatedOutput = '';

        // Print assistant header and a newline once before streaming tokens
        try {
          process.stdout.write("\n");
          process.stdout.write("🤖 Fry:\n");
        } catch {}

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
        const toolCalls: ToolCall[] = [];
        // We skip live tool-call preview to avoid dynamic redraws.

        for await (const chunk of stream as AsyncIterable<StreamChunk>) {
          if (isInterruptedRef.current) break;

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Assemble tool_calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolAssembler.has(tc.index)) {
                toolAssembler.set(tc.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const acc = toolAssembler.get(tc.index)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name && !acc.function.name) acc.function.name = tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            }
            // Collect tool call chunks; no live preview to avoid redraws
          }

          if (delta.content) {
            const piece = delta.content;
            accumulatedOutput += piece;
            try {
              process.stdout.write(piece);
            } catch {}
          }
        }

        // Ensure trailing newline after streaming content
        try {
          if (!accumulatedOutput.endsWith('\n')) process.stdout.write('\n');
        } catch {}

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

        // Do not append content again; it was streamed above. Avoid double-printing.

        if (isInterruptedRef.current) break;

        if ((assistantMessage.tool_calls?.length || 0) === 0) break;

        for (const toolCall of assistantMessage.tool_calls || []) {
        const result = await executeToolCall(toolCall);
          // Normalize pagination for the model: send the page content as data, with meta sidecar
          const rawData: any = result?.data;
          const looksPaginated = rawData && typeof rawData === 'object' && typeof rawData.content === 'string' && Number.isFinite(rawData.page) && Number.isFinite(rawData.total_pages);
          const payloadForModel = looksPaginated
            ? {
                status: result.status,
                data: rawData.content,
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
        appendTranscript(<Text color="red">Error: {String(error)}</Text>);
    }
    // This finally block ensures the UI is always cleaned up correctly.
    finally {
      if (isInterruptedRef.current) {
        appendTranscript(<Text color="yellow">✗ Response interrupted by user.</Text>);
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
        // Reset session metadata and transcript state after clearing the terminal
        const newSessionInfo: SessionData = { session_id: Math.random().toString(36).slice(2, 10), tier: 'local' };
        onResetSession(newSessionInfo);
        setStaticItems([]); // Clear the visual transcript
        appendTranscript(
          <Box marginBottom={1}>
            <Text color="cyan" bold>FryCLI</Text>
            <Text> | Session: {newSessionInfo.session_id.substring(0, 8)}... | </Text>
            <Text color={'green'} bold>
              {newSessionInfo.tier.toUpperCase()}
            </Text>
          </Box>
        );
        appendTranscript(
          <Text dimColor>
            Working directory: {process.cwd()}
          </Text>
        );
        appendTranscript(<Text color="yellow">History cleared. New session started.</Text>);
        lastBlockRef.current = 'system';
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    // Auth/dashboard/key commands removed in local-only mode

    appendTranscript(
      <Box flexDirection="column" marginBottom={1}>
        <Text color="blue" bold>👤 You:</Text>
        <Text>{userInput}</Text>
      </Box>
    );
    lastBlockRef.current = 'user';
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
      <Static items={staticItems}>
        {(item, idx) => (
          <Box key={idx}>{item}</Box>
        )}
      </Static>

      {/* No live area during streaming; we write directly to stdout. */}

      {!isProcessing && (
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

const App: React.FC<{ modelName: string; streamIntervalMs: number; }> = ({ modelName, streamIntervalMs }) => {
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
          streamIntervalMs={streamIntervalMs}
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
  await maybeSelfUpdate({ skip: !cli.flags.update });
  const modelName = cli.flags.model || process.env.FRY_MODEL_NAME || 'llama';

  render(
    <App modelName={modelName} streamIntervalMs={60} />,
    { exitOnCtrlC: false }
  );
})();
