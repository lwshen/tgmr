import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSingleCaption,
  buildGroupCaption,
  type CaptionMediaItem,
} from '../src/utils/caption.js';

const TELEGRAM_CAPTION_MAX = 1024;
const videoItem: CaptionMediaItem = {
  isVideo: true,
  streamInfo: 'h264 1920x1080',
  fileSizeMB: '12.3',
};
const url = 'https://x.com/YEngXX/status/123';
const metadata = {
  title: 'Short extracted title',
  description: '帖子正文内容\n第二行\n\n第二段',
  authorName: 'User Nickname',
  authorUsername: 'YEngXX',
};
const footer = '🔗 [User Nickname \\(@YEngXX\\)](https://x.com/YEngXX/status/123)';

test('captions show post text with its line breaks followed by the linked author', () => {
  assert.equal(
    buildSingleCaption(metadata, url, videoItem),
    `${metadata.description}\n\n${footer}`,
  );
});

test('captions escape body, author and link characters without duplicating @', () => {
  const caption = buildSingleCaption(
    { title: 'Text [link] *bold*.', authorName: 'Nick_[x]\nName', authorUsername: '@@user_name' },
    'https://example.com/video_(1)',
    videoItem,
  );
  assert.equal(
    caption,
    'Text \\[link\\] \\*bold\\*\\.\n\n🔗 [Nick\\_\\[x\\] Name \\(@user\\_name\\)](https://example.com/video_(1\\))',
  );
});

test('missing author fields and empty post text have readable fallbacks', () => {
  for (const [author, expected] of [
    [{}, 'Original post'],
    [{ authorName: 'Nickname' }, 'Nickname'],
    [{ authorUsername: '@account' }, '@account'],
    [{ authorName: 'account', authorUsername: 'account' }, '@account'],
  ] as const) {
    assert.equal(
      buildSingleCaption({ title: 'Title', ...author }, url, videoItem),
      `Title\n\n🔗 [${expected}](${url})`,
    );
  }
  assert.equal(buildSingleCaption({ ...metadata, description: '' }, url, videoItem), footer);
});

test('+info adds technical details between the post text and author link', () => {
  const caption = buildSingleCaption(metadata, url, videoItem, true);
  assert.ok(caption.startsWith(metadata.description));
  assert.ok(caption.includes('h264 1920x1080, 12\\.3MB'));
  assert.ok(caption.endsWith(footer));
});

test('long captions fit the limit and retain the complete author link', () => {
  for (const description of ['x'.repeat(5000), '*_[]'.repeat(1000), '😀'.repeat(2000)]) {
    for (const showInfo of [false, true]) {
      const caption = buildSingleCaption({ ...metadata, description }, url, videoItem, showInfo);
      assert.ok(caption.length <= TELEGRAM_CAPTION_MAX);
      assert.ok(caption.includes('…'));
      assert.ok(caption.endsWith(footer));
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(caption),
        'caption must not split surrogate pairs',
      );
    }
  }
});

test('pathologically long URLs or author names cannot exceed the caption cap', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(2000);
  const caption = buildSingleCaption(metadata, longUrl, videoItem);
  assert.ok(caption.length <= TELEGRAM_CAPTION_MAX);
  assert.ok(caption.startsWith(metadata.description));
  assert.ok(caption.includes('User Nickname'));
  const longAuthor = buildSingleCaption(
    { ...metadata, authorName: '😀'.repeat(1000) },
    url,
    videoItem,
  );
  assert.ok(longAuthor.length <= TELEGRAM_CAPTION_MAX);
  assert.ok(longAuthor.endsWith('](' + url + ')'));
});

const chunk: CaptionMediaItem[] = [
  { isVideo: false, streamInfo: 'jpeg 800x600', fileSizeMB: '1.0' },
  { isVideo: false, streamInfo: 'jpeg 800x600', fileSizeMB: '2.0' },
  { isVideo: true, streamInfo: 'h264 1920x1080', fileSizeMB: '5.0' },
];

test('album captions use the same format and only include the body on the first batch', () => {
  assert.equal(
    buildGroupCaption(metadata, url, chunk, true),
    `${metadata.description}\n\n${footer}`,
  );
  assert.equal(buildGroupCaption(metadata, url, chunk, false), footer);
});

test('album +info retains media counts, total size and the author link for every batch', () => {
  for (const first of [true, false]) {
    const caption = buildGroupCaption(
      { ...metadata, description: 'x'.repeat(5000) },
      url,
      chunk,
      first,
      true,
    );
    assert.ok(caption.length <= TELEGRAM_CAPTION_MAX);
    assert.ok(caption.includes('2 jpeg images'));
    assert.ok(caption.includes('1 h264 video'));
    assert.ok(caption.includes('8\\.0MB total'));
    assert.ok(caption.endsWith(footer));
  }
});
