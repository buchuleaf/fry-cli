#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useRef } from 'react';
import { render, Text, Box, useInput, useApp, Static, useStdin, useFocus } from 'ink';
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

const SHOW_ANALYSIS_BLOCK = true;

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
try {
  const width = Math.max(40, Math.min(process.stdout?.columns || 80, 120));
  marked.use((markedTerminal as any)({
    reflowText: false,
    width,
    tab: 2,
    unescape: true
  }));
} catch {}
const MarkdownBlock: React.FC<{ content: string }> = React.memo(({ content }) => {
  const md = content ?? '';
  let out = md;
  try {
    out = String(marked.parse(md));
  } catch {
    out = md;
  }
  const inputEndsWithNl = /\r?\n$/.test(md);
  if (inputEndsWithNl) out = out.replace(/\n+$/g, '\n');
  else out = out.replace(/\n+$/g, '');
  return <Text>{out}</Text>;
});

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

// ===== Harmony helpers =====
function balancedMarkdown(md: string): string {
  let marker: '```' | '~~~' | null = null;
  const lines = (md || '').split('\n');
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
}
// Extract the last final block (no tags)
function extractHarmonyFinal(text: string): string {
  if (typeof text !== 'string') return '';
  const pattern = /<\|channel\|>final(?:\s+[a-zA-Z]+)?<\|message\|>/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) lastEnd = pattern.lastIndex;
  if (lastEnd === -1) return text;
  const endReturn = text.indexOf('<|return|>', lastEnd);
  const endEnd = text.indexOf('<|end|>', lastEnd);
  const candidates = [endReturn, endEnd].filter(i => i >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : text.length;
  return text.slice(lastEnd, end);
}
// Extract latest analysis before a tool call (no tags)
function extractHarmonyAnalysis(text: string): string {
  if (typeof text !== 'string') return '';
  const callIdx = text.indexOf('<|call|>');
  const searchEnd = callIdx >= 0 ? callIdx : text.length;
  const pattern = /<\|channel\|>analysis(?:\s+[a-zA-Z]+)?<\|message\|>/g;
  let lastHeaderEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (pattern.lastIndex <= searchEnd) lastHeaderEnd = pattern.lastIndex; else break;
  }
  if (lastHeaderEnd === -1) {
    const raw = text.slice(0, searchEnd);
    return raw.replaceAll('<|start|>', '').replaceAll('<|end|>', '').replaceAll('<|message|>', '');
  }
  const endIdx = text.indexOf('<|end|>', lastHeaderEnd);
  const sliceEnd = (endIdx >= 0 && endIdx <= searchEnd) ? endIdx : searchEnd;
  return text.slice(lastHeaderEnd, sliceEnd);
}

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
  streamChunks,
  streamIntervalMs,
}) => {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();

  const [input, setInput] = useState('');
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus | null>(initialRateLimitStatus);
  const isInterruptedRef = useRef(false);

  const localExecutor = useRef(new LocalToolExecutor());
  const openaiClient = useRef(new OpenAI({ baseURL: modelEndpoint, apiKey: 'dummy' }));
  const conversationHistory = useRef<Message[]>([]);
  const turnMessages = useRef<Message[]>([]);

  const appendTranscript = (node: TranscriptItem) => setStaticItems(prev => [...prev, node]);
  const lastBlockRef = useRef<'assistant' | 'tool' | 'user' | 'system' | 'other' | null>(null);

  // Live preview state
  const [livePreview, setLivePreview] = useState<string>('');
  const [showLivePreview, setShowLivePreview] = useState<boolean>(false);
  const liveAssistantContentRef = useRef<string>('');
  const openFenceRef = useRef<'```' | '~~~' | null>(null);
  const headerCommittedRef = useRef<boolean>(false);
  const pendingRef = useRef<string>('');
  const lastFlushedLengthRef = useRef<number>(0);
  const consumedUpToRef = useRef<number>(0);

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

  useEffect(() => {
    try {
      if (process.platform === 'win32' && isRawModeSupported) {
        setRawMode(true);
        return () => { try { setRawMode(false); } catch {} };
      }
    } catch {}
  }, [isRawModeSupported, setRawMode]);

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
      <Box marginTop={lastBlockRef.current === 'assistant' ? 1 : 0}>
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

    // Render result
    let resultRaw: any = result?.data;
    let resultText = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw, null, 2);
    if (resultText === undefined || resultText === null) {
      try { resultText = String(resultRaw ?? ''); } catch { resultText = ''; }
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
    conversationHistory.current.push({ role: 'user', content: userInput });
    turnMessages.current = [{ role: 'user', content: userInput }];

    try {
      const rootListing = await getRootDirectoryListing();
      await client.sendWorkspaceContents(sessionData.session_id, rootListing);

      const backendData = await client.prepareChatTurn(sessionData.session_id, conversationHistory.current);
      const messagesForLlm = backendData.messages || [];
      const toolsForLlm = backendData.tools || [];

      // === Stream assistant ===
      while (true) {
        if (isInterruptedRef.current) break;

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

        // Reset per-turn streaming state
        liveAssistantContentRef.current = '';
        openFenceRef.current = null;
        headerCommittedRef.current = false;
        pendingRef.current = '';
        lastFlushedLengthRef.current = 0;
        consumedUpToRef.current = 0;

        let assistantContent = '';
        const toolAssembler: Map<number, ToolCall> = new Map();
        const toolCalls: ToolCall[] = [];
        let lastFlushTime = 0;
        let lastYieldTime = Date.now();

        const updateFenceStateFrom = (rawChunk: string) => {
          const lines = (rawChunk || '').split('\n');
          for (const line of lines) {
            const m = line.match(/^\s*(```|~~~)/);
            if (m) {
              const cur = m[1] as '```' | '~~~';
              if (!openFenceRef.current) openFenceRef.current = cur;
              else if (openFenceRef.current === cur) openFenceRef.current = null;
            }
          }
        };
        const wrapChunkForDisplay = (rawChunk: string): string => {
          const startFence = openFenceRef.current;
          const prefix = startFence ? `${startFence}\n` : '';
          return balancedMarkdown(prefix + rawChunk);
        };

        for await (const chunk of stream) {
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
            assistantContent += delta.content;
            const updated = liveAssistantContentRef.current + delta.content;
            liveAssistantContentRef.current = updated;

            if (streamChunks) {
              const now = Date.now();
              const shouldUpdate = (streamIntervalMs ?? 0) <= 0 || (now - lastFlushTime >= streamIntervalMs);
              if (shouldUpdate) {
                const full = liveAssistantContentRef.current;
                const consumed = consumedUpToRef.current;
                if (full.length > consumed) {
                  pendingRef.current += full.slice(consumed);
                  consumedUpToRef.current = full.length;
                }
                let p = pendingRef.current;

                const idx = Math.max(p.lastIndexOf('\n'), p.lastIndexOf('\r'));
                if (idx >= 0) {
                  const complete = p.slice(0, idx + 1);
                  const disp = wrapChunkForDisplay(complete);
                  if (!headerCommittedRef.current) {
                    appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
                    headerCommittedRef.current = true;
                  }
                  appendTranscript(<Box><MarkdownBlock content={disp} /></Box>);
                  lastBlockRef.current = 'assistant';
                  lastFlushedLengthRef.current += complete.length;
                  pendingRef.current = p.slice(idx + 1);
                  updateFenceStateFrom(complete);
                  p = pendingRef.current;
                }
                if (p.length > 0) {
                  let disp = p;
                  if (lastFlushedLengthRef.current === 0) disp = disp.replace(/^(?:\r?\n)+/, '');
                  setLivePreview(disp);
                  setShowLivePreview(true);
                } else {
                  setShowLivePreview(false);
                  setLivePreview('');
                }
                lastFlushTime = now;
              }
            }

            const now = Date.now();
            if (now - lastYieldTime > 50) {
              await new Promise(resolve => setImmediate(resolve));
              lastYieldTime = now;
              if (isInterruptedRef.current) break;
            }
          }
        }

        toolCalls.push(...Array.from(toolAssembler.values()));
        for (const tc of toolCalls) {
          if (!tc.id || tc.id.length === 0) tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
        }
        if (toolCalls.length > 1) toolCalls.splice(1);

        const remainder = pendingRef.current;
        if (remainder.length > 0) {
          const display = wrapChunkForDisplay(remainder);
          if (!headerCommittedRef.current) {
            appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
            headerCommittedRef.current = true;
          }
          appendTranscript(<Box><MarkdownBlock content={display} /></Box>);
          lastBlockRef.current = 'assistant';
          pendingRef.current = '';
        }

        setShowLivePreview(false);
        setLivePreview('');
        liveAssistantContentRef.current = '';

        const finalOnly = (toolCalls.length > 0)
          ? extractHarmonyAnalysis(assistantContent)
          : extractHarmonyFinal(assistantContent);
        const assistantMessage: Message = { role: 'assistant' };
        if (finalOnly && finalOnly.trim().length > 0) assistantMessage.content = finalOnly;
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;

        turnMessages.current.push(assistantMessage);
        conversationHistory.current.push(assistantMessage);
        const assistantForLlm: any = { role: 'assistant' };
        if (assistantMessage.content) assistantForLlm.content = assistantMessage.content;
        if (assistantMessage.tool_calls) assistantForLlm.tool_calls = assistantMessage.tool_calls;
        (messagesForLlm as any[]).push(assistantForLlm);

        if (isInterruptedRef.current) break;

        if (toolCalls.length === 0) break;

        for (const toolCall of toolCalls) {
          const result = await executeToolCall(toolCall);
          const toolMessage: Message = {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(result)
          };
          turnMessages.current.push(toolMessage);
          (messagesForLlm as any[]).push(toolMessage);
          conversationHistory.current.push(toolMessage);
        }
      }
    } catch (error) {
      appendTranscript(<Text color="red">Error: {String(error)}</Text>);
    } finally {
      if (isInterruptedRef.current) {
        const p = pendingRef.current;
        if (p.length > 0) {
          const display = balancedMarkdown(p);
          if (!headerCommittedRef.current) {
            appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
            headerCommittedRef.current = true;
          }
          appendTranscript(<Box><MarkdownBlock content={display} /></Box>);
        }
        setShowLivePreview(false);
        setLivePreview('');
        liveAssistantContentRef.current = '';
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
        {(item, idx) => <Box key={idx}>{item}</Box>}
      </Static>

      {isProcessing && showLivePreview && (
        <Box> 
          {!headerCommittedRef.current && (
            <Text color="green" bold>🤖 Fry: </Text>
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

const ChatPrompt: React.FC<{ value: string; onChange: (v: string) => void; onSubmit: (v: string) => void }> = ({ value, onChange, onSubmit }) => {
  const { isFocused } = useFocus({ autoFocus: true, isActive: true });
  return (
    <Box>
      <Text color="blue" bold>👤 You: </Text>
      <TextInput focus={isFocused} value={value} onChange={onChange} onSubmit={onSubmit} />
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
  const { isFocused: apiKeyFocused } = useFocus({ autoFocus: true, isActive: true });

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
        <TextInput focus={apiKeyFocused} value={apiKey} onChange={setApiKey} onSubmit={handleSubmit} />
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

  const backendUrl = process.env.FRY_BACKEND_URL || 'https://frycli.share.zrok.io';
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