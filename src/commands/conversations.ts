import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { lookup } from 'mime-types';
import { client } from '../lib/api-client.js';
import { config } from '../lib/config.js';
import { HelpScoutCliError, HelpScoutApiError } from '../lib/errors.js';
import {
  resolveAttachmentOutputPath,
  safeAttachmentFilename,
  writeAttachmentFile,
} from '../lib/attachment-download.js';
import { outputJson, htmlToPlainText, buildName } from '../lib/output.js';
import { withErrorHandling, requireConfirmation, parseIdArg } from '../lib/command-utils.js';
import { buildDateQuery } from '../lib/dates.js';
import { normalizeConversationStatus } from '../lib/conversation-status.js';
import type { Conversation, DraftConversationStatus, Thread } from '../types/index.js';

interface ParticipantInfo {
  name?: string;
  email?: string;
  messageCount: number;
  firstMessage?: string;
}

interface ConversationSummary {
  total: number;
  byStatus: Record<string, number>;
  byTag: Record<string, number>;
  conversations: Array<{
    id: number;
    subject: string;
    status: string;
    tags: string[];
    customer: ParticipantInfo;
    user: ParticipantInfo;
    noteCount: number;
  }>;
}

const MAX_MESSAGE_LENGTH = 300;

interface DownloadAttachmentOptions {
  output?: string;
  force?: boolean;
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH).trim() + '...';
}

function buildPersonName(info: { first?: string; last?: string } | undefined): string | undefined {
  if (!info) return undefined;
  return buildName(info.first, info.last);
}

function extractThreadInfo(threads: Thread[] | undefined): {
  customer: ParticipantInfo;
  user: ParticipantInfo;
  noteCount: number;
} {
  if (!threads?.length) {
    return {
      customer: { messageCount: 0 },
      user: { messageCount: 0 },
      noteCount: 0,
    };
  }

  const sortedThreads = [...threads].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const customerThreads = sortedThreads.filter((t) => t.type === 'customer');
  const userThreads = sortedThreads.filter((t) => t.type === 'message');
  const noteThreads = sortedThreads.filter((t) => t.type === 'note');

  const firstCustomerWithBody = customerThreads.find((t) => t.body);
  const firstUserWithBody = userThreads.find((t) => t.body);
  const mostRecentUserThread = userThreads[userThreads.length - 1];

  const customerSource = firstCustomerWithBody?.customer || firstCustomerWithBody?.createdBy;
  const userSource = mostRecentUserThread?.createdBy;

  return {
    customer: {
      name: buildPersonName(customerSource),
      email: customerSource?.email,
      messageCount: customerThreads.length,
      firstMessage: firstCustomerWithBody?.body
        ? truncate(htmlToPlainText(firstCustomerWithBody.body))
        : undefined,
    },
    user: {
      name: buildPersonName(userSource),
      email: userSource?.email,
      messageCount: userThreads.length,
      firstMessage: firstUserWithBody?.body
        ? truncate(htmlToPlainText(firstUserWithBody.body))
        : undefined,
    },
    noteCount: noteThreads.length,
  };
}

function summarizeConversations(conversations: Conversation[]): ConversationSummary {
  const byStatus: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  for (const conv of conversations) {
    byStatus[conv.status] = (byStatus[conv.status] || 0) + 1;

    for (const tag of conv.tags || []) {
      byTag[tag.name] = (byTag[tag.name] || 0) + 1;
    }
  }

  return {
    total: conversations.length,
    byStatus,
    byTag,
    conversations: conversations.map((c) => {
      const threadInfo = extractThreadInfo(c._embedded?.threads);
      return {
        id: c.id,
        subject: c.subject,
        status: c.status,
        tags: (c.tags || []).map((t) => t.name),
        ...threadInfo,
      };
    }),
  };
}

export function createConversationsCommand(): Command {
  const cmd = new Command('conversations').description('Conversation operations');

  cmd
    .command('list')
    .description('List conversations')
    .option('-m, --mailbox <id>', 'Filter by mailbox ID')
    .option('-s, --status <status>', 'Filter by status (active, all, closed, open, pending, spam)')
    .option('-t, --tag <tags>', 'Filter by tag(s), comma-separated')
    .option('--assigned-to <id>', 'Filter by assignee user or team ID')
    .option('--created-since <date>', 'Show conversations created after this date')
    .option('--created-before <date>', 'Show conversations created before this date')
    .option('--modified-since <date>', 'Show conversations modified after this date')
    .option('--modified-before <date>', 'Show conversations modified before this date')
    .option(
      '--sort-field <field>',
      'Sort by field (createdAt, modifiedAt, number, status, subject)'
    )
    .option('--sort-order <order>', 'Sort order (asc, desc)')
    .option('--page <number>', 'Page number')
    .option('--embed <resources>', 'Embed resources (threads)')
    .option(
      '-q, --query <query>',
      'Advanced search query (see https://docs.helpscout.com/article/47-search-filters-with-operators)'
    )
    .option('--summary', 'Output aggregated summary instead of full conversation list')
    .option('--all', 'Fetch every matching conversation across all pages (respects filters)')
    .action(
      withErrorHandling(
        async (options: {
          mailbox?: string;
          status?: string;
          tag?: string;
          assignedTo?: string;
          createdSince?: string;
          createdBefore?: string;
          modifiedSince?: string;
          modifiedBefore?: string;
          sortField?: string;
          sortOrder?: string;
          page?: string;
          embed?: string;
          query?: string;
          summary?: boolean;
          all?: boolean;
        }) => {
          const query = buildDateQuery(
            {
              createdSince: options.createdSince,
              createdBefore: options.createdBefore,
              modifiedSince: options.modifiedSince,
              modifiedBefore: options.modifiedBefore,
            },
            options.query
          );

          if (options.summary) {
            const allConversations = await client.listAllConversations({
              mailbox: options.mailbox,
              status: options.status,
              tag: options.tag,
              assignedTo: options.assignedTo,
              query,
              embed: 'threads',
            });
            const summary = summarizeConversations(allConversations);
            outputJson(summary);
            return;
          }

          if (options.all) {
            const allConversations = await client.listAllConversations({
              mailbox: options.mailbox,
              status: options.status,
              tag: options.tag,
              assignedTo: options.assignedTo,
              query,
              embed: options.embed,
            });
            outputJson({ conversations: allConversations, count: allConversations.length });
            return;
          }

          const result = await client.listConversations({
            mailbox: options.mailbox,
            status: options.status,
            tag: options.tag,
            assignedTo: options.assignedTo,
            sortField: options.sortField,
            sortOrder: options.sortOrder,
            page: options.page ? parseInt(options.page, 10) : undefined,
            embed: options.embed,
            query,
          });
          outputJson(result);
        }
      )
    );

  cmd
    .command('view')
    .description('View a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .option('--v3', 'Use the v3 endpoint — real actor types (incl. "system_user" for AI agents)')
    .action(
      withErrorHandling(async (id: string, options: { v3?: boolean }) => {
        const conversationId = await client.resolveConversationId(id);
        const conversation = options.v3
          ? await client.getConversationV3(conversationId, 'threads')
          : await client.getConversation(conversationId, 'threads');
        const threadInfo = extractThreadInfo(conversation._embedded?.threads);
        const result = {
          ...conversation,
          customer: threadInfo.customer,
          user: threadInfo.user,
        };
        outputJson(result, { plain: true });
      })
    );

  cmd
    .command('threads')
    .description('List threads for a conversation (defaults to email communications only)')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .option('--include-notes', 'Include internal notes')
    .option('--all', 'Show all thread types including lineitems, workflows, etc.')
    .option(
      '-t, --type <types>',
      'Filter by specific thread type(s), comma-separated (customer, message, note, lineitem, chat, phone, forwardchild, forwardparent, beaconchat)'
    )
    .option('--html', 'Output thread bodies as HTML (default is plain text)')
    .option('--v3', 'Use the v3 threads endpoint — real actor types (incl. "system_user")')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            includeNotes?: boolean;
            all?: boolean;
            type?: string;
            html?: boolean;
            v3?: boolean;
          }
        ) => {
          let threads = await client.getConversationThreads(
            await client.resolveConversationId(id),
            undefined,
            options.v3 ? 'v3' : 'v2'
          );

          if (options.type) {
            const types = options.type.split(',').map((t) => t.trim().toLowerCase());
            threads = threads.filter((t) => types.includes(t.type));
          } else if (!options.all) {
            const allowedTypes = options.includeNotes
              ? ['customer', 'message', 'note', 'chat', 'phone']
              : ['customer', 'message', 'chat', 'phone'];
            threads = threads.filter((t) => allowedTypes.includes(t.type));
          }

          outputJson(threads, { plain: !options.html });
        }
      )
    );

  cmd
    .command('delete')
    .description('Delete a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .option('-y, --yes', 'Skip confirmation')
    .action(
      withErrorHandling(async (id: string, options: { yes?: boolean }) => {
        requireConfirmation('conversation', options.yes);
        await client.deleteConversation(await client.resolveConversationId(id));
        outputJson({ message: 'Conversation deleted' });
      })
    );

  cmd
    .command('create')
    .description('Create a new conversation')
    .requiredOption('--subject <text>', 'Subject line')
    .requiredOption('--text <text>', 'Message body')
    .option('--customer-email <email>', 'Customer email (or use --customer-id)')
    .option('--customer-id <id>', 'Customer ID (or use --customer-email)')
    .option('-m, --mailbox <id>', 'Mailbox ID (defaults to configured default)')
    .option('--status <status>', 'Conversation status: active, closed, pending (default: active)')
    .option('--draft', 'Save as draft without sending')
    .option('--user <id>', 'User ID sending the message')
    .option('--assign-to <id>', 'Assign to user ID')
    .option('--tags <tags>', 'Comma-separated tag names')
    .action(
      withErrorHandling(
        async (options: {
          subject: string;
          text: string;
          customerEmail?: string;
          customerId?: string;
          mailbox?: string;
          status?: string;
          draft?: boolean;
          user?: string;
          assignTo?: string;
          tags?: string;
        }) => {
          if (options.customerEmail && options.customerId) {
            throw new HelpScoutCliError('Provide --customer-email or --customer-id, not both', 1);
          }
          if (!options.customerEmail && !options.customerId) {
            throw new HelpScoutCliError('Either --customer-email or --customer-id is required', 1);
          }

          const mailboxId = options.mailbox || config.getDefaultMailbox();
          if (!mailboxId) {
            throw new HelpScoutCliError(
              'Mailbox ID required. Use --mailbox or set a default with: helpscout mailboxes set-default <id>',
              1
            );
          }

          const customer = options.customerEmail
            ? { email: options.customerEmail }
            : { id: parseIdArg(options.customerId!, 'customer') };

          const result = await client.createConversation({
            subject: options.subject,
            customer,
            mailboxId: parseInt(String(mailboxId), 10),
            text: options.text,
            status: options.status,
            draft: options.draft,
            user: options.user ? parseIdArg(options.user, 'user') : undefined,
            assignTo: options.assignTo ? parseIdArg(options.assignTo, 'user') : undefined,
            tags: options.tags ? options.tags.split(',').map((t) => t.trim()) : undefined,
          });

          outputJson({
            message: 'Conversation created',
            id: result.id,
            url: result.url,
          });
        }
      )
    );

  cmd
    .command('status')
    .description('Update a conversation status')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .argument('<status>', 'New status (active, open, pending, closed, spam)')
    .action(
      withErrorHandling(async (id: string, status: string) => {
        const normalizedStatus = normalizeConversationStatus(status);
        await client.updateConversationStatus(
          await client.resolveConversationId(id),
          normalizedStatus
        );
        outputJson({ message: 'Conversation status updated', status: normalizedStatus });
      })
    );

  cmd
    .command('add-tag')
    .description('Add a tag to a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .argument('<tag>', 'Tag name')
    .action(
      withErrorHandling(async (id: string, tag: string) => {
        await client.addConversationTag(await client.resolveConversationId(id), tag);
        outputJson({ message: `Tag "${tag}" added` });
      })
    );

  cmd
    .command('remove-tag')
    .description('Remove a tag from a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .argument('<tag>', 'Tag name')
    .action(
      withErrorHandling(async (id: string, tag: string) => {
        await client.removeConversationTag(await client.resolveConversationId(id), tag);
        outputJson({ message: `Tag "${tag}" removed` });
      })
    );

  cmd
    .command('draft-reply')
    .description(
      'Upsert a draft reply (never sends; refuses ambiguous multiple-draft conversations)'
    )
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .requiredOption('--text <text>', 'Reply text')
    .option('--user <id>', 'User ID authoring the draft')
    .option('--thread-id <id>', 'Explicit draft thread ID to update')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            text: string;
            user?: string;
            threadId?: string;
          }
        ) => {
          const result = await client.upsertDraftReply(await client.resolveConversationId(id), {
            text: options.text,
            user: options.user ? parseIdArg(options.user, 'user') : undefined,
            threadId: options.threadId ? parseIdArg(options.threadId, 'thread') : undefined,
          });
          outputJson({ message: `Draft reply ${result.action}`, ...result });
        }
      )
    );

  const draftReplies = new Command('draft-replies').description(
    'Manage unsent draft replies; these commands never publish or send'
  );

  draftReplies
    .command('list')
    .description('List active draft replies with thread IDs, metadata, and body previews')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .action(
      withErrorHandling(async (id: string) => {
        const conversationId = await client.resolveConversationId(id);
        const drafts = await client.listDraftReplies(conversationId);
        outputJson({ conversationId, drafts, total: drafts.length });
      })
    );

  draftReplies
    .command('create')
    .description('Create a new unsent draft reply and verify its Resource-ID thread')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .requiredOption('--text <text>', 'Reply text')
    .option('--user <id>', 'User ID authoring the draft')
    .action(
      withErrorHandling(async (id: string, options: { text: string; user?: string }) => {
        const result = await client.createDraftReply(await client.resolveConversationId(id), {
          text: options.text,
          user: options.user ? parseIdArg(options.user, 'user') : undefined,
        });
        outputJson({ message: 'Draft reply created', ...result });
      })
    );

  draftReplies
    .command('update')
    .description('Update one specific unsent draft reply in place and verify it')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .argument('<threadId>', 'Draft reply thread ID')
    .requiredOption('--text <text>', 'Replacement reply text')
    .action(
      withErrorHandling(async (id: string, threadId: string, options: { text: string }) => {
        const result = await client.updateDraftReply(
          await client.resolveConversationId(id),
          parseIdArg(threadId, 'thread'),
          options.text
        );
        outputJson({ message: 'Draft reply updated', ...result });
      })
    );

  draftReplies
    .command('upsert')
    .description('Update the sole active draft or create one when none exists')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .requiredOption('--text <text>', 'Reply text')
    .option('--thread-id <id>', 'Explicit draft thread ID to update')
    .option('--user <id>', 'User ID authoring a newly created draft')
    .action(
      withErrorHandling(
        async (id: string, options: { text: string; threadId?: string; user?: string }) => {
          const result = await client.upsertDraftReply(await client.resolveConversationId(id), {
            text: options.text,
            threadId: options.threadId ? parseIdArg(options.threadId, 'thread') : undefined,
            user: options.user ? parseIdArg(options.user, 'user') : undefined,
          });
          outputJson({ message: `Draft reply ${result.action}`, ...result });
        }
      )
    );

  cmd.addCommand(draftReplies);

  cmd
    .command('draft-conversation')
    .description(
      'Create a new outbound draft conversation (never sends — review and send from the Help Scout UI)'
    )
    .requiredOption('--mailbox <id>', 'Mailbox ID to create the conversation in')
    .requiredOption('--customer-email <email>', 'Recipient customer email address')
    .requiredOption('--subject <subject>', 'Conversation subject')
    .requiredOption('--text <text>', 'Draft message body')
    .option('--user <id>', 'User ID authoring the draft')
    .option('--type <type>', 'Conversation type: email, chat, or phone (default email)')
    .option('--status <status>', 'Conversation status: active, pending, or closed (default active)')
    .option('--tag <tag...>', 'Tag to apply (repeatable)')
    .action(
      withErrorHandling(
        async (options: {
          mailbox: string;
          customerEmail: string;
          subject: string;
          text: string;
          user?: string;
          type?: 'email' | 'chat' | 'phone';
          status?: DraftConversationStatus;
          tag?: string[];
        }) => {
          const result = await client.createDraftConversation({
            mailboxId: parseIdArg(options.mailbox, 'mailbox'),
            customerEmail: options.customerEmail,
            subject: options.subject,
            text: options.text,
            user: options.user ? parseIdArg(options.user, 'user') : undefined,
            type: options.type,
            status: options.status,
            tags: options.tag,
          });
          outputJson({ message: 'Draft conversation created', conversationId: result.id });
        }
      )
    );

  cmd
    .command('note')
    .description('Add a note to a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#" (e.g. "#12345")')
    .requiredOption('--text <text>', 'Note text')
    .option('--user <id>', 'User ID adding the note')
    .option(
      '--status <status>',
      'Conversation status after adding the note (active, open, pending, closed, spam). If omitted, Help Scout treats the note as activity and reopens the conversation to "active"; pass a status (e.g. --status pending) to pin it and avoid reactivation.'
    )
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            text: string;
            user?: string;
            status?: string;
          }
        ) => {
          const status = options.status ? normalizeConversationStatus(options.status) : undefined;
          await client.createNote(await client.resolveConversationId(id), {
            text: options.text,
            user: options.user ? parseIdArg(options.user, 'user') : undefined,
            status,
          });
          outputJson({
            message: 'Note added',
            ...(status && { status }),
          });
        }
      )
    );

  cmd
    .command('update')
    .description('Update conversation properties without adding a thread')
    .argument('<id>', 'Conversation ID')
    .option('--status <status>', 'Change status (active, closed, pending, spam)')
    .option('--assignee <userId>', 'Assign to user ID (or "none" to unassign)')
    .option('--customer <customerId>', 'Change primary customer')
    .option('--subject <text>', 'Update subject line')
    .option('--mailbox <mailboxId>', 'Move to different mailbox')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            status?: string;
            assignee?: string;
            customer?: string;
            subject?: string;
            mailbox?: string;
          }
        ) => {
          const operations: Array<{ op: string; path: string; value?: unknown }> = [];

          if (options.status) {
            operations.push({ op: 'replace', path: '/status', value: options.status });
          }
          if (options.assignee === 'none') {
            operations.push({ op: 'remove', path: '/assignTo' });
          } else if (options.assignee) {
            operations.push({
              op: 'replace',
              path: '/assignTo',
              value: parseInt(options.assignee, 10),
            });
          }
          if (options.customer) {
            operations.push({
              op: 'replace',
              path: '/primaryCustomer.id',
              value: parseInt(options.customer, 10),
            });
          }
          if (options.subject) {
            operations.push({ op: 'replace', path: '/subject', value: options.subject });
          }
          if (options.mailbox) {
            operations.push({
              op: 'replace',
              path: '/mailbox',
              value: parseInt(options.mailbox, 10),
            });
          }

          if (operations.length === 0) {
            throw new Error('At least one update option is required');
          }

          await client.updateConversation(parseIdArg(id, 'conversation'), operations);
          outputJson({ message: 'Conversation updated' });
        }
      )
    );

  cmd
    .command('fields')
    .description('Get custom fields for a conversation')
    .argument('<id>', 'Conversation ID')
    .action(
      withErrorHandling(async (id: string) => {
        const fields = await client.getConversationFields(parseIdArg(id, 'conversation'));
        outputJson(fields);
      })
    );

  cmd
    .command('set-field')
    .description('Set a custom field value on a conversation (preserves other fields)')
    .argument('<id>', 'Conversation ID')
    .requiredOption('--field-id <fieldId>', 'Custom field ID')
    .requiredOption('--value <value>', 'Field value')
    .action(
      withErrorHandling(async (id: string, options: { fieldId: string; value: string }) => {
        const conversationId = parseIdArg(id, 'conversation');
        const fieldId = parseInt(options.fieldId, 10);

        // Fetch existing fields to preserve them
        const existingFields = await client.getConversationFields(conversationId);

        // Merge: update existing field or add new one
        const fieldExists = existingFields.some((f) => f.id === fieldId);
        const mergedFields = fieldExists
          ? existingFields.map((f) => (f.id === fieldId ? { id: fieldId, value: options.value } : { id: f.id, value: f.value }))
          : [...existingFields.map((f) => ({ id: f.id, value: f.value })), { id: fieldId, value: options.value }];

        await client.updateConversationFields(conversationId, mergedFields);
        outputJson({ message: 'Field updated' });
      })
    );

  cmd
    .command('update-thread')
    .description('Update a thread (change text or hide/unhide)')
    .argument('<conversationId>', 'Conversation ID')
    .argument('<threadId>', 'Thread ID')
    .option('--text <text>', 'Update thread text')
    .option('--hidden', 'Hide the thread')
    .option('--visible', 'Unhide the thread')
    .action(
      withErrorHandling(
        async (
          conversationId: string,
          threadId: string,
          options: {
            text?: string;
            hidden?: boolean;
            visible?: boolean;
          }
        ) => {
          if (options.hidden && options.visible) {
            throw new HelpScoutCliError('--hidden and --visible are mutually exclusive', 1);
          }
          if (!options.text && !options.hidden && !options.visible) {
            throw new HelpScoutCliError(
              'At least one option is required: --text, --hidden, or --visible',
              1
            );
          }

          const convId = parseIdArg(conversationId, 'conversation');
          const thrId = parseIdArg(threadId, 'thread');

          if (options.text) {
            await client.updateThread(convId, thrId, {
              op: 'replace',
              path: '/text',
              value: options.text,
            });
          }
          if (options.hidden) {
            await client.updateThread(convId, thrId, {
              op: 'replace',
              path: '/hidden',
              value: true,
            });
          }
          if (options.visible) {
            await client.updateThread(convId, thrId, {
              op: 'replace',
              path: '/hidden',
              value: false,
            });
          }

          outputJson({ message: 'Thread updated' });
        }
      )
    );

  // Snooze commands
  cmd
    .command('snooze')
    .description('Snooze a conversation until a specified date')
    .argument('<id>', 'Conversation ID')
    .requiredOption('--until <date>', 'Snooze until date (ISO 8601, e.g., 2026-02-10T09:00:00Z)')
    .option('--unsnooze-on-reply', 'Automatically unsnooze when customer replies')
    .action(
      withErrorHandling(
        async (id: string, options: { until: string; unsnoozeOnReply?: boolean }) => {
          await client.snoozeConversation(
            parseIdArg(id, 'conversation'),
            options.until,
            options.unsnoozeOnReply
          );
          outputJson({ message: 'Conversation snoozed', snoozedUntil: options.until });
        }
      )
    );

  cmd
    .command('unsnooze')
    .description('Immediately unsnooze a conversation')
    .argument('<id>', 'Conversation ID')
    .action(
      withErrorHandling(async (id: string) => {
        await client.unsnoozeConversation(parseIdArg(id, 'conversation'));
        outputJson({ message: 'Conversation unsnoozed' });
      })
    );

  // Attachment commands
  cmd
    .command('attachments')
    .description('List all attachments in a conversation (across all threads)')
    .argument('<id>', 'Conversation ID')
    .action(
      withErrorHandling(async (id: string) => {
        const result = await client.listConversationAttachments(parseIdArg(id, 'conversation'));
        outputJson(result);
      })
    );

  cmd
    .command('attachment-download')
    .description('Download an attachment')
    .argument('<conversationId>', 'Conversation ID')
    .argument('<attachmentId>', 'Attachment ID')
    .option('-o, --output <path>', 'Output file or directory (defaults to attachment filename)')
    .option('-f, --force', 'Overwrite existing output file')
    .action(
      withErrorHandling(
        async (
          conversationId: string,
          attachmentId: string,
          options: DownloadAttachmentOptions
        ) => {
          const convId = parseIdArg(conversationId, 'conversation');
          const attId = parseIdArg(attachmentId, 'attachment');

          // First, get attachment metadata to know the filename
          const { attachments } = await client.listConversationAttachments(convId);
          const attachment = attachments.find((a) => a.id === attId);

          // Prefer the streaming /file endpoint (raw bytes, no inflation); fall
          // back to the legacy base64 /data endpoint if streaming is unavailable.
          let data: Uint8Array;
          let method: 'stream' | 'base64-fallback';
          try {
            ({ data } = await client.downloadAttachment(convId, attId));
            method = 'stream';
          } catch (err) {
            const status = err instanceof HelpScoutApiError ? err.statusCode : undefined;
            if (status !== 404 && status !== 410) {
              throw err;
            }
            const fallback = await client.getAttachmentData(convId, attId);
            data = Buffer.from(fallback.data, 'base64');
            method = 'base64-fallback';
          }

          // Filename comes from the attachment record, not Content-Disposition —
          // listConversationAttachments always has it, the header often does not.
          const filename = safeAttachmentFilename(attachment?.filename, attId);
          const resolvedPath = await resolveAttachmentOutputPath(options.output, filename);

          await mkdir(dirname(resolvedPath), { recursive: true });
          await writeAttachmentFile(resolvedPath, data, options.force);

          outputJson({
            message: 'Attachment downloaded',
            path: resolvedPath,
            size: data.byteLength,
            filename: attachment?.filename,
            method,
          });
        }
      )
    );

  cmd
    .command('attachment-upload')
    .description('Upload an attachment to a thread')
    .argument('<conversationId>', 'Conversation ID')
    .argument('<threadId>', 'Thread ID')
    .requiredOption('-f, --file <path>', 'Path to file to upload')
    .option('--filename <name>', 'Override filename (defaults to original filename)')
    .option('--mime-type <type>', 'Override MIME type (auto-detected from extension)')
    .action(
      withErrorHandling(
        async (
          conversationId: string,
          threadId: string,
          options: { file: string; filename?: string; mimeType?: string }
        ) => {
          const convId = parseIdArg(conversationId, 'conversation');
          const thrId = parseIdArg(threadId, 'thread');

          // Read file and encode as base64
          const filePath = resolve(options.file);
          const fileBuffer = readFileSync(filePath);
          const base64Data = fileBuffer.toString('base64');

          // Determine filename and MIME type
          const fileName = options.filename || basename(filePath);
          const mimeType = options.mimeType || lookup(filePath) || 'application/octet-stream';

          await client.createAttachment(convId, thrId, {
            fileName,
            mimeType,
            data: base64Data,
          });

          outputJson({
            message: 'Attachment uploaded',
            filename: fileName,
            mimeType,
            size: fileBuffer.length,
          });
        }
      )
    );

  cmd
    .command('attachment-delete')
    .description('Delete an attachment (only works on draft conversations)')
    .argument('<conversationId>', 'Conversation ID')
    .argument('<attachmentId>', 'Attachment ID')
    .option('-y, --yes', 'Skip confirmation')
    .action(
      withErrorHandling(
        async (conversationId: string, attachmentId: string, options: { yes?: boolean }) => {
          requireConfirmation('attachment', options.yes);
          await client.deleteAttachment(
            parseIdArg(conversationId, 'conversation'),
            parseIdArg(attachmentId, 'attachment')
          );
          outputJson({ message: 'Attachment deleted' });
        }
      )
    );

  // Thread creation (customer/chat/phone). Customer is required as {id} or {email}.
  const buildThreadCustomer = (options: {
    customerId?: string;
    customerEmail?: string;
  }): { id: number } | { email: string } => {
    if (options.customerEmail && options.customerId) {
      throw new HelpScoutCliError('Provide --customer-id or --customer-email, not both', 400);
    }
    if (options.customerEmail) {
      return { email: options.customerEmail };
    }
    if (options.customerId) {
      return { id: parseIdArg(options.customerId, 'customer') };
    }
    throw new HelpScoutCliError('Either --customer-id or --customer-email is required', 400);
  };

  cmd
    .command('add-customer-thread')
    .description('Add a thread authored by the customer (use --imported to avoid reopening)')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .requiredOption('--text <text>', 'Thread text')
    .option('--customer-id <id>', 'Customer ID (or use --customer-email)')
    .option('--customer-email <email>', 'Customer email (or use --customer-id)')
    .option('--imported', 'Suppress notifications and do not reopen the conversation')
    .option('--created-at <date>', 'ISO 8601 timestamp (only meaningful with --imported)')
    .option('--cc <emails>', 'CC emails (comma-separated)')
    .option('--bcc <emails>', 'BCC emails (comma-separated)')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            text: string;
            customerId?: string;
            customerEmail?: string;
            imported?: boolean;
            createdAt?: string;
            cc?: string;
            bcc?: string;
          }
        ) => {
          const result = await client.createCustomerThread(await client.resolveConversationId(id), {
            text: options.text,
            customer: buildThreadCustomer(options),
            ...(options.imported && { imported: true }),
            ...(options.createdAt && { createdAt: options.createdAt }),
            ...(options.cc && { cc: options.cc.split(',').map((e) => e.trim()) }),
            ...(options.bcc && { bcc: options.bcc.split(',').map((e) => e.trim()) }),
          });
          outputJson({ message: 'Customer thread added', id: result.id });
        }
      )
    );

  cmd
    .command('add-chat-thread')
    .description('Add a chat thread to a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .requiredOption('--text <text>', 'Thread text')
    .option('--customer-id <id>', 'Customer ID (or use --customer-email)')
    .option('--customer-email <email>', 'Customer email (or use --customer-id)')
    .option('--imported', 'Suppress notifications')
    .option('--created-at <date>', 'ISO 8601 timestamp (only meaningful with --imported)')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            text: string;
            customerId?: string;
            customerEmail?: string;
            imported?: boolean;
            createdAt?: string;
          }
        ) => {
          const result = await client.createChatThread(await client.resolveConversationId(id), {
            text: options.text,
            customer: buildThreadCustomer(options),
            ...(options.imported && { imported: true }),
            ...(options.createdAt && { createdAt: options.createdAt }),
          });
          outputJson({ message: 'Chat thread added', id: result.id });
        }
      )
    );

  cmd
    .command('add-phone-thread')
    .description('Add a phone thread to a conversation')
    .argument('<id>', 'Conversation ID, or ticket number prefixed with "#"')
    .requiredOption('--text <text>', 'Thread text')
    .option('--customer-id <id>', 'Customer ID (or use --customer-email)')
    .option('--customer-email <email>', 'Customer email (or use --customer-id)')
    .option('--imported', 'Suppress notifications')
    .option('--created-at <date>', 'ISO 8601 timestamp (only meaningful with --imported)')
    .action(
      withErrorHandling(
        async (
          id: string,
          options: {
            text: string;
            customerId?: string;
            customerEmail?: string;
            imported?: boolean;
            createdAt?: string;
          }
        ) => {
          const result = await client.createPhoneThread(await client.resolveConversationId(id), {
            text: options.text,
            customer: buildThreadCustomer(options),
            ...(options.imported && { imported: true }),
            ...(options.createdAt && { createdAt: options.createdAt }),
          });
          outputJson({ message: 'Phone thread added', id: result.id });
        }
      )
    );

  cmd
    .command('thread-source')
    .description('Get a thread\'s original source (JSON, or raw RFC 822 with --rfc822)')
    .argument('<conversationId>', 'Conversation ID, or ticket number prefixed with "#"')
    .argument('<threadId>', 'Thread ID')
    .option('--rfc822', 'Output the raw RFC 822 message (.eml) instead of JSON')
    .option('-o, --output <path>', 'Write output to a file instead of stdout')
    .action(
      withErrorHandling(
        async (
          conversationId: string,
          threadId: string,
          options: { rfc822?: boolean; output?: string }
        ) => {
          const convId = await client.resolveConversationId(conversationId);
          const thrId = parseIdArg(threadId, 'thread');
          if (options.rfc822) {
            const raw = await client.getThreadSourceRfc822(convId, thrId);
            if (options.output) {
              const resolvedPath = resolve(options.output);
              writeFileSync(resolvedPath, raw);
              outputJson({ message: 'Source written', path: resolvedPath, size: raw.length });
            } else {
              process.stdout.write(raw);
            }
          } else {
            const source = await client.getThreadSource(convId, thrId);
            if (options.output) {
              const resolvedPath = resolve(options.output);
              writeFileSync(resolvedPath, source.original);
              outputJson({ message: 'Source written', path: resolvedPath });
            } else {
              outputJson(source);
            }
          }
        }
      )
    );

  cmd
    .command('schedule-thread')
    .description('Schedule a draft thread to send later (Send Later)')
    .argument('<conversationId>', 'Conversation ID, or ticket number prefixed with "#"')
    .argument('<threadId>', 'Thread ID')
    .requiredOption('--at <date>', 'When to send (ISO 8601, future)')
    .option('--unschedule-on-reply', 'Cancel the schedule if the customer replies first')
    .option('--send-as-creator', 'Send as the thread creator')
    .action(
      withErrorHandling(
        async (
          conversationId: string,
          threadId: string,
          options: { at: string; unscheduleOnReply?: boolean; sendAsCreator?: boolean }
        ) => {
          await client.updateThreadSchedule(
            await client.resolveConversationId(conversationId),
            parseIdArg(threadId, 'thread'),
            {
              scheduledFor: options.at,
              unscheduleOnCustomerReply: options.unscheduleOnReply ?? false,
              ...(options.sendAsCreator && { sendAsCreator: true }),
            }
          );
          outputJson({ message: 'Thread scheduled' });
        }
      )
    );

  cmd
    .command('publish-schedule')
    .description('Publish (send now) a scheduled thread')
    .argument('<conversationId>', 'Conversation ID, or ticket number prefixed with "#"')
    .argument('<threadId>', 'Thread ID')
    .action(
      withErrorHandling(async (conversationId: string, threadId: string) => {
        await client.publishThreadSchedule(
          await client.resolveConversationId(conversationId),
          parseIdArg(threadId, 'thread')
        );
        outputJson({ message: 'Scheduled thread published' });
      })
    );

  cmd
    .command('unschedule-thread')
    .description('Delete a thread schedule (revert to a plain draft)')
    .argument('<conversationId>', 'Conversation ID, or ticket number prefixed with "#"')
    .argument('<threadId>', 'Thread ID')
    .action(
      withErrorHandling(async (conversationId: string, threadId: string) => {
        await client.deleteThreadSchedule(
          await client.resolveConversationId(conversationId),
          parseIdArg(threadId, 'thread')
        );
        outputJson({ message: 'Thread schedule deleted' });
      })
    );

  return cmd;
}
