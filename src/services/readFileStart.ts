/**
 * The start of a file, never more: the folder looks (the start screen's,
 * the quick SQL import's) run over files the user did not pick, and a folder
 * of database dumps holds files of gigabytes. And how a script's bytes become
 * text: by its byte order mark (SQL Server Management Studio saves UTF-16),
 * else UTF-8. vscode-free.
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

/** A file's size in bytes, or undefined when it cannot be read. */
export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return undefined;
  }
}

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be';

/**
 * The encoding of a text file's bytes: its byte order mark (`FF FE` UTF-16
 * little endian, `FE FF` big endian, `EF BB BF` UTF-8), else UTF-16 when the
 * first bytes look like it (ASCII text with every other byte zero, as a
 * UTF-16 file saved without a mark), else UTF-8.
 */
export function detectTextEncoding(bytes: Uint8Array): TextEncodingName {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  const n = Math.min(bytes.length & ~1, 256);
  if (n >= 8) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < n; i += 2) {
      if (bytes[i] === 0) evenZero++;
      if (bytes[i + 1] === 0) oddZero++;
    }
    const pairs = n / 2;
    if (oddZero >= pairs * 0.9 && evenZero === 0) return 'utf-16le';
    if (evenZero >= pairs * 0.9 && oddZero === 0) return 'utf-16be';
  }
  return 'utf-8';
}

/**
 * A text file's bytes as text ({@link detectTextEncoding}), without its byte
 * order mark. A cut-off last character (the start of a file) becomes U+FFFD.
 */
export function decodeText(bytes: Uint8Array): string {
  const encoding = detectTextEncoding(bytes);
  let text: string;
  if (encoding === 'utf-16be') {
    // Swapped to little endian: Node always has the UTF-16LE decoder.
    const swapped = new Uint8Array(bytes.length & ~1);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    text = new TextDecoder('utf-16le').decode(swapped);
  } else {
    text = new TextDecoder(encoding).decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The start of a file as text, at most `chars` characters (bytes enough for any encoding are read). */
export async function readTextStart(filePath: string, chars: number): Promise<string> {
  return decodeText(await readFileStart(filePath, chars * 4)).slice(0, chars);
}
