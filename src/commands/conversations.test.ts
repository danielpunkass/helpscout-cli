import { describe, expect, it, vi } from 'vitest';
import { client } from '../lib/api-client.js';
import { createConversationsCommand } from './conversations.js';

describe('conversations command', () => {
  it('documents assignee filtering for both users and teams', () => {
    const conversations = createConversationsCommand();
    const list = conversations.commands.find((command) => command.name() === 'list');
    const assignedTo = list?.options.find((option) => option.long === '--assigned-to');

    expect(assignedTo?.description).toBe('Filter by assignee user or team ID');
  });

  it('forwards the assignee ID with combined list filters', async () => {
    const listConversations = vi.spyOn(client, 'listConversations').mockResolvedValue({
      conversations: [],
      page: { number: 1, size: 0, totalElements: 0, totalPages: 0 },
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await createConversationsCommand().parseAsync([
        'node',
        'test',
        'list',
        '--status',
        'all',
        '--assigned-to',
        '987654',
        '--sort-field',
        'modifiedAt',
        '--sort-order',
        'asc',
        '--query',
        'assigned:"Questionnaires"',
      ]);

      expect(listConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'all',
          assignedTo: '987654',
          sortField: 'modifiedAt',
          sortOrder: 'asc',
          query: 'assigned:"Questionnaires"',
        })
      );
    } finally {
      output.mockRestore();
      listConversations.mockRestore();
    }
  });

  // The fork uses flat attachment commands; upstream nests them under an
  // `attachments` group. Merging upstream verbatim registers a second
  // `attachments` command, which Commander rejects at module scope — taking
  // the whole binary down, `helpscout mcp` included. These assertions pin the
  // fork's shape so that collision cannot come back on the next sync.
  it('registers attachment commands flat, not under an "attachments" group', () => {
    const conversations = createConversationsCommand();
    const names = conversations.commands.map((command) => command.name());

    expect(names).toContain('attachments');
    expect(names).toContain('attachment-download');
    expect(names).toContain('attachment-upload');
    expect(names).toContain('attachment-delete');

    // `attachments` must stay a leaf listing command, not a parent group.
    const attachments = conversations.commands.find((command) => command.name() === 'attachments');
    expect(attachments?.commands).toHaveLength(0);
  });

  it('registers attachment-download with output and force options', () => {
    const conversations = createConversationsCommand();
    const download = conversations.commands.find(
      (command) => command.name() === 'attachment-download'
    );

    expect(download).toBeDefined();
    expect(download?.registeredArguments.map((argument) => argument.name())).toEqual([
      'conversationId',
      'attachmentId',
    ]);
    expect(download?.options.map((option) => option.flags)).toEqual([
      '-o, --output <path>',
      '-f, --force',
    ]);
  });

  it('registers complete safe draft-reply lifecycle commands', () => {
    const conversations = createConversationsCommand();
    const legacyUpsert = conversations.commands.find((command) => command.name() === 'draft-reply');
    const drafts = conversations.commands.find((command) => command.name() === 'draft-replies');

    expect(legacyUpsert?.options.map((option) => option.flags)).toContain('--thread-id <id>');
    expect(drafts?.commands.map((command) => command.name())).toEqual([
      'list',
      'create',
      'update',
      'upsert',
    ]);
    expect(
      drafts?.commands.find((command) => command.name() === 'update')?.registeredArguments
    ).toHaveLength(2);
  });
});
