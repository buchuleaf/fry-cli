// tools.tsx
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as glob from 'glob';

// Types
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  status: 'success' | 'error' | 'client_execution_required';
  data: any;
}

const CHUNK_SIZE_TOKENS = 500;

// Local Tool Executor
export class LocalToolExecutor {
  // Root directory for all tool operations. Use the directory where fry-cli was launched.
  private workspaceDir: string = process.cwd();
  private toolChunks: Map<string, string[]> = new Map();

  constructor() {
    // No need to create the working directory; it already exists.
  }

  async getWorkspaceContents(maxChars: number = 4000): Promise<string> {
    // Return ONLY the top-level listing of the working directory.
    // One item per line; directories end with '/'. No recursion.
    try {
      const dir = this.workspaceDir;
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
    } catch (error) {
      return `Error reading directory: ${error}`;
    }
  }

  private getSafePath(userPath: string): string | null {
    const workspaceRoot = path.resolve(this.workspaceDir);
    const fullPath = path.resolve(path.join(workspaceRoot, userPath));
    return fullPath.startsWith(workspaceRoot) ? fullPath : null;
  }

  private chunkContent(content: string, toolCallId: string, opts?: { lineSafe?: boolean }): ToolResult {
    // Simple heuristic for token counting: 1 token ~ 4 characters
    const charLimit = CHUNK_SIZE_TOKENS * 4;

    if (content.length <= charLimit) {
      return { status: 'success', data: content };
    }

    const chunks: string[] = [];
    if (opts?.lineSafe) {
      // Ensure we end chunks on full-line boundaries when desired.
      let i = 0;
      while (i < content.length) {
        let end = Math.min(i + charLimit, content.length);
        if (end < content.length) {
          // Advance to the next newline so the last line of the chunk is complete.
          const nextNewline = content.indexOf('\n', end);
          if (nextNewline !== -1) {
            end = nextNewline + 1; // include the newline in this chunk
          } else {
            end = content.length; // no more newlines; take the rest
          }
        }
        chunks.push(content.slice(i, end));
        i = end;
      }
    } else {
      for (let i = 0; i < content.length; i += charLimit) {
        chunks.push(content.substring(i, i + charLimit));
      }
    }
    
    this.toolChunks.set(toolCallId, chunks);

    // Return the standard notice plus the first chunk inline so the model
    // does not need to call read_chunk for an initial preview.
    const preview = chunks[0] ?? '';
    const header = `Output is too large and has been split into ${chunks.length} chunks. Use workspace(action='read_chunk', tool_call_id='${toolCallId}', chunk=<0..${chunks.length - 1}>) to view more.`;
    const decoratedPreview = `\n\nFirst chunk (0/${chunks.length - 1}):\n${preview}`;
    return {
      status: 'success',
      data: header + decoratedPreview
    };
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const functionName = toolCall.function.name;
    let args: any;
    
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (error) {
      return { status: 'error', data: `Invalid JSON arguments: ${toolCall.function.arguments}` };
    }

    try {
      if (functionName === 'workspace') {
        return await this.handleWorkspaceTool(args, toolCall.id);
      } else if (functionName.startsWith('fs.')) {
        return await this.handleFsTool(functionName, args, toolCall.id);
      } else if (functionName === 'exec') {
        return await this.handleExecTool(args, toolCall.id);
      } else if (functionName === 'python') {
        return await this.handlePythonTool(args, toolCall.id);
      } else if (functionName === 'shell') {
        return await this.handleShellTool(args, toolCall.id);
      } else if (functionName === 'apply_patch') {
        return await this.handleApplyPatch(args);
      } else {
        return { status: 'error', data: `Unknown local tool: ${functionName}` };
      }
    } catch (error) {
      return { status: 'error', data: `Error during tool execution: ${error}` };
    }
  }

  private async handleExecTool(args: any, toolCallId: string): Promise<ToolResult> {
    const runtime = (args.runtime || '').toLowerCase();
    if (!runtime) return { status: 'error', data: "Missing 'runtime' ('shell' | 'python')." };
    if (runtime === 'shell') {
      const command = args.command || '';
      return this.handleShellTool({ command }, toolCallId);
    }
    if (runtime === 'python') {
      const code = args.code || '';
      return this.handlePythonTool({ code }, toolCallId);
    }
    return { status: 'error', data: "Unsupported runtime. Use 'shell' or 'python'." };
  }

  private async handleWorkspaceTool(args: any, toolCallId: string): Promise<ToolResult> {
    const action = (args.action || '').toLowerCase();
    switch (action) {
      case 'ls':
        return this.handleLs({ path: args.path || '.' }, toolCallId);
      case 'read':
        return this.handleRead({ path: args.path }, toolCallId);
      case 'write':
        return this.handleWrite({ path: args.path, content: args.content });
      case 'mkdir':
        return this.handleMkdir({ path: args.path });
      case 'search_files':
        return this.handleSearchFiles({ pattern: args.pattern, file_pattern: args.file_pattern }, toolCallId);
      case 'apply_patch':
        return this.handleApplyPatch({ patch: args.patch });
      case 'read_chunk':
        return this.handleReadChunk({ tool_call_id: args.tool_call_id, chunk: args.chunk });
      default:
        return { status: 'error', data: "Unknown or missing 'action'. Use one of: ls, read, write, mkdir, search_files, apply_patch, read_chunk." };
    }
  }

  private async handleShellTool(args: any, toolCallId: string): Promise<ToolResult> {
    const command = args.command || '';
    if (!command) return { status: 'error', data: 'No command provided.' };

    const tryRunner = (prog: string, progArgs: string[]): Promise<ToolResult> => {
      return new Promise((resolve) => {
        const proc = spawn(prog, progArgs, {
          cwd: this.workspaceDir,
          timeout: 20000,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          const output = `EXIT: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
          resolve(this.chunkContent(output, toolCallId, { lineSafe: true }));
        });

        proc.on('error', (error: any) => {
          if (error.code === 'ENOENT' || String(error.message).includes('ENOENT')) {
            resolve({ status: 'error', data: `Command not found: ${prog}. Please ensure a shell is installed and in your PATH.` });
          } else {
            resolve({ status: 'error', data: `Shell execution failed: ${error.message}` });
          }
        });
      });
    };

    // Prefer POSIX shells; fall back to Windows cmd.exe, then PowerShell
    if (process.platform !== 'win32') {
      let result = await tryRunner('bash', ['-lc', command]);
      if (result.status === 'error' && String(result.data).startsWith('Command not found')) {
        result = await tryRunner('sh', ['-lc', command]);
      }
      return result;
    } else {
      // Windows
      let result = await tryRunner('cmd.exe', ['/d', '/s', '/c', command]);
      if (result.status === 'error') {
        result = await tryRunner('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
      }
      return result;
    }
  }

  private async handlePythonTool(args: any, toolCallId: string): Promise<ToolResult> {
    let code = args.code || '';
    if (!code) return { status: 'error', data: 'No code provided.' };

    // The model is sometimes wrapping code in a shell command.
    // We need to extract the actual Python code from it.
    const hereDocMatch = code.match(/python3? - <<'PY'\s*([\s\S]*?)\s*PY/);
    if (hereDocMatch && hereDocMatch[1]) {
      code = hereDocMatch[1].trim();
    }

    const tryCommand = (command: string): Promise<ToolResult> => {
      return new Promise((resolve) => {
        // Use the cleaned 'code' variable here
        const pythonProcess = spawn(command, ['-c', code], {
          cwd: this.workspaceDir,
          timeout: 20000,
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (exitCode) => {
          const output = `EXIT: ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
          resolve(this.chunkContent(output, toolCallId, { lineSafe: true }));
        });

        pythonProcess.on('error', (error: any) => {
          // The ENOENT code indicates the command was not found.
          // We also check the message for 'ENOENT' for robustness across environments.
          if (error.code === 'ENOENT' || error.message.includes('ENOENT')) {
            resolve({ status: 'error', data: `Command not found: ${command}. Please ensure Python is installed and in your PATH.` });
          } else {
            resolve({ status: 'error', data: `Python execution failed: ${error.message}` });
          }
        });
      });
    };

    // Try 'python3' first, then fall back to 'python'.
    let result = await tryCommand('python3');
    if (result.status === 'error' && result.data.startsWith('Command not found')) {
      result = await tryCommand('python');
    }

    return result;
  }

  private async handleFsTool(functionName: string, args: any, toolCallId: string): Promise<ToolResult> {
    const command = functionName.split('.').pop()!;

    switch (command) {
      case 'ls':
        return await this.handleLs(args, toolCallId);
      case 'read':
        return await this.handleRead(args, toolCallId);
      case 'write':
        return await this.handleWrite(args);
      case 'mkdir':
        return await this.handleMkdir(args);
      case 'search_files':
        return await this.handleSearchFiles(args, toolCallId);
      case 'read_chunk':
        return await this.handleReadChunk(args);
      default:
        return { status: 'error', data: `Unknown fs command: ${command}` };
    }
  }

  private async handleLs(args: any, toolCallId: string): Promise<ToolResult> {
    const pathArg = args.path || '.';
    const safePath = this.getSafePath(pathArg);
    
    if (!safePath) {
      return { status: 'error', data: 'Access denied.' };
    }

    try {
      const stats = await fs.stat(safePath);
      if (!stats.isDirectory()) {
        return { status: 'error', data: 'Not a directory.' };
      }

      const items = await fs.readdir(safePath);
      if (items.length === 0) {
        return { status: 'success', data: `Directory '${pathArg}' is empty.` };
      }

      const formattedItems: string[] = [];
      for (const item of items.sort()) {
        const itemPath = path.join(safePath, item);
        try {
          const itemStats = await fs.stat(itemPath);
          formattedItems.push(itemStats.isDirectory() ? `${item}/` : item);
        } catch {
          formattedItems.push(item);
        }
      }

      return this.chunkContent(formattedItems.join('\n'), toolCallId, { lineSafe: true });
    } catch (error) {
      return { status: 'error', data: `Error listing directory: ${error}` };
    }
  }

  private async handleRead(args: any, toolCallId: string): Promise<ToolResult> {
    const pathArg = args.path;
    if (!pathArg) return { status: 'error', data: 'read requires a path.' };

    const safePath = this.getSafePath(pathArg);
    if (!safePath) return { status: 'error', data: 'Access denied.' };

    try {
      const stats = await fs.stat(safePath);
      if (!stats.isFile()) {
        return { status: 'error', data: 'Not a file.' };
      }

      const content = await fs.readFile(safePath, 'utf-8');
      // When reading files (often code), keep chunks aligned to full lines
      // so the last line in each chunk is not truncated.
      return this.chunkContent(content, toolCallId, { lineSafe: true });
    } catch (error) {
      return { status: 'error', data: `Error reading file: ${error}` };
    }
  }

  private async handleWrite(args: any): Promise<ToolResult> {
    const pathArg = args.path;
    const content = args.content || '';
    
    if (!pathArg) return { status: 'error', data: 'Missing path argument.' };
    
    const safePath = this.getSafePath(pathArg);
    if (!safePath) return { status: 'error', data: 'Access denied.' };

    try {
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, 'utf-8');
      return { status: 'success', data: `Content written to '${pathArg}'.` };
    } catch (error) {
      return { status: 'error', data: `Error writing file: ${error}` };
    }
  }

  private async handleMkdir(args: any): Promise<ToolResult> {
    const pathArg = args.path;
    if (!pathArg) return { status: 'error', data: 'Missing path argument.' };
    
    const safePath = this.getSafePath(pathArg);
    if (!safePath) return { status: 'error', data: 'Access denied.' };

    try {
      await fs.mkdir(safePath, { recursive: true });
      return { status: 'success', data: `Directory '${pathArg}' created.` };
    } catch (error) {
      return { status: 'error', data: `Error creating directory: ${error}` };
    }
  }

  private async handleSearchFiles(args: any, toolCallId: string): Promise<ToolResult> {
    const pattern = args.pattern;
    if (!pattern) return { status: 'error', data: 'Missing pattern argument.' };
    
    const filePattern = args.file_pattern || '**/*';
    
    try {
      // Layer 1: Efficiently ignore common binary extensions and unwanted directories at the glob level.
      const files = await glob.glob(path.join(this.workspaceDir, filePattern), {
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/*.{jpg,jpeg,png,gif,bmp,ico,pdf,zip,gz,tar,rar,7z,exe,dll,so,o,a,class,pyc,mp3,mp4,mov,avi,wav,db,sqlite,sqlite3,dat,bin}',
        ],
        nodir: true, // We only want to search files, not directories.
      });
      const matches: string[] = [];

      // Layer 2: For remaining files, perform a content-based check for binary data.
      // This helper function reads the first 1KB of a file and checks for a NULL byte.
      const isFileBinary = async (filePath: string): Promise<boolean> => {
        const chunk = Buffer.alloc(1024);
        let fileHandle;
        try {
          fileHandle = await fs.open(filePath, 'r');
          const { bytesRead } = await fileHandle.read(chunk, 0, 1024, 0);
          await fileHandle.close(); // Close the handle immediately after reading.
          
          // A NULL byte (0x00) is a very strong indicator of a binary file.
          return chunk.slice(0, bytesRead).includes(0);
        } catch (err) {
          // If we can't open or read the file, treat it as unsearchable/binary to be safe.
          return true;
        }
      };

      for (const file of files) {
        try {
          // Perform the content check as a final safeguard.
          if (await isFileBinary(file)) {
            continue; // Skip files that appear to be binary.
          }

          // If the file is not binary, proceed with reading and searching.
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');
          
          lines.forEach((line, i) => {
            if (line.includes(pattern)) {
              const relativePath = path.relative(this.workspaceDir, file);
              matches.push(`${relativePath}:${i + 1}:${line.trim()}`);
            }
          });
        } catch {
          // Silently skip any other files that can't be read.
        }
      }

      if (matches.length === 0) {
        return { status: 'success', data: `No matches found for '${pattern}'.` };
      }

      return this.chunkContent(matches.join('\n'), toolCallId, { lineSafe: true });
    } catch (error) {
      return { status: 'error', data: `Error during file search: ${error}` };
    }
  }

  private async handleReadChunk(args: any): Promise<ToolResult> {
    const toolCallId = args.tool_call_id;
    const chunkNum = args.chunk || 0;

    if (!toolCallId) {
      return { status: 'error', data: 'Missing tool_call_id.' };
    }

    const chunks = this.toolChunks.get(toolCallId);
    if (!chunks) {
      return { status: 'error', data: 'Invalid tool_call_id.' };
    }

    if (chunkNum < 0 || chunkNum >= chunks.length) {
      return { status: 'error', data: 'Invalid chunk number.' };
    }

    return { status: 'success', data: chunks[chunkNum] };
  }

  private async handleApplyPatch(args: any): Promise<ToolResult> {
    const patchText: string = args.patch || '';
    if (!patchText || typeof patchText !== 'string') {
      return { status: 'error', data: "Missing 'patch' string." };
    }

    const lines = patchText.split(/\r?\n/);
    let i = 0;
    const results: string[] = [];

    const safe = (rel: string): string | null => this.getSafePath(rel);
    const ensureParent = async (p: string) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
    };

    const startsWith = (prefix: string) => (i < lines.length && lines[i].startsWith(prefix));

    // Validate sentinels
    if (!(i < lines.length && lines[i].trim() === '*** Begin Patch')) {
      return { status: 'error', data: "Patch must start with '*** Begin Patch'" };
    }
    i += 1;

    try {
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '*** End Patch') {
          i += 1;
          break;
        }

        if (startsWith('*** Add File: ')) {
          const relPath = lines[i].slice('*** Add File: '.length).trim();
          const target = safe(relPath);
          if (!target) return { status: 'error', data: `Access denied for Add File path: ${relPath}` };
          i += 1;
          const contentLines: string[] = [];
          while (i < lines.length && !lines[i].startsWith('*** ')) {
            const l = lines[i];
            if (l.startsWith('+')) {
              contentLines.push(l.slice(1));
            } else if (l === '') {
              contentLines.push('');
            } else {
              return { status: 'error', data: `Invalid line in Add File block for ${relPath}: ${l}` };
            }
            i += 1;
          }
          await ensureParent(target);
          await fs.writeFile(target, contentLines.join('\n'), 'utf-8');
          results.push(`Added file: ${relPath}`);
          continue;
        }

        if (startsWith('*** Delete File: ')) {
          const relPath = lines[i].slice('*** Delete File: '.length).trim();
          const target = safe(relPath);
          if (!target) return { status: 'error', data: `Access denied for Delete File path: ${relPath}` };
          try {
            const stat = await fs.stat(target);
            if (stat.isDirectory()) {
              return { status: 'error', data: `Delete File path is a directory (unsupported): ${relPath}` };
            }
            await fs.unlink(target);
            results.push(`Deleted file: ${relPath}`);
          } catch {
            results.push(`Delete skipped (not found): ${relPath}`);
          }
          i += 1;
          continue;
        }

        if (startsWith('*** Update File: ')) {
          const originalRel = lines[i].slice('*** Update File: '.length).trim();
          let relPath = originalRel;
          const originalTarget = safe(originalRel);
          if (!originalTarget) return { status: 'error', data: `Access denied for Update File path: ${originalRel}` };
          try {
            const st = await fs.stat(originalTarget);
            if (!st.isFile()) return { status: 'error', data: 'Not a file.' };
          } catch {
            return { status: 'error', data: `File to update not found: ${originalRel}` };
          }
          i += 1;

          // Optional move
          if (startsWith('*** Move to: ')) {
            const newRel = lines[i].slice('*** Move to: '.length).trim();
            const newTarget = safe(newRel);
            if (!newTarget) return { status: 'error', data: `Access denied for Move to path: ${newRel}` };
            relPath = newRel;
            i += 1;
          }

          let content = await fs.readFile(originalTarget, 'utf-8');

          // Apply hunks (supports LF and CRLF files)
          while (i < lines.length && !lines[i].startsWith('*** ')) {
            if (lines[i].startsWith('@@')) {
              i += 1; // skip hunk header or context identifier
            }
            const oldBlock: string[] = [];
            const newBlock: string[] = [];
            while (
              i < lines.length &&
              !lines[i].startsWith('@@') &&
              !lines[i].startsWith('*** ')
            ) {
              const hl = lines[i];
              if (hl === '') {
                oldBlock.push('');
                newBlock.push('');
                i += 1;
                continue;
              }
              const prefix = hl[0];
              const body = hl.slice(1);
              if (prefix === ' ') {
                oldBlock.push(body);
                newBlock.push(body);
              } else if (prefix === '-') {
                oldBlock.push(body);
              } else if (prefix === '+') {
                newBlock.push(body);
              } else {
                return { status: 'error', data: `Invalid hunk line: ${hl}` };
              }
              i += 1;
            }
            const oldTextLF = oldBlock.join('\n');
            const newTextLF = newBlock.join('\n');
            const oldTextCRLF = oldBlock.join('\r\n');
            const newTextCRLF = newBlock.join('\r\n');
            if (!oldTextLF && !newTextLF) {
              continue;
            }
            if (content.includes(oldTextLF)) {
              content = content.replace(oldTextLF, newTextLF);
            } else if (content.includes(oldTextCRLF)) {
              content = content.replace(oldTextCRLF, newTextCRLF);
            } else {
              return { status: 'error', data: `Hunk context not found while updating ${originalRel}.` };
            }

            if (i < lines.length && lines[i].trim() === '*** End of File') {
              i += 1;
            }
          }

          const finalTarget = safe(relPath);
          if (!finalTarget) return { status: 'error', data: `Access denied for final path: ${relPath}` };
          await ensureParent(finalTarget);
          await fs.writeFile(finalTarget, content, 'utf-8');
          if (relPath !== originalRel) {
            // Remove old file if renamed
            try {
              await fs.unlink(originalTarget);
            } catch {}
            results.push(`Updated and moved file: ${originalRel} -> ${relPath}`);
          } else {
            results.push(`Updated file: ${relPath}`);
          }
          continue;
        }

        // ignore stray empty lines
        if (!line.trim()) {
          i += 1;
          continue;
        }

        return { status: 'error', data: `Unknown patch directive: ${line}` };
      }

      if (!(lines.length > 0 && lines[i - 1]?.trim() === '*** End Patch')) {
        return { status: 'error', data: "Patch missing required '*** End Patch' terminator." };
      }

      return { status: 'success', data: results.length ? results.join('\n') : 'Patch applied with no changes.' };
    } catch (e: any) {
      return { status: 'error', data: `An error occurred applying patch: ${e?.message || String(e)}` };
    }
  }
}
