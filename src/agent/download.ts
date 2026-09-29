import axios from 'axios';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { AgentError, errorMessage } from './util';

export interface DownloadedFiles { paths: string[]; cleanup(): Promise<void> }
export type DownloadFn = (urls: string[], signal?: AbortSignal) => Promise<DownloadedFiles>;

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'application/pdf': '.pdf',
};

/** Downloads media URLs into a fresh OS temp dir. Call cleanup() when done. */
export const downloadToTemp: DownloadFn = async (urls, signal) => {
  const dir = await mkdtemp(join(tmpdir(), 'sk-upload-'));
  const cleanup = async (): Promise<void> => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); };
  const paths: string[] = [];
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!/^https?:\/\//i.test(url)) throw new AgentError('UPLOAD_FAILED', `Unsupported media URL scheme`);
      const res = await axios.get<Readable>(url, { responseType: 'stream', timeout: 120_000, signal });
      let name = basename(new URL(url).pathname) || `file${i}`;
      name = name.replace(/[^\w.\-]/g, '_').slice(-80);
      if (!extname(name)) {
        const ct = String(res.headers['content-type'] ?? '').split(';')[0].trim();
        name += EXT_BY_TYPE[ct] ?? '';
      }
      const target = join(dir, `${i}_${name}`);
      await pipeline(res.data, createWriteStream(target));
      paths.push(target);
    }
    return { paths, cleanup };
  } catch (e) {
    await cleanup();
    if (e instanceof AgentError) throw e;
    throw new AgentError('UPLOAD_FAILED', `Media download failed: ${errorMessage(e)}`);
  }
};
