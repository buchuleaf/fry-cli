#!/usr/bin/env node
// client.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Text, Box, useInput, useApp, Newline, Spacer, useStdin, Static } from 'ink';
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
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

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

    // Attempt global update; do not block for long and ignore errors
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['i', '-g', `${pkgName}@latest`];
    // Print a brief notice before Ink renders
    console.log(`A new version of Fry CLI is available (${current} → ${latest}). Updating...`);
    const result = spawnSync(npmCmd, args, {
      stdio: 'ignore',
      timeout: opts?.timeoutMs ?? 15000
    });
    if (result.error) {
      console.log('Auto-update skipped (npm not available or permission denied).');
    } else if (result.status !== 0) {
      console.log('Auto-update failed (non-zero exit). Continuing with current version.');
    } else {
      console.log('Fry CLI updated successfully. You may need to re-run to use the new version.');
    }
  } catch {
    // Swallow any unexpected errors to avoid impacting CLI usage
  }
}

// Lightweight Markdown renderer for single lines, streaming-friendly (no external deps)
const MarkdownLine: React.FC<{ content: string; inCodeBlock?: boolean }> = React.memo(({ content, inCodeBlock }) => {
  const line = content ?? '';

  // Code block fence (```)
  const isFence = /^\s*```/.test(line);
  if (isFence) {
    return <Text dimColor>{line}</Text>;
  }

  // Inside fenced code block: render as code without parsing inline
  if (inCodeBlock) {
    return <Text color="cyan">{line}</Text>;
  }

  // Headings: style entire line
  if (/^\s*#{1,6}\s+/.test(line)) {
    return <Text color="cyan" bold>{line}</Text>;
  }

  // Simple inline markdown tokenizer: `code`, **bold**, _italic_, [text](url)
  type Seg = { type: 'text'|'code'|'bold'|'italic'|'link'; text: string; url?: string };
  const segs: Seg[] = [];
  let i = 0;
  const s = line;
  const len = s.length;

  const pushText = (t: string) => { if (t) segs.push({ type: 'text', text: t }); };

  while (i < len) {
    const nextBacktick = s.indexOf('`', i);
    const nextBold = s.indexOf('**', i);
    const nextItal = s.indexOf('_', i);
    const nextLink = s.indexOf('[', i);

    // Choose the earliest token start
    let next = Number.POSITIVE_INFINITY;
    let kind: 'code'|'bold'|'italic'|'link'|null = null;
    if (nextBacktick !== -1 && nextBacktick < next) { next = nextBacktick; kind = 'code'; }
    if (nextBold !== -1 && nextBold < next) { next = nextBold; kind = 'bold'; }
    if (nextItal !== -1 && nextItal < next) { next = nextItal; kind = 'italic'; }
    if (nextLink !== -1 && nextLink < next) { next = nextLink; kind = 'link'; }

    if (kind === null) {
      pushText(s.slice(i));
      break;
    }

    // Emit preceding text
    if (next > i) pushText(s.slice(i, next));

    if (kind === 'code') {
      const end = s.indexOf('`', next + 1);
      if (end !== -1) {
        segs.push({ type: 'code', text: s.slice(next + 1, end) });
        i = end + 1;
      } else {
        // No closing; treat as literal
        pushText(s.slice(next));
        break;
      }
      continue;
    }

    if (kind === 'bold') {
      const end = s.indexOf('**', next + 2);
      if (end !== -1) {
        segs.push({ type: 'bold', text: s.slice(next + 2, end) });
        i = end + 2;
      } else {
        pushText(s.slice(next));
        break;
      }
      continue;
    }

    if (kind === 'italic') {
      const end = s.indexOf('_', next + 1);
      if (end !== -1) {
        segs.push({ type: 'italic', text: s.slice(next + 1, end) });
        i = end + 1;
      } else {
        pushText(s.slice(next));
        break;
      }
      continue;
    }

    if (kind === 'link') {
      const rb = s.indexOf(']', next + 1);
      const lp = rb !== -1 ? s.indexOf('(', rb + 1) : -1;
      const rp = lp !== -1 ? s.indexOf(')', lp + 1) : -1;
      if (rb !== -1 && lp === rb + 1 && rp !== -1) {
        const label = s.slice(next + 1, rb);
        const url = s.slice(lp + 1, rp);
        segs.push({ type: 'link', text: label, url });
        i = rp + 1;
      } else {
        pushText(s.slice(next));
        break;
      }
      continue;
    }
  }

  return (
    <Text>
      {segs.map((seg, idx) => {
        if (seg.type === 'text') return <Text key={idx}>{seg.text}</Text>;
        if (seg.type === 'code') return <Text key={idx} color="cyan">{seg.text}</Text>;
        if (seg.type === 'bold') return <Text key={idx} bold>{seg.text}</Text>;
        if (seg.type === 'italic') return <Text key={idx} italic>{seg.text}</Text>;
        if (seg.type === 'link') return <Text key={idx}><Text color="blue" underline>{seg.text}</Text><Text dimColor>{` (${seg.url})`}</Text></Text>;
        return <Text key={idx}>{seg.text}</Text>;
      })}
    </Text>
  );
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
  // Optional chain-of-thought field (not displayed). Used to help prompt rendering on backend.
  thinking?: string;
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
          <MarkdownLine content={msg.content || ''} />
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
  showAnalysis: boolean;
}> = ({ client, sessionData, modelEndpoint, modelName, initialRateLimitStatus, onResetSession, showAnalysis }) => {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  // Append-only transcript using Ink's <Static> for scroll stability
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Streaming state: we stream directly into transcript without a final commit
  const [isAssistantStreaming, setIsAssistantStreaming] = useState(false);
  // Display tool execution as committed log entries instead of dynamic state
  const [rateLimitStatus, setRateLimitStatus] = useState<RateLimitStatus | null>(initialRateLimitStatus);
  const isInterruptedRef = useRef(false);
  // Removed thinking timer to reduce re-renders during streaming
  
  const localExecutor = useRef(new LocalToolExecutor());
  // Track line counts of chunks per tool_call_id for fs.read/fs.read_chunk
  const readChunkLineCountsRef = useRef<Map<string, Map<number, number>>>(new Map());
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Streaming state: live content + header tracking
  const [liveAssistantContent, setLiveAssistantContent] = useState<string>('');
  const liveAssistantContentRef = useRef<string>('');
  const assistantHeaderAppendedRef = useRef<boolean>(false);
  const assistantInCodeBlockRef = useRef<boolean>(false);
  useEffect(() => { liveAssistantContentRef.current = liveAssistantContent; }, [liveAssistantContent]);

  const executeToolCall = async (toolCall: ToolCall): Promise<ToolResult> => {
    const toolName = toolCall.function.name;
    
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
        <Box>
          <Text color="yellow">🔧 Executing: </Text>
          <Text color="cyan" bold>{toolName}({argsStr})</Text>
        </Box>
      );
    } catch {
      appendTranscript(
        <Box>
          <Text color="yellow">🔧 Executing: </Text>
          <Text color="cyan" bold>{toolName}(...) </Text>
        </Box>
      );
    }

    let result: ToolResult;

    if (toolName.startsWith('fs.') || toolName === 'python' || toolName === 'shell' || toolName === 'apply_patch') {
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
    let resultText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);

    // Add line numbers when reading file content
    const isReadTool = toolName === 'fs.read' || toolName === 'fs.read_chunk';
    const isLargeOutputNotice = typeof result.data === 'string' && resultText.startsWith('Output is too large');
    if (isReadTool && !isLargeOutputNotice) {
      // fs.read (small files) or fs.read_chunk (single chunk). For fs.read_chunk,
      // keep numbering continuous by using stored counts for earlier chunks.
      const lines = resultText.split('\n');
      let startLine = 1;
      if (toolName === 'fs.read_chunk') {
        // Parse call args to find tool_call_id and chunk index
        try {
          const argsObj = JSON.parse(toolCall.function.arguments || '{}');
          const callId: string | undefined = argsObj.tool_call_id;
          const chunkIdx: number = typeof argsObj.chunk === 'number' ? argsObj.chunk : 0;
          if (callId) {
            const countsMap = readChunkLineCountsRef.current.get(callId);
            if (countsMap && chunkIdx > 0) {
              // Sum known counts of prior chunks; only adjust if all are known
              let sum = 0;
              let allKnown = true;
              for (let i = 0; i < chunkIdx; i++) {
                const c = countsMap.get(i);
                if (typeof c === 'number') sum += c; else { allKnown = false; break; }
              }
              if (allKnown) startLine = 1 + sum;
            }
            // Record current chunk's line count
            let mapForCall = countsMap;
            if (!mapForCall) {
              mapForCall = new Map();
              readChunkLineCountsRef.current.set(callId, mapForCall);
            }
            mapForCall.set(chunkIdx, lines.length);
          }
        } catch {}
      }
      const width = String(startLine + lines.length - 1).length;
      resultText = lines
        .map((line, idx) => `${String(startLine + idx).padStart(width, ' ')} | ${line}`)
        .join('\n');
    } else if (isReadTool && isLargeOutputNotice) {
      // For large outputs, we include the first chunk inline after a label.
      // Add line numbers to that preview portion only, keeping the header untouched.
      const firstChunkLabelIdx = resultText.indexOf('First chunk (');
      if (firstChunkLabelIdx !== -1) {
        const afterLabelNl = resultText.indexOf('\n', firstChunkLabelIdx);
        if (afterLabelNl !== -1) {
          const headerPart = resultText.slice(0, firstChunkLabelIdx);
          const labelLine = resultText.slice(firstChunkLabelIdx, afterLabelNl); // without trailing \n
          const preview = resultText.slice(afterLabelNl + 1);
          const lines = preview.split('\n');
          // Store count for chunk 0 under this tool_call_id so that subsequent
          // fs.read_chunk calls can continue line numbering.
          try {
            const argsObj = JSON.parse(toolCall.function.arguments || '{}');
            const callId: string | undefined = toolCall.id; // initial fs.read's own id
            if (callId) {
              let mapForCall = readChunkLineCountsRef.current.get(callId);
              if (!mapForCall) {
                mapForCall = new Map();
                readChunkLineCountsRef.current.set(callId, mapForCall);
              }
              mapForCall.set(0, lines.length);
            }
          } catch {}
          const width = String(lines.length).length;
          const numbered = lines
            .map((line, idx) => `${String(idx + 1).padStart(width, ' ')} | ${line}`)
            .join('\n');

          resultText = `${headerPart}${labelLine}\n${numbered}`;
        }
      }
    }

    // Indent each line of the result for clearer hierarchy
    const indented = resultText
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');

    appendTranscript(
      <Box flexDirection="column">
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
    // Accumulate reasoning across tool-call loops until a final message is produced
    let accumulatedReasoning = '';
    
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
        // Ensure the server-side Harmony template appends an assistant generation prompt
        // after the provided messages (especially after tool outputs). Many Harmony-enabled
        // servers honor `add_generation_prompt` in the request body.
        const stream = await (openaiClient.current.chat.completions as any).create({
          model: modelName,
          messages: messagesForLlm,
          tools: toolsForLlm,
          tool_choice: 'auto',
          stream: true,
          // Request that the server include reasoning tokens in the stream
          extra_body: { add_generation_prompt: true, reasoning: { exclude: false } }
        });

        // Begin assistant stream; render a header line and stream append-only chunks
        setIsAssistantStreaming(true);
        // No thinking timer; keep UI steady

        // Initialize per-token streaming state
        assistantHeaderAppendedRef.current = false;
        assistantInCodeBlockRef.current = false;
        setLiveAssistantContent('');
        liveAssistantContentRef.current = '';

        let assistantContent = '';
        let assistantReasoning = '';
        const toolCalls: ToolCall[] = [];
        const toolAssembler: Map<number, ToolCall> = new Map();
        // Fallback accumulator for servers that stream legacy function_call instead of tool_calls
        let legacyFunctionCallName = '';
        let legacyFunctionCallArgs = '';

        // Process chunks with periodic yielding to keep UI responsive
        let lastYieldTime = Date.now();
        let lastUiUpdate = 0;
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

          // Some OpenAI-compatible servers emit the older function_call field when using tools.
          // Accumulate it and later translate into a single tool_call entry if no tool_calls were provided.
          const legacy = (delta as any).function_call;
          if (legacy) {
            if (typeof legacy.name === 'string') legacyFunctionCallName += legacy.name;
            if (typeof legacy.arguments === 'string') legacyFunctionCallArgs += legacy.arguments;
          }

          if (delta.content) {
            assistantContent += delta.content;
            // Update live content
            const updated = liveAssistantContentRef.current + delta.content;
            liveAssistantContentRef.current = updated;
            setLiveAssistantContent(updated);
            // If we have any full lines, append them to static
            let buf = liveAssistantContentRef.current;
            let idx = buf.indexOf('\n');
            if (idx !== -1) {
              if (!assistantHeaderAppendedRef.current) {
                appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
                assistantHeaderAppendedRef.current = true;
              }
              while (idx !== -1) {
                const line = buf.slice(0, idx);
                const isFence = /^\s*```/.test(line);
                appendTranscript(<Box><MarkdownLine content={line} inCodeBlock={assistantInCodeBlockRef.current} /></Box>);
                if (isFence) {
                  assistantInCodeBlockRef.current = !assistantInCodeBlockRef.current;
                }
                buf = buf.slice(idx + 1);
                idx = buf.indexOf('\n');
              }
              liveAssistantContentRef.current = buf;
              setLiveAssistantContent(buf);
            }
            // Periodically yield to keep UI responsive
            const now = Date.now();
            if (now - lastYieldTime > 50) {
              await new Promise(resolve => setImmediate(resolve));
              lastYieldTime = now;
              if (isInterruptedRef.current) break;
            }
          }
          const rawReasoning: any = (delta as any).reasoning;
          if (rawReasoning) {
            let r = '';
            if (typeof rawReasoning === 'string') {
              r = rawReasoning;
            } else if (Array.isArray(rawReasoning)) {
              // Some servers may stream reasoning as an array of segments
              r = rawReasoning.map((seg: any) => seg?.text ?? '').join('');
            } else if (rawReasoning.content && Array.isArray(rawReasoning.content)) {
              r = rawReasoning.content.map((seg: any) => seg?.text ?? '').join('');
            }
            if (r) {
              assistantReasoning += r;
              // We do not stream analysis live to the display; it's logged after turn ends
            }
          }
        }

        toolCalls.push(...Array.from(toolAssembler.values()));
        // If no tool_calls were streamed but a legacy function_call was, convert it.
        if (toolCalls.length === 0 && (legacyFunctionCallName || legacyFunctionCallArgs)) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: legacyFunctionCallName || 'unknown',
              arguments: legacyFunctionCallArgs || '{}'
            }
          });
        }
        // toolCalls are assembled from delta.tool_calls only
        // Ensure each tool call has an id for tool message linking
        for (const tc of toolCalls) {
          if (!tc.id || tc.id.length === 0) {
            tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
          }
        }

        // This is the message that will be sent back to the backend in the next turn.
        // It must contain the RAW final content from the model (final channel tokens).
        const finalOnly = assistantContent;
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
          // Preserve analysis only for tool-call branches (not shown to the user)
          if (!assistantMessage.content && assistantReasoning) {
            accumulatedReasoning += assistantReasoning;
            assistantMessage.thinking = accumulatedReasoning;
          }
        }

        // End of stream; flush any remaining partial line to static
        if (liveAssistantContentRef.current.length > 0) {
          if (!assistantHeaderAppendedRef.current) {
            appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
            assistantHeaderAppendedRef.current = true;
          }
          appendTranscript(<Box><MarkdownLine content={liveAssistantContentRef.current} inCodeBlock={assistantInCodeBlockRef.current} /></Box>);
          liveAssistantContentRef.current = '';
          setLiveAssistantContent('');
        }
        setIsAssistantStreaming(false);

        turnMessages.current.push(assistantMessage);
        conversationHistory.current.push(assistantMessage);
        // Send only supported fields to the LLM
        const assistantMessageForLlm: any = { role: 'assistant' };
        if (assistantMessage.content) assistantMessageForLlm.content = assistantMessage.content;
        if (assistantMessage.tool_calls) assistantMessageForLlm.tool_calls = assistantMessage.tool_calls;
        // Per gpt-oss CoT guidance: include prior reasoning between tool calls
        if (toolCalls.length > 0 && accumulatedReasoning && accumulatedReasoning.trim().length > 0) {
          // OpenRouter-style reasoning field; include ALL analysis since last final
          assistantMessageForLlm.reasoning = {
            content: [
              { type: 'reasoning_text', text: accumulatedReasoning }
            ]
          };
        }
        messagesForLlm.push(assistantMessageForLlm);

        if (isInterruptedRef.current) break;
        // Optionally show the assistant's analysis (chain-of-thought) if present
        // This does not get sent back to the model; it's purely for user display.
        if (showAnalysis && assistantReasoning && assistantReasoning.trim().length > 0) {
          appendTranscript(
            <Box flexDirection="column">
              <Text color="magenta" bold>🧠 Analysis:</Text>
              <Text>{assistantReasoning}</Text>
            </Box>
          );
        }

        if (toolCalls.length === 0) {
          // Final answer produced; reset accumulated reasoning for next turn
          accumulatedReasoning = '';
          break;
        }

        // Execute tools
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
        // Flush partial line on interrupt
        if (liveAssistantContentRef.current.length > 0) {
          if (!assistantHeaderAppendedRef.current) {
            appendTranscript(<Box><Text color="green" bold>🤖 Fry:</Text></Box>);
            assistantHeaderAppendedRef.current = true;
          }
          appendTranscript(<Box><MarkdownLine content={liveAssistantContentRef.current} inCodeBlock={assistantInCodeBlockRef.current} /></Box>);
          liveAssistantContentRef.current = '';
          setLiveAssistantContent('');
        }
        appendTranscript(<Text color="yellow">✗ Response interrupted by user.</Text>);
      }
      // End of turn
      setIsAssistantStreaming(false);
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
        setIsAssistantStreaming(false);
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
      <Box flexDirection="column">
        <Text color="blue" bold>👤 You:</Text>
        <Text>{userInput}</Text>
      </Box>
    );
    await processChatTurn(userInput);
  };

  useInput((input, key) => {
    if (key.escape) {
      exit();
    }
    
    if (key.ctrl && input.toLowerCase() === 'c') {
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
          {(item, i) => <Box key={i}>{item}</Box>}
        </Static>
        {isAssistantStreaming && (
          <Box flexDirection="column">
            <Text color="green" bold>🤖 Fry:</Text>
            <MarkdownLine content={liveAssistantContent} inCodeBlock={assistantInCodeBlockRef.current} />
          </Box>
        )}
      </Box>

      {!isProcessing && (
        <Box>
          <Text color="blue" bold>👤 You: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        </Box>
      )}
  
      <Box marginTop={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Box>
            <Text dimColor>
              Commands: /dashboard, /buy, /clear{'\n'}
              Ctrl + C to interrupt
            </Text>
          </Box>
        </Box>
        {rateLimitStatus && (
          <Text dimColor>
            Tool Calls: {rateLimitStatus.remaining} {'\n'}
            (resets in{' '}
            {Math.floor(rateLimitStatus.reset_in_seconds / 3600)}h{' '}
            {Math.ceil((rateLimitStatus.reset_in_seconds % 3600) / 60)}m)
          </Text>
        )}
      </Box>
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
        <TextInput value={customUrl} onChange={setCustomUrl} onSubmit={handleCustomSubmit} />
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
        <TextInput value={apiKey} onChange={setApiKey} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
};

// Main App Component
const App: React.FC<{ backendUrl: string; modelName: string; showAnalysis: boolean }> = ({ backendUrl, modelName, showAnalysis }) => {
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
          showAnalysis={showAnalysis}
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
    --show-analysis, -a  Show chain-of-thought (default: true)
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
    showAnalysis: {
      type: 'boolean',
      shortFlag: 'a',
      default: true
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
    showAnalysis={Boolean(cli.flags.showAnalysis)}
  />,
  { exitOnCtrlC: false }
);
