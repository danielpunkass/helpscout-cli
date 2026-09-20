import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpScoutCliError } from './errors.js';
import type { AttachmentDownload } from '../types/index.js';
import {
  downloadAttachmentToFile,
  parseContentDispositionFilename,
  resolveAttachmentOutputPath,
  safeAttachmentFilename,
  type DownloadAttachmentDeps,
} from './attachment-download.js';

describe('attachment download helpers', () => {
  let tempDir: string;
  let originalCwd: string;
  let resolveConversationId: ReturnType<typeof vi.fn>;
  let downloadAttachment: ReturnType<typeof vi.fn>;

  function deps(): DownloadAttachmentDeps {
    return {
      resolveConversationId: resolveConversationId as unknown as (ref: string) => Promise<number>,
      downloadAttachment: downloadAttachment as unknown as (
        conversationId: number,
        attachmentId: number
      ) => Promise<AttachmentDownload>,
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'helpscout-attachments-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    resolveConversationId = vi.fn().mockResolvedValue(3361978051);
    downloadAttachment = vi.fn().mockResolvedValue({
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="Invoice-BFFE9E51-0026.pdf"',
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses standard and RFC 5987 content-disposition filenames', () => {
    expect(parseContentDispositionFilename('attachment; filename="invoice.pdf"')).toBe(
      'invoice.pdf'
    );
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''invoice%20copy.pdf")).toBe(
      'invoice copy.pdf'
    );
    expect(
      parseContentDispositionFilename("attachment; filename*=UTF-8'en-us'invoice%20copy.pdf")
    ).toBe('invoice copy.pdf');
  });

  it('sanitizes attachment filenames and falls back to the attachment id', () => {
    expect(safeAttachmentFilename('../Invoice.pdf', 933302294)).toBe('Invoice.pdf');
    expect(safeAttachmentFilename('..\\Invoice.pdf', 933302294)).toBe('Invoice.pdf');
    expect(safeAttachmentFilename('', 933302294)).toBe('attachment-933302294');
  });

  it('resolves directory output paths using the attachment filename', async () => {
    const directory = path.join(tempDir, 'downloads');
    await mkdir(directory);

    await expect(resolveAttachmentOutputPath(directory, 'invoice.pdf')).resolves.toBe(
      path.join(directory, 'invoice.pdf')
    );
    await expect(resolveAttachmentOutputPath(`${directory}/`, 'invoice.pdf')).resolves.toBe(
      path.join(directory, 'invoice.pdf')
    );
  });

  it('downloads to the content-disposition filename by default', async () => {
    const result = await downloadAttachmentToFile('3361978051', '933302294', {}, deps());

    await expect(readFile(path.join(tempDir, 'Invoice-BFFE9E51-0026.pdf'))).resolves.toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46])
    );
    expect(resolveConversationId).toHaveBeenCalledWith('3361978051');
    expect(downloadAttachment).toHaveBeenCalledWith(3361978051, 933302294);
    expect(result).toEqual(
      expect.objectContaining({
        message: 'Attachment downloaded',
        conversationId: 3361978051,
        attachmentId: 933302294,
        filename: 'Invoice-BFFE9E51-0026.pdf',
        bytes: 4,
        contentType: 'application/pdf',
      })
    );
  });

  it('downloads into an output directory using the resolved filename', async () => {
    const directory = path.join(tempDir, 'downloads');
    await mkdir(directory);

    await downloadAttachmentToFile('#47156', '933302294', { output: directory }, deps());

    await expect(readFile(path.join(directory, 'Invoice-BFFE9E51-0026.pdf'))).resolves.toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46])
    );
    expect(resolveConversationId).toHaveBeenCalledWith('#47156');
  });

  it('downloads to an explicit file path', async () => {
    const outputPath = path.join(tempDir, 'custom-name.pdf');

    const result = await downloadAttachmentToFile(
      '3361978051',
      '933302294',
      { output: outputPath },
      deps()
    );

    await expect(readFile(outputPath)).resolves.toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    expect(result).toEqual(
      expect.objectContaining({ filename: 'custom-name.pdf', path: outputPath })
    );
  });

  it('fails on existing output unless force is set', async () => {
    const outputPath = path.join(tempDir, 'existing.pdf');
    await writeFile(outputPath, 'existing');

    await expect(
      downloadAttachmentToFile('3361978051', '933302294', { output: outputPath }, deps())
    ).rejects.toThrow(HelpScoutCliError);
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('existing');

    await downloadAttachmentToFile(
      '3361978051',
      '933302294',
      { output: outputPath, force: true },
      deps()
    );

    await expect(readFile(outputPath)).resolves.toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  });

  it('rejects invalid attachment ids before resolving the conversation', async () => {
    await expect(downloadAttachmentToFile('3361978051', 'abc', {}, deps())).rejects.toThrow(
      'Invalid attachment ID'
    );
    expect(resolveConversationId).not.toHaveBeenCalled();
  });
});
