#!/usr/bin/env node
// Minimal MCP server over stdio, exposing Fry CLI local tools
// Implements a subset of the Model Context Protocol sufficient for Open WebUI:
// - initialize
// - tools/list
// - tools/call
// - ping (optional)

import { LocalToolExecutor } from '../tools.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import * as path from 'path';

type Json = any;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Json;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
};

type Headers = Record<string, string>;

class StdioJsonRpc {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private onMessage: (msg: JsonRpcRequest) => void) {
    // Ensure stdin is in flowing mode and as bytes
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => this.onData(chunk));
    process.stdin.on('error', () => {/* ignore */});
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sepCRLF = this.buffer.indexOf('\r\n\r\n');
      const sepLF = this.buffer.indexOf('\n\n');
      let headerEnd = -1;
      let delimiter = 4; // default to CRLFCRLF
      if (sepCRLF !== -1) {
        headerEnd = sepCRLF;
        delimiter = 4;
      } else if (sepLF !== -1) {
        headerEnd = sepLF;
        delimiter = 2;
      } else {
        break; // need more data
      }
      const headerBuf = this.buffer.subarray(0, headerEnd);
      const headerStr = headerBuf.toString('utf8');
      const headers: Headers = {};
      for (const line of headerStr.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[key] = value;
      }
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      const totalHeaderLen = headerEnd + delimiter;
      if (this.buffer.length < totalHeaderLen + contentLength) {
        // Not enough body
        break;
      }
      const bodyBuf = this.buffer.subarray(totalHeaderLen, totalHeaderLen + contentLength);
      this.buffer = this.buffer.subarray(totalHeaderLen + contentLength);
      try {
        const obj = JSON.parse(bodyBuf.toString('utf8')) as JsonRpcRequest;
        if (obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string') {
          this.onMessage(obj);
        }
      } catch (e) {
        // ignore malformed message
      }
    }
  }

  send(res: JsonRpcResponse) {
    const payload = Buffer.from(JSON.stringify(res), 'utf8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
    process.stdout.write(header);
    process.stdout.write(payload);
  }
}

// Map Fry CLI tool definitions to MCP tool schema entries
const mapToolsToMcp = async () => {
  // To avoid importing client.tsx (which pulls Ink/React), define the schema inline
  // Consistent with src/client.tsx:getLocalTools()
  const tools: any[] = [
    {
      name: 'exec',
      description: "Execute code via a local runtime. Set runtime to 'shell' or 'python'. Returns labeled STDOUT/STDERR; large output is paginated.",
      input_schema: {
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
    },
    {
      name: 'fs.ls',
      description: 'List files and folders under a directory (relative to project root).',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: "Directory to list (relative). Defaults to '.' if omitted." } }
      }
    },
    {
      name: 'fs.read',
      description: 'Read lines from a text file. Returns { content, start_line, end_line, total_lines, has_more, next_start_line }.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative).' },
          start_line: { type: 'integer', description: '1-indexed start line (default: 1).' },
          end_line: { type: 'integer', description: '1-indexed end line (inclusive). If omitted, returns 50 lines.' }
        },
        required: ['path']
      }
    },
    {
      name: 'fs.write',
      description: 'Write text content to a file (creates or overwrites).',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path (relative).' },
          content: { type: 'string', description: 'Full text content to write.' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'fs.mkdir',
      description: 'Create a directory (recursively). No error if it already exists.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to create (relative).' } },
        required: ['path']
      }
    },
    {
      name: 'fs.search_files',
      description: "Search for a substring across text files. Returns 'path:line:match' lines. Large result sets are paginated.",
      input_schema: {
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
    },
    {
      name: 'fs.apply_patch',
      description: "Apply multi-file edits using the pseudo-unified patch format bounded by '*** Begin Patch' and '*** End Patch'.",
      input_schema: {
        type: 'object',
        properties: { patch: { type: 'string', description: 'Patch text to apply.' } },
        required: ['patch']
      }
    },
    {
      name: 'shell',
      description: 'Execute a shell command (POSIX or Windows). Output is paginated.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          page: { type: 'integer' },
          page_size: { type: 'integer' }
        },
        required: ['command']
      }
    },
    {
      name: 'python',
      description: 'Execute Python code locally. Output is paginated.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          page: { type: 'integer' },
          page_size: { type: 'integer' }
        },
        required: ['code']
      }
    }
  ];
  return tools;
};

async function getPkgVersion(): Promise<string> {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const data = await readFile(fileURLToPath(pkgUrl), 'utf-8');
    const json = JSON.parse(data);
    return typeof json.version === 'string' ? json.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const executor = new LocalToolExecutor();
const rpc = new StdioJsonRpc(async (req) => {
  const id = req.id ?? null;
  const respond = (result?: Json, error?: { code: number; message: string; data?: Json }) => {
    const res: JsonRpcResponse = { jsonrpc: '2.0', id };
    if (error) res.error = error; else res.result = result ?? null;
    rpc.send(res);
  };

  try {
    switch (req.method) {
      case 'initialize': {
        const version = await getPkgVersion();
        return respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fry-cli-mcp', version }
        });
      }
      case 'ping': {
        return respond({});
      }
      case 'tools/list': {
        const tools = await mapToolsToMcp();
        return respond({ tools });
      }
      case 'tools/call': {
        const params = req.params || {};
        const name: string = params.name;
        const args: any = params.arguments || {};
        if (!name || typeof name !== 'string') {
          return respond(undefined, { code: -32602, message: 'Invalid tool name' });
        }
        // Adapt to LocalToolExecutor API by creating a ToolCall-like object
        const toolCall = {
          id: 'mcp_' + Math.random().toString(36).slice(2, 10),
          type: 'function' as const,
          function: { name, arguments: JSON.stringify(args ?? {}) }
        };
        const result = await executor.execute(toolCall);

        // Convert ToolResult to MCP ToolResult content
        let contentItem: any;
        if (typeof result.data === 'string') {
          contentItem = { type: 'text', text: result.data };
        } else {
          contentItem = { type: 'json', json: result.data };
        }
        const isError = result.status === 'error';
        return respond({ content: [contentItem], isError });
      }
      default: {
        return respond(undefined, { code: -32601, message: `Method not found: ${req.method}` });
      }
    }
  } catch (e: any) {
    return respond(undefined, { code: -32000, message: e?.message || String(e) });
  }
});

// Ensure process stays alive
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

