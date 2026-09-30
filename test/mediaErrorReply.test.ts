import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'grammy';
import { handleMessage } from '../src/handlers/message.js';
import { MediaDownloader, type MediaMetadata } from '../src/services/downloader.js';
import { MediaError, getMediaErrorReply, type MediaErrorCode } from '../src/utils/mediaError.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const downloader = MediaDownloader.getInstance();
let nextId = 910000;

function requestContext(url: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const id = nextId++;
  const ctx = {
    message: { text: url, message_id: id },
    chat: { id, type: 'private' },
    from: { id },
    api: {
      sendChatAction: async () => true,
      editMessageText: async (_chatId: number, messageId: number, text: string) => {
        replies[messageId - 1] = text;
        return true;
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
  } as unknown as Context;
  return { ctx, replies };
}

for (const [code, expected] of [
  [
    'deleted',
    'This post was deleted by its author. Its media cannot be downloaded from this link.',
  ],
  [
    'unavailable',
    'This post is unavailable. It may be private, restricted, or no longer accessible.',
  ],
  ['authentication_required', 'This post requires login or access permission to download.'],
  ['no_media', 'No downloadable images or videos were found in this post.'],
  [
    'extraction_failed',
    'Could not read the media information from this link. Please try again later.',
  ],
] satisfies [MediaErrorCode, string][]) {
  test(`message handler sends a specific ${code} reply and retains diagnostics in logs`, async (t) => {
    const error = new MediaError(code, 'internal diagnostic with sensitive-token');
    const info = t.mock.method(downloader, 'getMediaInfo', async () => {
      throw error;
    });
    const download = t.mock.method(downloader, 'download', async () => {
      throw new Error('Must not download');
    });
    const log = t.mock.method(logger, 'error', () => {});
    const { ctx, replies } = requestContext(`https://${env.SUPPORTED_DOMAINS[0]}/watch?v=${code}`);
    await handleMessage(ctx);
    assert.deepEqual(replies, [expected]);
    assert.ok(!replies[0].includes('sensitive-token'));
    assert.equal(info.mock.callCount(), 1);
    assert.equal(download.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(log.mock.calls[0].arguments[1]?.error, error);
  });
}

test('concurrent requests share a failure, each receive its reason, and clear the in-flight entry', async (t) => {
  const error = new MediaError('deleted', 'Confirmed deleted');
  let rejectInfo!: (error: Error) => void;
  const pendingInfo = new Promise<MediaMetadata>((_resolve, reject) => {
    rejectInfo = reject;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const info = t.mock.method(downloader, 'getMediaInfo', () => {
    markStarted();
    return pendingInfo;
  });
  t.mock.method(logger, 'error', () => {});
  const url = `https://${env.SUPPORTED_DOMAINS[0]}/watch?v=shared-failure`;
  const first = requestContext(url);
  const second = requestContext(url);
  const firstRequest = handleMessage(first.ctx);
  await started;
  const secondRequest = handleMessage(second.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  rejectInfo(error);
  await Promise.all([firstRequest, secondRequest]);
  assert.equal(info.mock.callCount(), 1);
  assert.deepEqual(first.replies, [getMediaErrorReply(error)]);
  assert.deepEqual(second.replies, first.replies);

  const later = requestContext(url);
  await handleMessage(later.ctx);
  assert.equal(info.mock.callCount(), 2);
  assert.deepEqual(later.replies, first.replies);
});

test('unknown errors are kept out of the user reply', async (t) => {
  t.mock.method(downloader, 'getMediaInfo', async () => {
    throw new Error('secret-path-and-token');
  });
  t.mock.method(logger, 'error', () => {});
  const { ctx, replies } = requestContext(
    `https://${env.SUPPORTED_DOMAINS[0]}/watch?v=unknown-failure`,
  );
  await handleMessage(ctx);
  assert.deepEqual(replies, ['Failed to process media. Please try again later.']);
});

test('rate-limit failures keep a retry-later reply even when no media was returned', () => {
  const error = new MediaError('no_media', 'No media\n429 Too Many Requests');
  assert.equal(
    getMediaErrorReply(error),
    'This site is rate-limiting downloads. Please try again later.',
  );
});
