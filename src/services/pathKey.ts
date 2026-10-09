/**
 * A file path as the file system compares it. Windows and macOS ignore case,
 * and VS Code spells a Windows drive letter `c:` where `path.resolve` gives
 * `C:`, so an exact string comparison there can miss the same file.
 * Pure: no `vscode`, so the CLI and the MCP server may bundle it.
 */

import * as path from 'path';

/** `filePath` resolved, and lower-cased where the file system ignores case. */
export function pathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(filePath);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}
