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
// File read defaults and limits
const DEFAULT_READ_WINDOW = 50; // default lines when end_line not provided
const MAX_READ_LINES = 200;     // hard limit per call

// Local Tool Executor
export class LocalToolExecutor {
  // Root directory for all tool operations. Use the directory where fry-cli was launched.
  private workspaceDir: string = process.cwd();

  constructor() {}

  private getSafePath(userPath: string): string | null {
    const workspaceRoot = path.resolve(this.workspaceDir);
    const fullPath = path.resolve(path.join(workspaceRoot, userPath));
    return fullPath.startsWith(workspaceRoot) ? fullPath : null;
  }

  private chunkContent(content: string, _toolCallId: string, opts?: { lineSafe?: boolean }): ToolResult {
    // Simple heuristic for token counting: 1 token ~ 4 characters
    const charLimit = CHUNK_SIZE_TOKENS * 4;

    if (content.length <= charLimit) {
      return { status: 'success', data: content };
    }

    // Truncate output for display. If lineSafe, cut at the last full line within limit.
    let cut = charLimit;
    if (opts?.lineSafe) {
      const idx = content.lastIndexOf('\n', charLimit);
      if (idx > 0) cut = idx + 1;
    }
    const preview = content.slice(0, cut);
    const header = `Output truncated. Showing first ${cut} of ${content.length} characters. Refine your command or filter to reduce output.`;
    return { status: 'success', data: `${header}\n\n${preview}` };
  }

  private paginateOutput(content: string, page: number, pageSize: number) {
    const totalChars = content.length;
    const totalPages = Math.ceil(totalChars / pageSize) || 1;
    
    // Adjust page to be within valid range
    const actualPage = Math.max(1, Math.min(page, totalPages));
    
    const startIdx = (actualPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalChars);
    const pageContent = content.slice(startIdx, endIdx);
    
    return {
      content: pageContent,
      page: actualPage,
      page_size: pageSize,
      total_chars: totalChars,
      total_pages: totalPages,
      has_prev: actualPage > 1,
      has_next: actualPage < totalPages
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
    const actionRaw = String(args.action || '');
    const action = actionRaw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    switch (action) {
      case 'ls':
        return this.handleLs({ path: args.path || '.' }, toolCallId);
      case 'read':
        return this.handleRead({ path: args.path, start_line: args.start_line, end_line: args.end_line }, toolCallId);
      case 'write':
        return this.handleWrite({ path: args.path, content: args.content });
      case 'mkdir':
        return this.handleMkdir({ path: args.path });
      case 'search_files':
        return this.handleSearchFiles({
            pattern: args.pattern,
            file_pattern: args.file_pattern,
            path: args.path,
            page: args.page,
            page_size: args.page_size,
        }, toolCallId);
      case 'apply_patch':
      case 'applypatch':
      case 'apply__patch':
      case 'apply_patch_':
      case '_apply_patch':
        return this.handleApplyPatch({ patch: args.patch });
      // No 'read_chunk' action in simplified API
      // fallthrough
      default:
        return { status: 'error', data: `Unknown or missing 'action'. Use one of: ls, read, write, mkdir, search_files, apply_patch. Received: '${actionRaw}'` };
    }
  }

  private async handleShellTool(args: any, toolCallId: string): Promise<ToolResult> {
    const command = args.command || '';
    const page = Math.max(1, parseInt(args.page) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(args.page_size) || 2000)); // Default 2000, max 5000
    
    if (!command) return { status: 'error', data: 'No command provided.' };

    // Helper to run a shell and capture outputs with exit code for better decision making
    const runShell = (prog: string, progArgs: string[]) => {
      return new Promise<{ code: number | null, stdout: string, stderr: string, notFound: boolean, errorMsg?: string }>((resolve) => {
        const proc = spawn(prog, progArgs, { cwd: this.workspaceDir, timeout: 60000 });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => resolve({ code, stdout, stderr, notFound: false }));
        proc.on('error', (error: any) => {
          const msg = String(error?.message || '');
          if (error?.code === 'ENOENT' || msg.includes('ENOENT')) {
            resolve({ code: null, stdout: '', stderr: '', notFound: true, errorMsg: msg });
          } else {
            resolve({ code: null, stdout: '', stderr: msg || 'Unknown error', notFound: false, errorMsg: msg });
          }
        });
      });
    };

    const toResult = (code: number | null, stdout: string, stderr: string): ToolResult => {
      const output = `EXIT: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
      
      // Always paginate the output to preserve all information
      const paginated = this.paginateOutput(output, page, pageSize);
      return { 
        status: 'success', 
        data: paginated
      };
    };

    // Non-Windows: prefer bash, then sh
    if (process.platform !== 'win32') {
      let r = await runShell('bash', ['-lc', command]);
      if (r.notFound) {
        r = await runShell('sh', ['-lc', command]);
      }
      if (r.notFound) {
        return { status: 'error', data: 'Command not found: bash/sh. Please ensure a POSIX shell is installed and in your PATH.' };
      }
      return toResult(r.code, r.stdout, r.stderr);
    }

    // Windows: prefer a shell based on command shape, normalize for cmd, and smart fallback.
    const looksPosixy = (() => {
      const c = command.trim();
      if (c.startsWith('./')) return true;
      // Common POSIX tools the model might use
      if (/(?:^|\s)(ls|pwd|cat|grep|rm|mv|cp|touch)\b/.test(c)) return true;
      // Use of forward slashes with relative paths
      if (/\.\//.test(c)) return true;
      return false;
    })();

    const runInPowershell = async (cmd: string) => {
      return runShell('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
    };
    const runInCmd = async (cmd: string) => {
      // For cmd.exe, normalize leading './' to '.\' so relative executables run
      let normalized = cmd;
      if (normalized.trim().startsWith('./')) {
        normalized = normalized.replace(/^\s*\.\//, '.\\');
      }
      return runShell('cmd.exe', ['/d', '/s', '/c', normalized]);
    };

    const shouldFallbackToCmd = (stderr: string) => {
      // PowerShell parse errors for cmd-style tokens
      return /Unexpected token '&&'|The term '.+?' is not recognized as the name of a cmdlet/i.test(stderr);
    };
    const shouldFallbackToPowershell = (stderr: string) => {
      // cmd.exe not recognizing POSIXy usage like './prog' or unknown commands like 'ls'
      return /is not recognized as an internal or external command|^'\.' is not recognized/i.test(stderr);
    };

    // Choose initial shell
    let first: 'ps' | 'cmd' = looksPosixy ? 'ps' : 'cmd';
    // But if command obviously chains with '&&' or '||', prefer cmd first (PS 5 doesn't support '&&')
    if (/[&]{2}|\|{2}/.test(command)) first = 'cmd';

    let firstRun = first === 'ps' ? await runInPowershell(command) : await runInCmd(command);
    // If the chosen shell is missing, try the other
    if (firstRun.notFound) {
      const secondRun = first === 'ps' ? await runInCmd(command) : await runInPowershell(command);
      if (secondRun.notFound) {
        return { status: 'error', data: 'No suitable shell found (PowerShell/cmd.exe) in PATH.' };
      }
      return toResult(secondRun.code, secondRun.stdout, secondRun.stderr);
    }

    // If success (exit code 0), return immediately
    if (firstRun.code === 0) {
      return toResult(firstRun.code, firstRun.stdout, firstRun.stderr);
    }

    // Non-zero exit code: decide whether to fallback based on error signature
    const stderr = firstRun.stderr || '';
    const fallback = first === 'ps' ? shouldFallbackToCmd(stderr) : shouldFallbackToPowershell(stderr);
    if (!fallback) {
      // Return the first result as-is
      return toResult(firstRun.code, firstRun.stdout, firstRun.stderr);
    }

    const secondRun = first === 'ps' ? await runInCmd(command) : await runInPowershell(command);
    return toResult(secondRun.code, secondRun.stdout, secondRun.stderr);
  }

  private async handlePythonTool(args: any, toolCallId: string): Promise<ToolResult> {
    let code = args.code || '';
    const page = Math.max(1, parseInt(args.page) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(args.page_size) || 2000)); // Default 2000, max 5000
    
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
          timeout: 60000,
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
          
          // Always paginate the output to preserve all information
          const paginated = this.paginateOutput(output, page, pageSize);
          resolve({ 
            status: 'success', 
            data: paginated
          });
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
    const raw = functionName.split('.').pop() || '';
    // Normalize command names defensively to tolerate minor formatting variations
    // - trim whitespace
    // - lowercase
    // - convert hyphens/spaces to underscores
    const command = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

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
      case 'apply_patch':
      case 'applypatch': // tolerate missing underscore
      case 'apply__patch': // tolerate accidental double underscore
      case 'apply_patch_': // tolerate trailing underscore
      case '_apply_patch': // tolerate leading underscore
        return await this.handleApplyPatch(args);
      default:
        return { status: 'error', data: `Unknown fs command: ${raw}` };
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

      return { status: 'success', data: formattedItems.join('\n') };
    } catch (error) {
      return { status: 'error', data: `Error listing directory: ${error}` };
    }
  }

  private async handleRead(args: any, _toolCallId: string): Promise<ToolResult> {
    const pathArg = args.path;
    if (!pathArg) return { status: 'error', data: 'read requires a path.' };

    const safePath = this.getSafePath(pathArg);
    if (!safePath) return { status: 'error', data: 'Access denied.' };

    const parseIntSafe = (v: any): number | undefined => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };

    let startLine = parseIntSafe(args.start_line) ?? 1;
    let endLine = parseIntSafe(args.end_line);

    try {
      const stats = await fs.stat(safePath);
      if (!stats.isFile()) return { status: 'error', data: 'Not a file.' };

      const fullText = await fs.readFile(safePath, 'utf-8');
      const allLines = fullText.split('\n');
      const totalLines = allLines.length;

      if (!endLine) {
        endLine = startLine + DEFAULT_READ_WINDOW - 1;
      }
      // Enforce maximum window size
      if (endLine - startLine + 1 > MAX_READ_LINES) {
        endLine = startLine + MAX_READ_LINES - 1;
      }

      if (startLine < 1 || startLine > totalLines) {
        return { status: 'error', data: `start_line out of range. Valid: 1..${totalLines}` };
      }
      if (endLine < startLine) {
        return { status: 'error', data: 'end_line must be >= start_line.' };
      }
      if (endLine > totalLines) endLine = totalLines;

      const slice = allLines.slice(startLine - 1, endLine);
      const numberedContent = slice.map((line, index) => {
        const lineNumber = startLine + index;
        return `${lineNumber}:${line}`;
      }).join('\n');

      const hasMore = endLine < totalLines;
      const payload = {
        path: pathArg,
        content: numberedContent,
        start_line: startLine,
        end_line: endLine,
        total_lines: totalLines,
        has_more: hasMore,
        next_start_line: hasMore ? endLine + 1 : undefined,
      };
      return { status: 'success', data: payload };
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

    const page = Math.max(1, parseInt(args.page) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(args.page_size) || 2000));

    // Optional base path to scope the search. Defaults to workspace root.
    const pathArg = args.path;
    const filePattern = args.file_pattern || '**/*';

    try {
      let files: string[] = [];

      // Resolve and validate the base path if provided.
      if (pathArg) {
        const safeBase = this.getSafePath(pathArg);
        if (!safeBase) return { status: 'error', data: 'Access denied.' };
        try {
          const st = await fs.stat(safeBase);
          if (st.isFile()) {
            // If a single file is provided, search only that file.
            files = [safeBase];
          } else if (st.isDirectory()) {
            // Search within the specified directory using the provided file pattern.
            files = await glob.glob(filePattern, {
              cwd: safeBase,
              absolute: true,
              ignore: [
                '**/node_modules/**',
                '**/.git/**',
                '**/*.{jpg,jpeg,png,gif,bmp,ico,pdf,zip,gz,tar,rar,7z,exe,dll,so,o,a,class,pyc,mp3,mp4,mov,avi,wav,db,sqlite,sqlite3,dat,bin}',
              ],
              nodir: true,
            });
          } else {
            return { status: 'error', data: 'Path is neither file nor directory.' };
          }
        } catch {
          return { status: 'error', data: 'Path not found.' };
        }
      } else {
        // No base path provided: search from the workspace root.
        files = await glob.glob(filePattern, {
          cwd: this.workspaceDir,
          absolute: true,
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/*.{jpg,jpeg,png,gif,bmp,ico,pdf,zip,gz,tar,rar,7z,exe,dll,so,o,a,class,pyc,mp3,mp4,mov,avi,wav,db,sqlite,sqlite3,dat,bin}',
          ],
          nodir: true,
        });
      }

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

      const fullOutput = matches.join('\n');
      const paginated = this.paginateOutput(fullOutput, page, pageSize);

      return { status: 'success', data: paginated };
    } catch (error) {
      return { status: 'error', data: `Error during file search: ${error}` };
    }
  }

  // read_chunk removed in simplified API

  private async handleApplyPatch(args: any): Promise<ToolResult> {
    const patchText: string = args.patch || '';
    if (!patchText || typeof patchText !== 'string') {
      return { status: 'error', data: "Missing 'patch' string." };
    }

    const lines = patchText.split(/\r?\n/);
    let i = 0;
    const results: string[] = [];
    const diffs: string[] = [];

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
          // Diff-style display for added files
          diffs.push(`File added: ${relPath}`);
          if (contentLines.length === 0) {
            diffs.push('(empty file)');
          } else {
            for (let ln = 0; ln < contentLines.length; ln++) {
              const num = (ln + 1).toString().padStart(String(contentLines.length).length, ' ');
              diffs.push(`+ [${num}] ${contentLines[ln]}`);
            }
          }
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
            // Prepare diff prior to deletion
            try {
              const oldContent = await fs.readFile(target, 'utf-8');
              const oldLines = oldContent.split('\n');
              diffs.push(`File deleted: ${relPath}`);
              if (oldLines.length === 0) {
                diffs.push('(empty file)');
              } else {
                for (let ln = 0; ln < oldLines.length; ln++) {
                  const num = (ln + 1).toString().padStart(String(oldLines.length).length, ' ');
                  diffs.push(`- [${num}] ${oldLines[ln]}`);
                }
              }
            } catch {}
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
          const originalContentForDiff = content; // keep pristine for old-line numbering
          const fileHunkDiffs: Array<{
            oldStart: number;
            newStart: number;
            records: Array<{ type: ' ' | '-' | '+'; text: string }>;
          }> = [];

          // Apply hunks (supports LF and CRLF files)
          while (i < lines.length && !lines[i].startsWith('*** ')) {
            if (lines[i].startsWith('@@')) {
              i += 1; // skip hunk header or context identifier
            }
            const oldBlock: string[] = [];
            const newBlock: string[] = [];
            const records: Array<{ type: ' ' | '-' | '+'; text: string }> = [];
            while (
              i < lines.length &&
              !lines[i].startsWith('@@') &&
              !lines[i].startsWith('*** ')
            ) {
              const hl = lines[i];
              if (hl === '') {
                oldBlock.push('');
                newBlock.push('');
                records.push({ type: ' ', text: '' });
                i += 1;
                continue;
              }
              const prefix = hl[0];
              const body = hl.slice(1);
              if (prefix === ' ') {
                oldBlock.push(body);
                newBlock.push(body);
                records.push({ type: ' ', text: body });
              } else if (prefix === '-') {
                oldBlock.push(body);
                records.push({ type: '-', text: body });
              } else if (prefix === '+') {
                newBlock.push(body);
                records.push({ type: '+', text: body });
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
            // Determine starting line numbers for diff output
            const idxInCurrentLF = content.indexOf(oldTextLF);
            const idxInCurrentCRLF = content.indexOf(oldTextCRLF);
            const useCRLF = idxInCurrentLF === -1 && idxInCurrentCRLF !== -1;
            const idxInCurrent = useCRLF ? idxInCurrentCRLF : idxInCurrentLF;
            const idxInOriginalLF = originalContentForDiff.indexOf(oldTextLF);
            const idxInOriginalCRLF = originalContentForDiff.indexOf(oldTextCRLF);
            const idxInOriginal = idxInOriginalLF !== -1 ? idxInOriginalLF : idxInOriginalCRLF;
            if (idxInCurrent === -1) {
              return { status: 'error', data: `Hunk context not found while updating ${originalRel}.` };
            }
            const countLines = (s: string) => (s.match(/\n/g) || []).length + 1;
            const oldStart = idxInOriginal !== -1 ? countLines(originalContentForDiff.slice(0, idxInOriginal)) : countLines(content.slice(0, idxInCurrent));
            const newStart = countLines(content.slice(0, idxInCurrent));
            fileHunkDiffs.push({ oldStart, newStart, records });

            // Apply the actual replacement in content
            if (useCRLF) {
              content = content.replace(oldTextCRLF, newTextCRLF);
            } else {
              content = content.replace(oldTextLF, newTextLF);
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
          // Emit diff for updated file
          diffs.push(`File edited: ${relPath}`);
          if (fileHunkDiffs.length === 0) {
            diffs.push('(no line changes)');
          } else {
            for (const h of fileHunkDiffs) {
              let oldLine = h.oldStart;
              let newLine = h.newStart;
              for (const rec of h.records) {
                if (rec.type === ' ') {
                  oldLine += 1;
                  newLine += 1;
                } else if (rec.type === '-') {
                  const num = oldLine.toString();
                  diffs.push(`- [${num}] ${rec.text}`);
                  oldLine += 1;
                } else if (rec.type === '+') {
                  const num = newLine.toString();
                  diffs.push(`+ [${num}] ${rec.text}`);
                  newLine += 1;
                }
              }
            }
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

      // Combine summary and diffs for user display
      const summary = results.length ? results.join('\n') : 'Patch applied with no changes.';
      const diffDisplay = diffs.length ? `\n\nChanges:\n${diffs.join('\n')}` : '';
      return { status: 'success', data: summary + diffDisplay };
    } catch (e: any) {
      return { status: 'error', data: `An error occurred applying patch: ${e?.message || String(e)}` };
    }
  }
}