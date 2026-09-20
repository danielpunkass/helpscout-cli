import { stat, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { client } from './api-client.js';
import { parseIdArg } from './command-utils.js';
import { HelpScoutCliError } from './errors.js';
import { outputJson } from './output.js';
import type { AttachmentDownload, AttachmentDownloadResult } from '../types/index.js';

export interface DownloadAttachmentDeps {
  resolveConversationId(ref: string): Promise<number>;
  downloadAttachment(conversationId: number, attachmentId: number): Promise<AttachmentDownload>;
}

export function parseContentDispositionFilename(
  contentDisposition: string | undefined
): string | undefined {
  if (!contentDisposition) return undefined;

  const filenameStar = contentDisposition.match(/filename\*=[^']*'[^']*'([^;]+)/i);
  if (filenameStar?.[1]) {
    try {
      return decodeURIComponent(filenameStar[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return filenameStar[1].trim().replace(/^"|"$/g, '');
    }
  }

  const filename = contentDisposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  return (filename?.[1] ?? filename?.[2])?.trim();
}

export function safeAttachmentFilename(filename: string | undefined, attachmentId: number): string {
  const cleaned = filename?.replaceAll(String.fromCharCode(0), '').trim();
  const base = cleaned ? path.basename(cleaned.replace(/\\/g, '/')) : '';
  return base && base !== '.' && base !== '..' ? base : `attachment-${attachmentId}`;
}

function isDirectoryOutput(output: string): boolean {
  return output.endsWith('/') || output.endsWith('\\');
}

export async function resolveAttachmentOutputPath(
  output: string | undefined,
  filename: string
): Promise<string> {
  if (!output) {
    return path.resolve(filename);
  }

  if (isDirectoryOutput(output)) {
    return path.resolve(output, filename);
  }

  try {
    const info = await stat(output);
    if (info.isDirectory()) {
      return path.resolve(output, filename);
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  return path.resolve(output);
}

export async function writeAttachmentFile(outputPath: string, data: Uint8Array, force?: boolean) {
  const directory = path.dirname(outputPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    await writeFile(tempPath, data, { flag: 'wx' });

    if (force) {
      await rename(tempPath, outputPath);
      return;
    }

    try {
      await link(tempPath, outputPath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new HelpScoutCliError(
          `Output file already exists: ${outputPath}. Use --force to overwrite.`,
          409
        );
      }
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function downloadAttachmentToFile(
  conversationRef: string,
  attachmentRef: string,
  options: { output?: string; force?: boolean },
  deps: DownloadAttachmentDeps = {
    resolveConversationId: (ref) => client.resolveConversationId(ref),
    downloadAttachment: (conversationId, attachmentId) =>
      client.downloadAttachment(conversationId, attachmentId),
  }
): Promise<AttachmentDownloadResult> {
  const attachmentId = parseIdArg(attachmentRef, 'attachment');
  const conversationId = await deps.resolveConversationId(conversationRef);
  const attachment = await deps.downloadAttachment(conversationId, attachmentId);
  const filename = safeAttachmentFilename(
    parseContentDispositionFilename(attachment.contentDisposition),
    attachmentId
  );
  const outputPath = await resolveAttachmentOutputPath(options.output, filename);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeAttachmentFile(outputPath, attachment.data, options.force);

  const result: AttachmentDownloadResult = {
    message: 'Attachment downloaded',
    conversationId,
    attachmentId,
    filename: path.basename(outputPath),
    path: outputPath,
    bytes: attachment.data.byteLength,
  };

  if (attachment.contentType) {
    result.contentType = attachment.contentType;
  }

  return result;
}

export async function downloadConversationAttachment(
  conversationRef: string,
  attachmentRef: string,
  options: { output?: string; force?: boolean },
  deps?: DownloadAttachmentDeps
): Promise<void> {
  outputJson(await downloadAttachmentToFile(conversationRef, attachmentRef, options, deps));
}
