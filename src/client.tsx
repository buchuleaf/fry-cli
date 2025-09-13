#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef } from 'react';
import { render, Text, Box, useInput, useApp, Static } from 'ink';
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
interface SessionData { session_id: string; tier: 'free' | 'premium'; }
interface RateLimitStatus { remaining: number; reset_in_seconds: number; }
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

// ===== API Client =====
class GptOssApiClient {
  private backendUrl: string;
  private apiKey: string;
  private axios: AxiosInstance;
  constructor(backendUrl: string, apiKey: string) {
    this.backendUrl = backendUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.axios = axios.create({
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 15000
    });
  }
  async startSession(): Promise<any | null> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/start_session`);
      if (response.status === 200) return response.data;
      return null;
    } catch { return null; }
  }
  async sendWorkspaceContents(sessionId: string, contents: string): Promise<boolean> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/workspace_contents`, {
        session_id: sessionId, contents
      });
      return response.status === 200;
    } catch { return false; }
  }
  async prepareChatTurn(sessionId: string, newMessages: Message[]): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/prepare_chat_turn`, {
      session_id: sessionId, new_messages: newMessages
    });
    return response.data;
  }
  async orchestrateToolCall(sessionId: string, toolCall: ToolCall): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/orchestrate_tool_call`, {
      session_id: sessionId, tool_call: toolCall
    });
    return response.data;
  }
  async trackToolCall(sessionId: string, toolCall: ToolCall): Promise<any> {
    const response = await this.axios.post(`${this.backendUrl}/track_tool_call`, {
      session_id: sessionId, tool_call: toolCall
    });
    return response.data;
  }
  async generateLoginLink(): Promise<string | null> {
    try {
      const response = await this.axios.post(`${this.backendUrl}/generate_login_link`);
      return response.data.token || null;
    } catch { return null; }
  }
}

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
  client: GptOssApiClient;
  sessionData: SessionData;
  modelEndpoint: string;
  modelName: string;
  initialRateLimitStatus: RateLimitStatus | null;
  onResetSession: (data: SessionData) => void;
  streamChunks: boolean;
  streamIntervalMs: number;
}> = ({
  client,
  sessionData,
  modelEndpoint,
  modelName,
  initialRateLimitStatus,
  onResetSession,
  streamIntervalMs,
}) => {
  const { exit } = useApp();
  // Let Ink manage raw mode internally for better Windows compatibility

  const [input, setInput] = useState('');
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus | null>(initialRateLimitStatus);
  const isInterruptedRef = useRef(false);
  const LIVE_TAIL_LINES = 40; // limit live area size to reduce terminal jank

  // Streaming now uses a live-updating area; finalized output is appended once

  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({ baseURL: modelEndpoint, apiKey: 'dummy' }));
  const conversationHistory = useRef<Message[]>([]);
  const turnMessages = useRef<Message[]>([]);

  const appendTranscript = (node: TranscriptItem) => setStaticItems(prev => [...prev, node]);
  const [liveAssistant, setLiveAssistant] = useState<string>('');
  const lastBlockRef = useRef<'assistant' | 'tool' | 'user' | 'system' | 'other' | null>(null);

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

    // Execute (local preferred, with tracking)
    let result: ToolResult;
    try {
      if (toolName === 'workspace' || toolName === 'exec' || toolName.startsWith('fs.') || toolName === 'python' || toolName === 'shell' || toolName === 'apply_patch') {
        const trackResponse = await client.trackToolCall(sessionData.session_id, toolCall);
        if (trackResponse?.rate_limit_status) setRateLimitStatus(trackResponse.rate_limit_status);
        result = await localExecutor.current.execute(toolCall);
      } else {
        const orchestrationData = await client.orchestrateToolCall(sessionData.session_id, toolCall);
        result = orchestrationData.result || { status: 'error', data: 'Invalid response from backend.' };
        if (orchestrationData?.rate_limit_status) setRateLimitStatus(orchestrationData.rate_limit_status);
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        result = { status: 'error', data: error.response.data?.error || 'Rate limit exceeded.' };
        if (error.response.data?.rate_limit_status) setRateLimitStatus(error.response.data.rate_limit_status);
      } else {
        result = { status: 'error', data: `Tool failed: ${error?.message || String(error)}` };
      }
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
    setLiveAssistant('');
    
    let accumulatedOutput = ''; // Accumulator for the current streamed assistant message

    conversationHistory.current.push({ role: 'user', content: userInput });
    turnMessages.current = [{ role: 'user', content: userInput }];

    let lastRenderTime = Date.now();

    try { // Wrap main logic in try/finally to ensure cleanup
      const rootListing = await getRootDirectoryListing();
      await client.sendWorkspaceContents(sessionData.session_id, rootListing);

      const backendData = await client.prepareChatTurn(sessionData.session_id, conversationHistory.current);
      const messagesForLlm: any[] = backendData.messages || [];
      const toolsForLlm = backendData.tools || [];

      // === Stream assistant ===
      while (true) {
        if (isInterruptedRef.current) break;

        // Reset accumulator and live area for each assistant streaming cycle
        accumulatedOutput = '';
        setLiveAssistant('');

        // Throttled state updates for live area
        let chunkBuffer = '';
        const flushChunk = (force = false) => {
          const now = Date.now();
          const shouldFlushTime = now - lastRenderTime >= streamIntervalMs;
          const shouldFlushSize = chunkBuffer.length >= 512;
          if (!force && !(shouldFlushTime || shouldFlushSize)) return;
          setLiveAssistant(accumulatedOutput);
          chunkBuffer = '';
          lastRenderTime = now;
        };

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
          extra_body: { add_generation_prompt: true, builtin_tools: builtinToolsKw }
        });

        const toolAssembler: Map<number, ToolCall> = new Map();
        const toolCalls: ToolCall[] = [];

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
          }

          if (delta.content) {
            const piece = delta.content;
            accumulatedOutput += piece;
            chunkBuffer += piece;
            flushChunk(false);
          }
        }

        // Final flush and append finalized assistant message once
        flushChunk(true);
        setLiveAssistant('');

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

        // Append finalized assistant message exactly once to the transcript
        if (assistantMessage.content && assistantMessage.content.length > 0) {
          appendTranscript(
            <Box flexDirection="column" marginBottom={1}>
              <Text color="green" bold>🤖 Fry: </Text>
              <StreamingMarkdown content={assistantMessage.content} />
            </Box>
          );
        }

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
        if (liveAssistant && liveAssistant.trim().length > 0) {
          appendTranscript(
            <Box flexDirection="column" marginBottom={1}>
              <Text color="green" bold>🤖 Fry (partial): </Text>
              <StreamingMarkdown content={liveAssistant} />
            </Box>
          );
        }
        setLiveAssistant('');
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

        // Clear live area (if any)
        setLiveAssistant('');

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
          setStaticItems([]); // Clear the visual transcript
          appendTranscript(
            <Box marginBottom={1}>
              <Text color="cyan" bold>FryCLI</Text>
              <Text> | Session: {newSessionInfo.session_id.substring(0, 8)}... | </Text>
              <Text color={newSessionInfo.tier === 'premium' ? 'green' : 'yellow'} bold>
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
        const url = `${(client as any)['backendUrl']}/login_with_token/${token}${isCheckout ? '?next=checkout' : ''}`;
        
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

    // /key <NEW_KEY> support to swap keys mid-session
    if (userInput.toLowerCase().startsWith('/key')) {
      const parts = userInput.split(/\s+/);
      const maybeKey = parts.slice(1).join(' ').trim();
      if (!maybeKey) {
        appendTranscript(<Text color="yellow">Usage: /key &lt;NEW_API_KEY&gt; — key will be saved and used for the next session started with /clear.</Text>);
        return;
      }
      try {
        await saveApiKeyToEnv(maybeKey);
        appendTranscript(
          <Box>
            <Text color="green">✓ API key saved. Use </Text>
            <Text color="blue">/clear</Text>
            <Text color="green"> to start a new session with the updated key.</Text>
          </Box>
        );
      } catch {
        appendTranscript(<Text color="red">Error: Failed to save API key. You can also set GPT_OSS_API_KEY in {ENV_PATH}</Text>);
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

      {isProcessing && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green" bold>🤖 Fry: </Text>
          {/* Render only the tail to minimize per-frame terminal updates */}
          <Text>
            {(() => {
              const lines = (liveAssistant || '').split('\n');
              const start = Math.max(0, lines.length - LIVE_TAIL_LINES);
              const tail = lines.slice(start).join('\n');
              return tail;
            })()}
          </Text>
          {liveAssistant.split('\n').length > LIVE_TAIL_LINES && (
            <Text dimColor>{`(showing last ${LIVE_TAIL_LINES} lines...)`}</Text>
          )}
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
          <Text dimColor>Shift+Enter for newline, Enter to submit</Text>
          <Text dimColor>Commands: /dashboard, /buy, /clear, /key, /exit</Text>
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
    { label: '(5) Custom URL', value: 'custom' }
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

const ENV_DIR = path.join(os.homedir(), '.gpt-oss-client');
const ENV_PATH = path.join(ENV_DIR, '.env');

const saveApiKeyToEnv = async (key: string) => {
  try {
    await fs.mkdir(ENV_DIR, { recursive: true });
    await fs.writeFile(ENV_PATH, `GPT_OSS_API_KEY=${key}\n`);
  } catch (error) {
    // Silently fail
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

const ApiKeyInput: React.FC<{ backendUrl: string; onAuthenticated: (sessionResponse: any, apiKey: string) => void }> = ({ backendUrl, onAuthenticated }) => {
  const [apiKey, setApiKey] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const findAndAuthKey = async () => {
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
        <ChatPrompt value={apiKey} onChange={setApiKey} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
};

const App: React.FC<{ backendUrl: string; modelName: string; streamChunks: boolean; streamIntervalMs: number; }> = ({ backendUrl, modelName, streamChunks, streamIntervalMs }) => {
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
          onResetSession={(data) => {
            setSessionData(data);
            setInitialRateLimit(null);
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

dotenv.config();

(async () => {
  await maybeSelfUpdate({ skip: !cli.flags.update });

  const backendUrl = 'https://frycli.share.zrok.io';
  const modelName = cli.flags.model || process.env.FRY_MODEL_NAME || 'llama';

  render(
    <App
      backendUrl={backendUrl}
      modelName={modelName}
      streamChunks={true}
      streamIntervalMs={60}
    />,
    { exitOnCtrlC: false }
  );
})();
