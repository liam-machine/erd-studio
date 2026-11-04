/**
 * The start of a file, never more: the folder looks (the start screen's,
 * the quick SQL import's) run over files the user did not pick, and a folder
 * of database dumps holds files of gigabytes. vscode-free.
 */

import { promises as fsp } from 'fs';

/** The first `bytes` bytes of a file. */
export async function readFileStart(filePath: string, bytes: number): Promise<Uint8Array> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
