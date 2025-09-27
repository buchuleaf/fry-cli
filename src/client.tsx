#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { render, Text, Box, useInput, useApp, useStdout, Static } from 'ink';
import { format } from 'node:util';
import Gradient from 'ink-gradient';
import SelectInput from 'ink-select-input';
import { OpenAI } from 'openai/index.mjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import meow from 'meow';
// import open from 'open'; // removed with auth/dashboard flows
import { LocalToolExecutor, ToolCall, ToolResult } from './tools.js';
import { buildDeveloperPrompt } from './prompt.js';
import * as https from 'https';
import { spawnSync } from 'child_process';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { Marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

function renderMarkdownToAnsi(markdown: string, columns?: number): string {
  if (!markdown) return '';

  try {
    const marked = new Marked();
    marked.use({
      renderer: new TerminalRenderer({
        width: columns,
        reflowText: true
      }) as any
    });

    const output = marked.parse(markdown);
    return typeof output === 'string' ? output : String(output ?? markdown);
  } catch (error) {
    return markdown;
  }
}

function ensureTrailingNewline(value: string): string {
  if (!value) return value;
  return value.endsWith('\n') ? value : `${value}\n`;
}

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
async function maybeSelfUpdate(
  opts?: { skip?: boolean, timeoutMs?: number },
  emit?: (message: string, kind?: 'system' | 'error') => void
) {
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
      emit?.(`A new version of Fry CLI is available (${current} → ${latest}).\n`, 'system');
      emit?.('Auto-update skipped: no write access to global npm directory.\n', 'system');
      emit?.(`To update manually, run: ${hintCmd}\n`, 'system');
      return;
    }

    emit?.(`A new version of Fry CLI is available (${current} → ${latest}). Updating...\n`, 'system');
    const args = ['i', '-g', `${pkgName}@latest`];
    const result = spawnSync(npmCmd, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 15000
    });
    if (result.error) {
      emit?.('Auto-update skipped (npm not available).\n', 'error');
    } else if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      const tail = stderr.split('\n').slice(-1)[0] || 'unknown error';
      emit?.(`Auto-update failed: ${tail}. Continuing with current version.\n`, 'error');
    } else {
      emit?.('Fry CLI updated successfully. You may need to re-run to use the new version.\n', 'system');
    }
  } catch (error) {
    emit?.(`Auto-update encountered an unexpected error: ${String(error)}\n`, 'error');
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

type LogKind = 'system' | 'user' | 'assistant' | 'tool' | 'log' | 'error';

type LogEntry = {
  id: string;
  kind: LogKind;
  content: string;
};

type ToolDisplayAccumulator = {
  id?: string;
  name?: string;
  args: string;
};

function formatToolDisplay(index: number, data: ToolDisplayAccumulator): string {
  const lines: string[] = [`🔧 Tool call #${index + 1}`];
  if (data.id) {
    lines.push(`  id: ${data.id}`);
  }
  if (data.name) {
    lines.push(`  name: ${data.name}`);
  }
  if (data.args.trim().length > 0) {
    lines.push('  arguments:');
    for (const argLine of data.args.split('\n')) {
      lines.push(`    ${argLine}`);
    }
  }
  return lines.join('\n');
}

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

// ===== Chat Component =====

const ChatInterface: React.FC<{
  sessionData: SessionData;
  modelEndpoint: string;
  modelName: string;
  onResetSession: (data: SessionData) => void;
}> = ({ sessionData, modelEndpoint, modelName, onResetSession }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const logIdRef = useRef(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [activeStream, setActiveStream] = useState<string | null>(null);
  const [transientToolDisplays, setTransientToolDisplays] = useState<Array<{ id: string; content: string }>>([]);

  const appendLog = useCallback((content: string, kind: LogKind = 'log') => {
    const id = `log-${logIdRef.current++}`;
    setLogEntries(prev => [...prev, { id, kind, content }]);
  }, []);

  useEffect(() => {
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    const wrap = <T extends (...args: any[]) => void>(original: T, kind: LogKind): T => {
      const wrapped = ((...args: Parameters<T>) => {
        const text = format(...args);
        const normalized = text.endsWith('\n') ? text : `${text}\n`;
        appendLog(normalized, kind);
      }) as T;
      return wrapped;
    };

    console.log = wrap(originalConsole.log, 'log');
    console.info = wrap(originalConsole.info, 'log');
    console.warn = wrap(originalConsole.warn, 'log');
    console.error = wrap(originalConsole.error, 'error');
    console.debug = wrap(originalConsole.debug, 'log');

    return () => {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
    };
  }, [appendLog]);

  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const isInterruptedRef = useRef(false);
  const clearedNoticeRef = useRef(false);

  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({ baseURL: modelEndpoint, apiKey: 'dummy' }));
  const conversationHistory = useRef<Message[]>([]);
  const turnMessages = useRef<Message[]>([]);

  useEffect(() => {
    const lines = [
      '',
      `FryCLI | Session: ${sessionData.session_id.substring(0, 8)}... | ${sessionData.tier.toUpperCase()}`,
      `Working directory: ${process.cwd()}`
    ];
    if (clearedNoticeRef.current) {
      lines.push('History cleared. New session started.');
      clearedNoticeRef.current = false;
    }
    appendLog(`${lines.join('\n')}\n`, 'system');
  }, [appendLog, sessionData]);

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

    appendLog(`🔧 Executing: ${toolName}(${argsStr})\n`, 'tool');

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
    appendLog(`[${toolName}] ${result.status}:\n${indented}\n`, 'tool');

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

      const developerContent = await buildDeveloperPrompt({
        workspaceListing: workspaceContents,
        includeFsTools: includeFs,
        includeExecTool: includeExec,
        cwd: process.cwd()
      });

      const messagesForLlm: any[] = [
        { role: 'developer', content: developerContent },
        ...conversationHistory.current
      ];
      const toolsForLlm = getLocalTools();

      while (true) {
        if (isInterruptedRef.current) break;

        let accumulatedOutput = '';
        let headerPrinted = false;
        let hasStreamRendered = false;

        setActiveStream(null);
        setTransientToolDisplays([]);

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
        const toolDisplayBuffer: Map<number, ToolDisplayAccumulator> = new Map();
        const toolCalls: ToolCall[] = [];

        const syncTransientToolDisplays = () => {
          if (toolDisplayBuffer.size === 0) {
            setTransientToolDisplays([]);
            return;
          }
          const displays = Array.from(toolDisplayBuffer.entries()).map(([index, data]) => ({
            id: `tool-${index}`,
            content: formatToolDisplay(index, data)
          }));
          setTransientToolDisplays(displays);
        };

        for await (const chunk of stream as AsyncIterable<StreamChunk>) {
          if (isInterruptedRef.current) break;

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolAssembler.has(tc.index)) {
                toolAssembler.set(tc.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const acc = toolAssembler.get(tc.index)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name && !acc.function.name) acc.function.name = tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;

              let display = toolDisplayBuffer.get(tc.index);
              if (!display) {
                display = { args: '' };
                toolDisplayBuffer.set(tc.index, display);
              }
              if (tc.id) display.id = tc.id;
              if (tc.function?.name) display.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                display.args += tc.function.arguments;
              }
            }
            syncTransientToolDisplays();
          }

          if (delta.content) {
            accumulatedOutput += delta.content;

            if (!hasStreamRendered && accumulatedOutput.trim().length === 0) {
              continue;
            }

            if (!headerPrinted) {
              headerPrinted = true;
            }

            setActiveStream(prev => (prev === accumulatedOutput ? prev : accumulatedOutput));
            hasStreamRendered = true;
          }
        }

        if (!hasStreamRendered && accumulatedOutput.length > 0) {
          if (accumulatedOutput.trim().length > 0) {
            if (!headerPrinted) {
              headerPrinted = true;
            }
            setActiveStream(accumulatedOutput);
            hasStreamRendered = true;
          }
        }

        if (headerPrinted && accumulatedOutput.trim().length > 0) {
          appendLog(accumulatedOutput, 'assistant');
        }

        if (toolDisplayBuffer.size > 0) {
          for (const [index, data] of toolDisplayBuffer.entries()) {
            const content = formatToolDisplay(index, data);
            appendLog(`\n${content}\n`, 'tool');
          }
        }

        setActiveStream(null);
        setTransientToolDisplays([]);

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
      appendLog(`\nError: ${String(error)}\n`, 'error');
    } finally {
      setActiveStream(null);
      setTransientToolDisplays([]);
      if (isInterruptedRef.current) {
        appendLog(`\n✗ Response interrupted by user.\n`, 'system');
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
        const newSessionInfo: SessionData = { session_id: Math.random().toString(36).slice(2, 10), tier: 'local' };
        clearedNoticeRef.current = true;
        onResetSession(newSessionInfo);
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    appendLog(userInput, 'user');

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
      <Static items={logEntries}>
        {(entry) => {
          if (entry.kind === 'assistant') {
            const markdown = renderMarkdownToAnsi(entry.content, stdout?.columns ?? process.stdout?.columns) || entry.content;
            const display = ensureTrailingNewline(markdown);
            return (
              <Box key={entry.id} flexDirection="column" marginTop={1}>
                <Text color="green">🤖 Fry:</Text>
                <Text>{display}</Text>
              </Box>
            );
          }

          if (entry.kind === 'user') {
            const display = ensureTrailingNewline(entry.content);
            return (
              <Box key={entry.id} flexDirection="column" marginTop={1}>
                <Text color="blue">👤 You:</Text>
                <Text>{display}</Text>
              </Box>
            );
          }

          if (entry.kind === 'tool') {
            const display = ensureTrailingNewline(entry.content);
            return (
              <Box key={entry.id} flexDirection="column" marginTop={1}>
                <Text color="yellow">{display}</Text>
              </Box>
            );
          }

          if (entry.kind === 'error') {
            const display = ensureTrailingNewline(entry.content);
            return (
              <Box key={entry.id} flexDirection="column" marginTop={1}>
                <Text color="red">{display}</Text>
              </Box>
            );
          }

          const markdown = renderMarkdownToAnsi(entry.content, stdout?.columns ?? process.stdout?.columns) || entry.content;
          const display = ensureTrailingNewline(markdown);
          return (
            <Box key={entry.id} flexDirection="column" marginTop={1}>
              <Text>{display}</Text>
            </Box>
          );
        }}
      </Static>

      {isProcessing && activeStream && activeStream.trim().length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">🤖 Fry:</Text>
          <Text>
            {ensureTrailingNewline(
              renderMarkdownToAnsi(activeStream, stdout?.columns ?? process.stdout?.columns) || activeStream
            )}
          </Text>
        </Box>
      )}

      {transientToolDisplays.map(display => (
        <Box key={display.id} marginTop={1} flexDirection="column">
          <Text>{display.content}</Text>
        </Box>
      ))}

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
      const isBackspaceChar = input === '\u0008' || input === '\u007f';
      const isBackspace = key.backspace || isBackspaceChar;
      const isCtrlBackspace = key.ctrl && isBackspace;

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
      if (isCtrlBackspace) {
        const next = value.replace(/\s+$/, '');
        const removed = next.replace(/\S+$/, '');
        onChange(removed);
        return;
      }

      if (isBackspace) {
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
