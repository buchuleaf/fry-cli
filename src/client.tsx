#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef } from 'react';
import { render, Text, Box, useInput, useApp, Static, useStdin, useFocus } from 'ink';
// Removed animated spinner to avoid frequent re-renders that can disrupt scroll
import TextInput from 'ink-text-input';
import Gradient from 'ink-gradient';
import SelectInput from 'ink-select-input';
import { OpenAI } from 'openai/index.mjs';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import meow from 'meow';
import dotenv from 'dotenv';
import open from 'open';
import { LocalToolExecutor, ToolCall, ToolResult } from './tools.js';
import * as https from 'https';
import { spawnSync } from 'child_process';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Helper: list the user's current working directory (root where 'fry' is run)
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

// Self-update on startup: check npm for newer version and attempt update
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
    if (!latest) { // try fallback name
      latest = await fetchLatestVersion(fallback, opts?.timeoutMs ?? 3000);
      if (latest) pkgName = fallback;
    }
    if (!latest) return;
    if (compareSemver(latest, current) <= 0) return; // up-to-date or newer local

    // Attempt global update; only try if global directory looks writable
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    // Ask npm where the global node_modules is and check writability
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

    // Print a brief notice before Ink renders
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
    // Swallow any unexpected errors to avoid impacting CLI usage
  }
}

// Full Markdown renderer using marked + marked-terminal (ANSI output)
// Configure once at module load
// Disable reflow to avoid inserting artificial line breaks; let Ink handle wrapping.
try {
  const width = Math.max(40, Math.min(process.stdout?.columns || 80, 120));
  marked.use((markedTerminal as any)({
    reflowText: false,
    width,
    tab: 2,
    unescape: true
  }));
} catch {
  // Fallback silently if configuration fails
}

const MarkdownBlock: React.FC<{ content: string }> = React.memo(({ content }) => {
  const md = content ?? '';
  let out = md;
  try {
    // marked.parse returns a string when using the terminal renderer
    out = String(marked.parse(md));
  } catch {
    out = md;
  }
  // Avoid injecting artificial trailing newlines: if the original content
  // did not end with a newline, trim all trailing newlines in the rendered
  // output. If it did end with a newline, normalize to exactly one.
  const inputEndsWithNl = /\r?\n$/.test(md);
  if (inputEndsWithNl) {
    out = out.replace(/\n+$/g, '\n');
  } else {
    out = out.replace(/\n+$/g, '');
  }
  return <Text>{out}</Text>;
});

// Types
interface SessionData {
  session_id: string;
  tier: 'free' | 'premium';
}

interface RateLimitStatus {
  remaining: number;
  reset_in_seconds: number;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// API Client
class GptOssApiClient {
  private backendUrl: string;
  private apiKey: string;
  private axios: AxiosInstance;

  constructor(backendUrl: string, apiKey: string) {
    this.backendUrl = backendUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.axios = axios.create({
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 15000
    });
  }

  async startSession(): Promise<any | null> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/start_session`);
      if (response.status === 200) {
        return response.data;
      }
      return null;
    } catch (error) {
      // keep behavior: return null on error so caller shows "Invalid or expired API key."
      return null;
    }
  }

  async sendWorkspaceContents(sessionId: string, contents: string): Promise<boolean> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/workspace_contents`, {
        session_id: sessionId,
        contents
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async prepareChatTurn(sessionId: string, newMessages: Message[]): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/prepare_chat_turn`, {
      session_id: sessionId,
      new_messages: newMessages
    });
    return response.data;
  }

  async orchestrateToolCall(sessionId: string, toolCall: ToolCall): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/orchestrate_tool_call`, {
      session_id: sessionId,
      tool_call: toolCall
    });
    return response.data;
  }

  async trackToolCall(sessionId: string, toolCall: ToolCall): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/track_tool_call`, {
      session_id: sessionId,
      tool_call: toolCall
    });
    return response.data;
  }

  async generateLoginLink(): Promise<string | null> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/generate_login_link`);
      return response.data.token || null;
    } catch {
      return null;
    }
  }
}

// UI Components
const LoadingIndicator: React.FC<{ text: string }> = ({ text }) => (
  <Box>
    <Text color="cyan">{text}</Text>
  </Box>
);

// Removed unused ToolExecution and ToolResultDisplay components to reduce noise

const RateLimitInfo: React.FC<{ status: RateLimitStatus }> = ({ status }) => {
  const hours = Math.floor(status.reset_in_seconds / 3600);
  const minutes = Math.floor((status.reset_in_seconds % 3600) / 60);
  
  return (
    <Text dimColor>
      Usage: {status.remaining} calls remaining. Limit resets in {hours}h {minutes}m.
    </Text>
  );
};

// Single message bubble renderer
const MessageBubble: React.FC<{ msg: Message }> = ({ msg }) => {
  if (typeof msg.content !== 'string') return null;

  switch (msg.role) {
    case 'user':
      return (
        <Box>
          <Text color="blue" bold>👤 You: </Text>
          <Text>{msg.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box>
          <Text color="green" bold>🤖 Fry: </Text>
          <MarkdownBlock content={msg.content || ''} />
        </Box>
      );
    case 'tool':
      return <Text dimColor>{msg.content}</Text>;
    case 'system':
      return <Text color="yellow">{msg.content}</Text>;
    default:
      return null;
  }
};

// Append-only transcript rendered via Static for scroll stability
type TranscriptItem = React.ReactNode;

// Main Chat Component
const ChatInterface: React.FC<{
  client: GptOssApiClient;
  sessionData: SessionData;
  modelEndpoint: string;
  modelName: string;
  initialRateLimitStatus: RateLimitStatus | null;
  onResetSession: (data: SessionData) => void;
  streamChunks: boolean;
  streamIntervalMs: number;
  // Limit of lines to show in the dynamic preview while streaming
  previewMaxLines?: number;
  // Streaming mode: 'append' appends static chunks, 'preview' shows a dynamic live block
  streamMode?: 'append' | 'preview';
}> = ({ client, sessionData, modelEndpoint, modelName, initialRateLimitStatus, onResetSession, streamChunks, streamIntervalMs, previewMaxLines = 0, streamMode = 'preview' }) => {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();
  const [input, setInput] = useState('');
  // Append-only transcript using Ink's <Static> for scroll stability
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Display tool execution as committed log entries instead of dynamic state
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus | null>(initialRateLimitStatus);
  const isInterruptedRef = useRef(false);
  // Removed thinking timer to reduce re-renders during streaming
  
  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({
    baseURL: modelEndpoint,
    apiKey: 'dummy'
  }));
  const turnMessages = useRef<Message[]>([]);
  const conversationHistory = useRef<Message[]>([]);

  const appendTranscript = (node: TranscriptItem) => {
    setStaticItems(prev => [...prev, node]);
  };

  const formatElapsed = (_totalSeconds: number): string => '';

  // No-op timer effect removed to avoid UI churn

  // Add static session header once at the top of the transcript
  useEffect(() => {
    appendTranscript(
      <Box marginBottom={1}>
        <Text color="cyan" bold>FryCLI</Text>
        <Text> | Session: {sessionData.session_id.substring(0, 8)}... | </Text>
        <Text color={sessionData.tier === 'premium' ? 'green' : 'yellow'} bold>
          {sessionData.tier.toUpperCase()}
        </Text>
      </Box>
    );
    // Show the working directory at the start of each chat
    appendTranscript(
      <Text dimColor>
        Working directory: {process.cwd()}
      </Text>
    );
    lastBlockRef.current = 'system';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ensure raw mode is enabled on Windows so input keystrokes are captured reliably
  useEffect(() => {
    try {
      if (process.platform === 'win32' && isRawModeSupported) {
        setRawMode(true);
        return () => {
          try { setRawMode(false); } catch {}
        };
      }
    } catch {}
  }, [isRawModeSupported, setRawMode]);

  // Streaming state: we only buffer in a ref to avoid re-renders
  const liveAssistantContentRef = useRef<string>('');
  const assistantHeaderAppendedRef = useRef<boolean>(false);
  // Tracks when the header has been committed to the static transcript
  const headerCommittedRef = useRef<boolean>(false);
  // Harmony-specific: no special code-block reasoning handling needed beyond markdown rendering
  // Live preview shown during streaming (single dynamic block to avoid scroll yank)
  const [livePreview, setLivePreview] = useState<string>('');
  const [showLivePreview, setShowLivePreview] = useState<boolean>(false);
  // Append-mode helpers
  const lastFlushedLengthRef = useRef<number>(0);
  const openFenceRef = useRef<'```' | '~~~' | null>(null);
  const consumedUpToRef = useRef<number>(0);
  const pendingRef = useRef<string>('');
  // Track the last type of transcript block to control spacing before tool logs
  const lastBlockRef = useRef<'assistant' | 'tool' | 'user' | 'system' | 'other' | null>(null);

  const executeToolCall = async (toolCall: ToolCall): Promise<ToolResult> => {
    const toolName = toolCall.function.name;
    
    // Parse arguments once and optionally augment them (e.g., infer missing chunk index)
    let parsedArgs: any = null;
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch {
      parsedArgs = null;
    }
    // No read_chunk defaulting needed with simplified API

    // Determine if we should visually separate from assistant content
    const needsSpacer = (lastBlockRef.current === 'assistant');

    try {
      const args = JSON.parse(toolCall.function.arguments);
      const argsStr = Object.entries(args)
        .map(([k, v]) => {
          const str = String(v);
          return `${k}='${str.length > 35 ? str.substring(0, 35) + '...' : str}'`;
        })
        .join(', ');
      // Append tool execution start
      appendTranscript(
        <Box marginTop={needsSpacer ? 1 : 0}>
          <Text color="yellow">🔧 Executing: </Text>
          <Text color="cyan" bold>{toolName}({argsStr})</Text>
        </Box>
      );
      lastBlockRef.current = 'tool';
    } catch {
      appendTranscript(
        <Box marginTop={needsSpacer ? 1 : 0}>
          <Text color="yellow">🔧 Executing: </Text>
          <Text color="cyan" bold>{toolName}(...) </Text>
        </Box>
      );
      lastBlockRef.current = 'tool';
    }

    let result: ToolResult;

    if (toolName === 'workspace' || toolName === 'exec' || toolName.startsWith('fs.') || toolName === 'python' || toolName === 'shell' || toolName === 'apply_patch') {
      try {
        // First, track the local tool call with the backend to enforce rate limits
        const trackResponse = await client.trackToolCall(sessionData.session_id, toolCall);
        if (trackResponse.rate_limit_status) {
          setRateLimitStatus(trackResponse.rate_limit_status);
        }
        // If tracking is successful, execute the tool locally
        result = await localExecutor.current.execute(toolCall);
      } catch (error: any) {
        // If tracking fails (e.g., rate limit exceeded), create an error result
        if (error.response?.status === 429) {
          result = { status: 'error', data: error.response.data.error || 'Rate limit exceeded for local tool.' };
          if(error.response.data.rate_limit_status) {
            setRateLimitStatus(error.response.data.rate_limit_status);
          }
        } else {
          result = { status: 'error', data: `Backend tracking failed: ${error.message}` };
        }
      }
    } else {
      // For non-local tools, use the orchestration endpoint which handles tracking and execution
      try {
        const orchestrationData = await client.orchestrateToolCall(sessionData.session_id, toolCall);
        result = orchestrationData.result || { status: 'error', data: 'Invalid response from backend.' };
        
        if (orchestrationData.rate_limit_status) {
          setRateLimitStatus(orchestrationData.rate_limit_status);
        }
      } catch (error: any) {
        if (error.response?.status === 429) {
          result = { status: 'error', data: error.response.data.error || 'Rate limit exceeded.' };
           if(error.response.data.rate_limit_status) {
            setRateLimitStatus(error.response.data.rate_limit_status);
          }
        } else {
          result = { status: 'error', data: `Backend orchestration failed: ${error.message}` };
        }
      }
    }

    // Render tool result with content shown on the next line under the header
    // Be defensive: JSON.stringify(undefined) returns undefined, which would break .split below.
    let resultRaw: any = result?.data;
    let resultText = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw, null, 2);
    if (resultText === undefined || resultText === null) {
      // Fall back to a safe string representation
      try {
        resultText = String(resultRaw ?? '');
      } catch {
        resultText = '';
      }
    }

    // Add line numbers when reading file content (simplified: fs.read or workspace.read)
    let isReadTool = false;
    try {
      const argsObj = JSON.parse(toolCall.function.arguments || '{}');
      const action = (argsObj.action || '').toLowerCase();
      if (toolName === 'workspace') {
        isReadTool = action === 'read';
      } else if (toolName === 'fs.read') {
        isReadTool = true;
      }
    } catch {}

    if (isReadTool) {
      // Prefer structured fs.read payloads: { content, start_line, end_line, total_lines, has_more, next_start_line }
      let contentForNumbering: string;
      let startLineForNumbering = 1;
      let footerSuffix = '';

      if (resultRaw && typeof resultRaw === 'object' && typeof resultRaw.content === 'string') {
        contentForNumbering = resultRaw.content;
        if (Number.isFinite(Number(resultRaw.start_line))) {
          startLineForNumbering = Math.max(1, Math.floor(Number(resultRaw.start_line)));
        }
        const endLine = Number(resultRaw.end_line);
        const totalLines = Number(resultRaw.total_lines);
        const hasMore = Boolean(resultRaw.has_more);
        const nextStart = Number(resultRaw.next_start_line);
        if (Number.isFinite(endLine) && Number.isFinite(totalLines)) {
          footerSuffix = `\n\n[fs.read] Showing ${startLineForNumbering}..${endLine} of ${totalLines} lines.` + (hasMore && Number.isFinite(nextStart) ? ` More available; use start_line=${nextStart}.` : '');
        }
      } else {
        // Back-compat: older fs.read returns content as plain string
        contentForNumbering = resultText;
        try {
          const argsObj = JSON.parse(toolCall.function.arguments || '{}');
          const parseNum = (v: any) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
          };
          // Prefer explicit start_line, then line_start, then lines="A..B"
          let s = parseNum(argsObj.start_line) ?? parseNum(argsObj.line_start);
          if (!s && typeof argsObj.lines === 'string') {
            const m = String(argsObj.lines).trim().match(/^(\d+)\s*(?:\.{2}|-|:)\s*(\d+)$/);
            if (m) s = parseNum(m[1]);
          }
          if (s) startLineForNumbering = s;
        } catch {}
      }

      const lines = contentForNumbering.split('\n');
      const width = String(startLineForNumbering + lines.length - 1).length;
      const numbered = lines
        .map((line, idx) => `${String(startLineForNumbering + idx).padStart(width, ' ')} | ${line}`)
        .join('\n');
      resultText = numbered + footerSuffix;
    }

    // Indent each line of the result for clearer hierarchy
    const indented = resultText
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');

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
    conversationHistory.current.push({ role: 'user', content: userInput });
    turnMessages.current = [{ role: 'user', content: userInput }];
    // Harmony: we do not track/display CoT separately; backend normalizes history
    
    try {
      // Send the root directory listing (the directory where 'fry' was run)
      const rootListing = await getRootDirectoryListing();
      await client.sendWorkspaceContents(sessionData.session_id, rootListing);

      // Prepare chat turn with full local history (no server persistence)
      const backendData = await client.prepareChatTurn(sessionData.session_id, conversationHistory.current);
      const messagesForLlm = backendData.messages || [];
      const toolsForLlm = backendData.tools || [];

      turnMessages.current = [];

      while (true) {
        if (isInterruptedRef.current) break;
        
        // Stream response from LLM
        // Infer builtin tools from tool list for template kwargs
        const builtinToolsKw = Array.from(new Set(
          (toolsForLlm || [])
            .map((t: any) => t?.function?.name || '')
            .filter((n: string) => n.startsWith('browser.') || n === 'python')
            .map((n: string) => (n.startsWith('browser.') ? 'browser' : 'python'))
        ));

        const stream = await (openaiClient.current.chat.completions as any).create({
          model: modelName,
          messages: messagesForLlm,
          tools: toolsForLlm,
          tool_choice: 'auto',
          stream: true,
          // Let the host template handle assistant prompt; add generation prompt when supported
          extra_body: { add_generation_prompt: true, builtin_tools: builtinToolsKw }
        });

        // Initialize per-token streaming state. We avoid UI re-renders during streaming
        // and only append at a throttle interval (if enabled) or once at the end.
        assistantHeaderAppendedRef.current = false;
        headerCommittedRef.current = false;
        liveAssistantContentRef.current = '';
        lastFlushedLengthRef.current = 0;
        openFenceRef.current = null;
        consumedUpToRef.current = 0;
        pendingRef.current = '';

        let assistantContent = '';
        const toolCalls: ToolCall[] = [];
        const toolAssembler: Map<number, ToolCall> = new Map();
        // Harmony: expect modern tool_calls; no legacy function_call fallback

        // Process chunks with periodic yielding to keep UI responsive
        let lastYieldTime = Date.now();
        let lastFlushTime = 0;

        // Build a balanced Markdown block. If a fenced code block is open at the end,
        // temporarily append a closing fence so the block renders correctly.
        const balancedPreview = (md: string): string => {
          let marker: '```' | '~~~' | null = null;
          const lines = md.split('\n');
          for (const line of lines) {
            const m = line.match(/^\s*(```|~~~)/);
            if (m) {
              const cur = m[1] as '```' | '~~~';
              if (!marker) marker = cur; else if (marker === cur) marker = null;
            }
          }
          if (marker) {
            if (!md.endsWith('\n')) md += '\n';
            md += marker;
          }
          return md;
        };

        // Extract the final-channel message content (no Harmony tags)
        const extractHarmonyFinal = (text: string): string => {
          if (typeof text !== 'string') return '';
          const pattern = /<\|channel\|>final(?:\s+[a-zA-Z]+)?<\|message\|>/g;
          let lastEnd = -1;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(text)) !== null) {
            lastEnd = pattern.lastIndex;
          }
          if (lastEnd === -1) return text;
          const endReturn = text.indexOf('<|return|>', lastEnd);
          const endEnd = text.indexOf('<|end|>', lastEnd);
          const candidates = [endReturn, endEnd].filter(i => i >= 0);
          const end = candidates.length > 0 ? Math.min(...candidates) : text.length;
          return text.slice(lastEnd, end);
        };

        // Extract the latest analysis-channel message content before a tool call (no Harmony tags)
        const extractHarmonyAnalysis = (text: string): string => {
          if (typeof text !== 'string') return '';
          const callIdx = text.indexOf('<|call|>');
          const searchEnd = callIdx >= 0 ? callIdx : text.length;
          const pattern = /<\|channel\|>analysis(?:\s+[a-zA-Z]+)?<\|message\|>/g;
          let lastHeaderEnd = -1;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(text)) !== null) {
            if (pattern.lastIndex <= searchEnd) {
              lastHeaderEnd = pattern.lastIndex;
            } else {
              break;
            }
          }
          if (lastHeaderEnd === -1) {
            // Fallback: return raw text up to call, stripped of obvious markers
            const raw = text.slice(0, searchEnd);
            return raw.replaceAll('<|start|>', '').replaceAll('<|end|>', '').replaceAll('<|message|>', '');
          }
          const endIdx = text.indexOf('<|end|>', lastHeaderEnd);
          const sliceEnd = (endIdx >= 0 && endIdx <= searchEnd) ? endIdx : searchEnd;
          return text.slice(lastHeaderEnd, sliceEnd);
        };

        // Keep dynamic re-render size small by showing only the last N lines (markdown mode)
        const clampPreview = (md: string, maxLines: number): string => {
          // If maxLines <= 0, show full live preview (no truncation)
          if (!Number.isFinite(maxLines) || maxLines <= 0) return balancedPreview(md);
          const lines = (md || '').split('\n');
          if (lines.length <= maxLines) return balancedPreview(md);
          const tail = lines.slice(-maxLines);
          const notice = '… [preview truncated; full text will appear when complete]\n';
          return balancedPreview(notice + tail.join('\n'));
        };

        // Raw clamp for preview: do not inject or strip anything; no notices.
        const clampRaw = (text: string, maxLines: number): string => {
          if (!Number.isFinite(maxLines) || maxLines <= 0) return text;
          const lines = (text || '').split('\n');
          if (lines.length <= maxLines) return text;
          return lines.slice(-maxLines).join('\n');
        };
        // Prepare an append-only chunk with markdown fence continuity:
        // - If a code fence is open across chunks, prefix with the same fence to keep formatting.
        // - Always balance the chunk by closing any open fence at the end so it renders standalone.
        const wrapChunkForDisplay = (rawChunk: string): string => {
          const startFence = openFenceRef.current;
          const prefix = startFence ? `${startFence}\n` : '';
          const combined = prefix + rawChunk;
          return balancedPreview(combined);
        };

        // Update code-fence state based on raw (unmodified) content
        const updateFenceStateFrom = (rawChunk: string) => {
          const lines = (rawChunk || '').split('\n');
          for (const line of lines) {
            const m = line.match(/^\s*(```|~~~)/);
            if (m) {
              const cur = m[1] as '```' | '~~~';
              if (!openFenceRef.current) openFenceRef.current = cur; else if (openFenceRef.current === cur) openFenceRef.current = null;
            }
          }
        };

        for await (const chunk of stream) {
          if (isInterruptedRef.current) {
            break;
          }

          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolAssembler.has(tc.index)) {
                toolAssembler.set(tc.index, {
                  id: '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                });
              }
              
              const existing = toolAssembler.get(tc.index)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) {
                // Function name typically arrives whole; avoid duplicating if streamed multiple times
                if (!existing.function.name) existing.function.name = tc.function.name;
              }
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }

          // Harmony alignment: ignore legacy function_call fields if present

          if (delta.content) {
            assistantContent += delta.content;
            // Update buffered content without causing a re-render
            const updated = liveAssistantContentRef.current + delta.content;
            liveAssistantContentRef.current = updated;
            // If streaming is enabled, either append static chunks or update a live preview
            if (streamChunks) {
              const now = Date.now();
              if (!assistantHeaderAppendedRef.current) {
                // Defer committing the header to the static transcript to avoid extra spacing.
                // Render the header inside the live preview area instead until we commit content.
                assistantHeaderAppendedRef.current = true;
              }
              const interval = (streamIntervalMs ?? 0);
              const shouldUpdate = interval <= 0 || (now - lastFlushTime >= interval);
              if (shouldUpdate) {
                if (streamMode === 'append') {
                  const full = liveAssistantContentRef.current;
                  const consumed = consumedUpToRef.current;
                  if (full.length > consumed) {
                    pendingRef.current += full.slice(consumed);
                    consumedUpToRef.current = full.length;
                  }
                  let p = pendingRef.current;
                  // Flush any complete lines first
                  const idx = Math.max(p.lastIndexOf('\n'), p.lastIndexOf('\r'));
                  if (idx >= 0) {
                    const complete = p.slice(0, idx + 1);
                    const display = wrapChunkForDisplay(complete);
                    if (!headerCommittedRef.current) {
                      appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
                      headerCommittedRef.current = true;
                    }
                    appendTranscript(<Box><MarkdownBlock content={display} /></Box>);
                    lastBlockRef.current = 'assistant';
                    lastFlushedLengthRef.current += complete.length;
                    pendingRef.current = p.slice(idx + 1);
                    updateFenceStateFrom(complete);
                    p = pendingRef.current;
                  }
                  // Show raw pending remainder exactly as received (no markdown balancing).
                  if (p.length > 0) {
                    let disp = p;
                    // Ensure no extra blank line before first preview content
                    if (lastFlushedLengthRef.current === 0) {
                      disp = disp.replace(/^(?:\r?\n)+/, '');
                    }
                    setLivePreview(disp);
                    setShowLivePreview(true);
                  } else {
                    // If no text remainder, but a tool call is being assembled, show its raw arguments.
                    let toolRemainder = '';
                    if (toolAssembler.size > 0) {
                      const maxIndex = Math.max(...Array.from(toolAssembler.keys()));
                      const tc = toolAssembler.get(maxIndex);
                      if (tc?.function?.arguments) toolRemainder = tc.function.arguments;
                    }
                    // Harmony-only: no legacy function_call args fallback
                    if ((toolRemainder || '').length > 0) {
                      let disp = toolRemainder;
                      if (lastFlushedLengthRef.current === 0) {
                        disp = disp.replace(/^(?:\r?\n)+/, '');
                      }
                      setLivePreview(disp);
                      setShowLivePreview(true);
                    } else {
                      setShowLivePreview(false);
                      setLivePreview('');
                    }
                  }
                } else {
                  // In preview mode, prefer raw content; if empty, show raw tool-call args
                  const contentRaw = clampRaw(liveAssistantContentRef.current, previewMaxLines);
                  let previewRaw = contentRaw;
                  if (!previewRaw || previewRaw.length === 0) {
                    let toolRemainder = '';
                    if (toolAssembler.size > 0) {
                      const maxIndex = Math.max(...Array.from(toolAssembler.keys()));
                      const tc = toolAssembler.get(maxIndex);
                      if (tc?.function?.arguments) toolRemainder = tc.function.arguments;
                    }
                    // Harmony-only: no legacy function_call args fallback
                    previewRaw = clampRaw(toolRemainder, previewMaxLines);
                  }
                  // Remove any leading newlines at the very beginning of the assistant preview
                  // to avoid an extra blank line before the first token.
                  if (lastFlushedLengthRef.current === 0 && typeof previewRaw === 'string') {
                    previewRaw = previewRaw.replace(/^(?:\r?\n)+/, '');
                  }
                  // Only show the live preview if there's content after normalization.
                  if (previewRaw && previewRaw.length > 0) {
                    setLivePreview(previewRaw);
                    setShowLivePreview(true);
                  } else {
                    setShowLivePreview(false);
                    setLivePreview('');
                  }
                }
                lastFlushTime = now;
              }
            }
            // Periodically yield to keep UI responsive
            const now = Date.now();
            if (now - lastYieldTime > 50) {
              await new Promise(resolve => setImmediate(resolve));
              lastYieldTime = now;
              if (isInterruptedRef.current) break;
            }
          }
          // Harmony: CoT appears as analysis channel inside content; no separate reasoning field
        }

        toolCalls.push(...Array.from(toolAssembler.values()));
        // Harmony: tool_calls assembled only from delta.tool_calls
        // toolCalls are assembled from delta.tool_calls only
        // Ensure each tool call has an id for tool message linking
        for (const tc of toolCalls) {
          if (!tc.id || tc.id.length === 0) {
            tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
          }
        }
        // Harmony template assumes max 1 tool call per assistant message.
        // If multiple streamed, keep only the first to preserve template invariants.
        if (toolCalls.length > 1) {
          toolCalls.splice(1);
        }

        // This is the message that will be sent back to the backend in the next turn.
        // Provide only plain text (no Harmony tags).
        // - If tool_calls exist: include the latest analysis text preceding the call.
        // - Else: include the final text content.
        const finalOnly = (toolCalls.length > 0)
          ? extractHarmonyAnalysis(assistantContent)
          : extractHarmonyFinal(assistantContent);
        // Build the assistant message for history/next turn.
        // Root-cause fix: if the model made tool calls and did NOT produce a final message,
        // do NOT include an empty string content — omit content entirely to avoid confusing
        // downstream templates/servers.
        const assistantMessage: Message = { role: 'assistant' } as Message;
        if (finalOnly && finalOnly.trim().length > 0) {
          assistantMessage.content = finalOnly;
        }
        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }

        // End of stream; finalize display based on mode
        if (streamMode === 'append') {
          // Flush any remainder (including partial line)
          const remainder = pendingRef.current;
          if (remainder.length > 0) {
            const display = wrapChunkForDisplay(remainder);
            if (!headerCommittedRef.current) {
              appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
              headerCommittedRef.current = true;
            }
            appendTranscript(<Box><MarkdownBlock content={display} /></Box>);
            lastBlockRef.current = 'assistant';
            lastFlushedLengthRef.current += remainder.length;
            updateFenceStateFrom(remainder);
            pendingRef.current = '';
          }
          // Reset preview state
          setShowLivePreview(false);
          setLivePreview('');
          liveAssistantContentRef.current = '';
        } else {
          if ((assistantContent || '').length > 0) {
            if (!headerCommittedRef.current) {
              appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
              headerCommittedRef.current = true;
            }
            appendTranscript(<Box><MarkdownBlock content={assistantContent} /></Box>);
            lastBlockRef.current = 'assistant';
            setShowLivePreview(false);
            setLivePreview('');
            liveAssistantContentRef.current = '';
          }
        }

        turnMessages.current.push(assistantMessage);
        conversationHistory.current.push(assistantMessage);
        // Send only supported fields to the LLM
        const assistantMessageForLlm: any = { role: 'assistant' };
        if (assistantMessage.content) assistantMessageForLlm.content = assistantMessage.content;
        if (assistantMessage.tool_calls) assistantMessageForLlm.tool_calls = assistantMessage.tool_calls;
        // Harmony: no extra reasoning field; prior analysis is already embedded in content
        messagesForLlm.push(assistantMessageForLlm);

        if (isInterruptedRef.current) break;
        // Do not render analysis separately; raw Harmony text already includes it

        if (toolCalls.length === 0) {
          break;
        }

        // Execute tools (Harmony: at most one per assistant message)
        for (const toolCall of toolCalls) {
          const result = await executeToolCall(toolCall);
          
          const toolMessage: Message = {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(result)
          };

          turnMessages.current.push(toolMessage);
          messagesForLlm.push(toolMessage);
          conversationHistory.current.push(toolMessage);
        }
      }
    } catch (error) {
      appendTranscript(<Text color="red">Error: {String(error)}</Text>);
    } finally {
      if (isInterruptedRef.current) {
        // Flush partial content on interrupt
        const full = liveAssistantContentRef.current || '';
        if (!headerCommittedRef.current && full.length > 0) {
          appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
          headerCommittedRef.current = true;
        }
        if (streamMode === 'append') {
          // Flush any full lines pending
          const p = pendingRef.current;
          if (p.length > 0) {
            const display = (() => {
              const startFence = openFenceRef.current;
              const prefix = startFence ? `${startFence}\n` : '';
              // Balance code fences locally
              let md = prefix + p;
              let marker: '```' | '~~~' | null = null;
              for (const line of md.split('\n')) {
                const m = line.match(/^\s*(```|~~~)/);
                if (m) {
                  const cur = m[1] as '```' | '~~~';
                  if (!marker) marker = cur; else if (marker === cur) marker = null;
                }
              }
              if (marker) {
                if (!md.endsWith('\n')) md += '\n';
                md += marker;
              }
              return md;
            })();
            if (!headerCommittedRef.current) {
              appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
              headerCommittedRef.current = true;
            }
            appendTranscript(<Box><MarkdownBlock content={display} /></Box>);
            lastFlushedLengthRef.current += p.length;
            pendingRef.current = '';
          }
        } else {
          if (full.length > 0) {
            if (!headerCommittedRef.current) {
              appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
              headerCommittedRef.current = true;
            }
            appendTranscript(<Box><MarkdownBlock content={full} /></Box>);
            lastBlockRef.current = 'assistant';
          }
        }
        // Hide any live preview
        setShowLivePreview(false);
        setLivePreview('');
        liveAssistantContentRef.current = '';
        appendTranscript(<Text color="yellow">✗ Response interrupted by user.</Text>);
      }
      // End of turn
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
      // Start a fresh session; append a delimiter in the log (append-only)
      try {
        setIsProcessing(true);
        isInterruptedRef.current = false;
        // streaming preview disabled; nothing to reset here
        // No timers to clear
        turnMessages.current = [];
        conversationHistory.current = [];

        const newSession = await client.startSession();
        if (newSession) {
          const newSessionInfo: SessionData = {
            session_id: newSession.session_id,
            tier: newSession.tier
          };
          onResetSession(newSessionInfo);
          if (newSession.rate_limit_status) {
            setRateLimitStatus(newSession.rate_limit_status);
          } else {
            setRateLimitStatus(null);
          }
          appendTranscript(<Text dimColor>────────────────────────</Text>);
          appendTranscript(
            <Box marginBottom={1}>
              <Text color="cyan" bold>FryCLI</Text>
              <Text> | Session: {newSessionInfo.session_id.substring(0, 8)}... | </Text>
              <Text color={newSessionInfo.tier === 'premium' ? 'green' : 'yellow'} bold>
                {newSessionInfo.tier.toUpperCase()}
              </Text>
            </Box>
          );
          // Display working directory when a new session starts
          appendTranscript(
            <Text dimColor>
              Working directory: {process.cwd()}
            </Text>
          );
          appendTranscript(<Text color="yellow">History cleared. New session started.</Text>);
        } else {
          appendTranscript(<Text color="red">Error: Could not start a new session. Try again.</Text>);
        }
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    if (userInput.toLowerCase() === '/dashboard' || userInput.toLowerCase() === '/buy') {
      const token = await client.generateLoginLink();
      if (token) {
        const isCheckout = userInput.toLowerCase() === '/buy';
        const pageName = isCheckout ? 'checkout page' : 'dashboard';
        const url = `${client['backendUrl']}/login_with_token/${token}${isCheckout ? '?next=checkout' : ''}`;
        
        try {
          await open(url);
          appendTranscript(<Text color="green">✓ Opening the {pageName} in your browser...</Text>);
        } catch {
          appendTranscript(<Text color="yellow">✓ Could not open browser. Here is the link for the {pageName}:{"\n"}{url}</Text>);
        }
      } else {
        appendTranscript(<Text color="red">Error: Could not generate login link.</Text>);
      }
      return;
    }

    appendTranscript(
      <Box flexDirection="column" marginBottom={1}>
        <Text color="blue" bold>👤 You:</Text>
        <Text>{userInput}</Text>
      </Box>
    );
    lastBlockRef.current = 'user';
    await processChatTurn(userInput);
  };

  // Global key handler for ESC and Ctrl+C. Avoid name shadowing with input state.
  useInput((char, key) => {
    if (key.escape) {
      exit();
    }
    
    if (key.ctrl && (char || '').toLowerCase() === 'c') {
      if (isProcessing) {
        // If processing, set the interruption flag and also exit immediately
        // to ensure the user can always interrupt, even with long responses
        isInterruptedRef.current = true;
        appendTranscript(<Text color="yellow">✗ Response interrupted by user.</Text>);
        setIsProcessing(false);
      } else {
        // If not processing, Ctrl+C should exit the app as expected.
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Static items={staticItems as React.ReactNode[]}>
          {(item, i) => <React.Fragment key={i}>{item}</React.Fragment>}
        </Static>
      </Box>

      {isProcessing && showLivePreview && (
        <Box flexDirection="column">
          {!headerCommittedRef.current && (
            <Text color="green" bold>🤖 Fry:</Text>
          )}
          <Text>{livePreview}</Text>
        </Box>
      )}

      {!isProcessing && (
        <ChatPrompt
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
        />
      )}
  
      <Box marginTop={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text dimColor>Commands: /dashboard, /buy, /clear</Text>
          <Text dimColor>Ctrl + C to interrupt</Text>
        </Box>
        {rateLimitStatus && (
          <Box flexDirection="column" alignItems="flex-end">
            <Text dimColor>Tool Calls: {rateLimitStatus.remaining}</Text>
            <Text dimColor>
              (resets in {Math.floor(rateLimitStatus.reset_in_seconds / 3600)}h {Math.ceil((rateLimitStatus.reset_in_seconds % 3600) / 60)}m)
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

// Separated to attach its own focus handling cleanly
const ChatPrompt: React.FC<{ value: string; onChange: (v: string) => void; onSubmit: (v: string) => void }> = ({ value, onChange, onSubmit }) => {
  const { isFocused } = useFocus({ autoFocus: true, isActive: true });
  return (
    <Box>
      <Text color="blue" bold>👤 You: </Text>
      <TextInput focus={isFocused} value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
};

// Endpoint Selection Component
const EndpointSelector: React.FC<{ onSelect: (url: string) => void }> = ({ onSelect }) => {
  const presets = [
    { label: '(1) Ollama (http://localhost:11434/v1)', value: 'http://localhost:11434/v1' },
    { label: '(2) vLLM (http://localhost:8000/v1)', value: 'http://localhost:8000/v1' },
    { label: '(3) LM Studio (http://localhost:1234/v1)', value: 'http://localhost:1234/v1' },
    { label: '(4) llama.cpp (http://localhost:8080/v1)', value: 'http://localhost:8080/v1' },
    { label: '(5) Custom URL', value: 'custom' }
  ];

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const { isFocused: urlInputFocused } = useFocus({ autoFocus: true, isActive: showCustomInput });

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
        <TextInput focus={urlInputFocused} value={customUrl} onChange={setCustomUrl} onSubmit={handleCustomSubmit} />
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

// Config for .env file
const ENV_DIR = path.join(os.homedir(), '.gpt-oss-client');
const ENV_PATH = path.join(ENV_DIR, '.env');

const saveApiKeyToEnv = async (key: string) => {
  try {
    await fs.mkdir(ENV_DIR, { recursive: true });
    await fs.writeFile(ENV_PATH, `GPT_OSS_API_KEY=${key}\n`);
  } catch (error) {
    // Silently fail, user can still proceed
  }
};

const loadApiKeyFromEnv = async (): Promise<string | null> => {
  try {
    const content = await fs.readFile(ENV_PATH, 'utf-8');
    const match = content.match(/^GPT_OSS_API_KEY=(.*)$/m);
    return match ? match[1].trim() : null;
  } catch (error) {
    return null;
  }
};

// API Key Input Component
const ApiKeyInput: React.FC<{ backendUrl: string; onAuthenticated: (sessionResponse: any, apiKey: string) => void }> = ({ backendUrl, onAuthenticated }) => {
  const [apiKey, setApiKey] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isFocused: apiKeyFocused } = useFocus({ autoFocus: true, isActive: true });

  useEffect(() => {
    const findAndAuthKey = async () => {
      // Check for API key in environment or .env file
      const envKey = process.env.GPT_OSS_API_KEY || await loadApiKeyFromEnv();
      if (envKey) {
        authenticateWithKey(envKey);
      }
    };
    findAndAuthKey();
  }, []);

  const authenticateWithKey = async (key: string) => {
    setIsAuthenticating(true);
    setError(null);

    const client = new GptOssApiClient(backendUrl, key);
    const sessionResponse = await client.startSession();

    if (sessionResponse) {
      await saveApiKeyToEnv(key);
      onAuthenticated(sessionResponse, key);
    } else {
      setError('Invalid or expired API key.');
      setIsAuthenticating(false);
    }
  };

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      authenticateWithKey(value.trim());
    }
  };

  if (isAuthenticating) {
    return <LoadingIndicator text="Authenticating..." />;
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>FryCLI API Key Required</Text>
      <Text>Generate an API key from: {backendUrl}/dashboard</Text>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1}>
        <Text>Enter API key: </Text>
        <TextInput focus={apiKeyFocused} value={apiKey} onChange={setApiKey} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
};

// Main App Component
const App: React.FC<{ backendUrl: string; modelName: string; streamChunks: boolean; streamIntervalMs: number; previewLines: number; streamMode: 'append' | 'preview' }> = ({ backendUrl, modelName, streamChunks, streamIntervalMs, previewLines, streamMode }) => {
  const [stage, setStage] = useState<'endpoint' | 'auth' | 'chat'>('endpoint');
  const [modelEndpoint, setModelEndpoint] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [initialRateLimit, setInitialRateLimit] = useState<RateLimitStatus | null>(null);

  const handleEndpointSelect = (url: string) => {
    setModelEndpoint(url);
    setStage('auth');
  };

  const handleAuthenticated = (sessionResponse: any, key: string) => {
    const sessionInfo: SessionData = {
        session_id: sessionResponse.session_id,
        tier: sessionResponse.tier
    };
    setSessionData(sessionInfo);
    setApiKey(key);
    if (sessionResponse.rate_limit_status) {
        setInitialRateLimit(sessionResponse.rate_limit_status);
    }
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
      
      {stage === 'auth' && (
        <ApiKeyInput backendUrl={backendUrl} onAuthenticated={handleAuthenticated} />
      )}
      
      {stage === 'chat' && sessionData && apiKey && modelEndpoint && (
        <ChatInterface
          client={new GptOssApiClient(backendUrl, apiKey)}
          sessionData={sessionData}
          modelEndpoint={modelEndpoint}
          modelName={modelName}
          initialRateLimitStatus={initialRateLimit}
          streamChunks={streamChunks}
          streamIntervalMs={streamIntervalMs}
          streamMode={streamMode}
          previewMaxLines={previewLines}
          onResetSession={(data) => {
            setSessionData(data);
            // Reset initial rate limit display; ChatInterface also tracks its own status
            setInitialRateLimit(null);
          }}
        />
      )}
    </Box>
  );
};

const cli = meow(`
  Usage
    $ frycli

  Options
    --backend, -b  Backend URL (default: https://frycli.share.zrok.io)
    --model, -m    Model name (default: gpt-4)
    --stream, -s   Stream assistant output as tokens arrive (default: true)
    --stream-interval  Interval in ms for streaming chunks; set to 0 for flush-on-every-delta (default: 100)
    --preview-lines, -p  Max lines shown in live preview while streaming (0 = unlimited, default: 0)
    --stream-mode       Streaming mode: 'append' or 'preview' (default: 'preview')
    --no-update     Skip automatic update check

  Examples
    $ frycli --backend http://localhost:8000 --model llama2
`, {
  importMeta: import.meta,
  flags: {
    backend: {
      type: 'string',
      shortFlag: 'b',
      default: 'https://frycli.share.zrok.io'
    },
    model: {
      type: 'string',
      shortFlag: 'm',
      default: 'gpt-4'
    },
    stream: {
      type: 'boolean',
      shortFlag: 's',
      default: true
    },
    streamInterval: {
      type: 'number',
      default: 0
    },
    streamMode: {
      type: 'string',
      default: 'preview'
    },
    previewLines: {
      type: 'number',
      shortFlag: 'p',
      default: 0
    },
    noUpdate: {
      type: 'boolean',
      default: false
    }
  }
});

// Load environment variables from project .env (if it exists)
dotenv.config();

// Attempt a quick self-update (non-blocking beyond a short timeout)
await maybeSelfUpdate({ skip: Boolean(cli.flags.noUpdate), timeoutMs: 15000 });

// Render the app
render(
  <App
    backendUrl={cli.flags.backend}
    modelName={cli.flags.model}
    streamChunks={Boolean(cli.flags.stream)}
    streamIntervalMs={Number.isFinite(cli.flags.streamInterval) ? Number(cli.flags.streamInterval) : 0}
    previewLines={Number.isFinite(cli.flags.previewLines) ? Number(cli.flags.previewLines) : 0}
    streamMode={(cli.flags.streamMode === 'append' ? 'append' : 'preview')}
  />,
  { exitOnCtrlC: false }
);
