import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTwitterPostStatus } from '../src/services/twitterPostStatus.js';

const url = 'https://x.com/hitw93/status/2104827273790804405';
const tombstone = (text: string): object => ({
  __typename: 'TweetTombstone',
  tombstone: { text: { text } },
});

test('X status check recognizes the observed deleted-post response using a public request', async (t) => {
  const request = t.mock.method(
    globalThis,
    'fetch',
    async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify(tombstone('This Post was deleted by the Post author. Learn more')),
      ),
  );
  assert.equal(await getTwitterPostStatus(`${url}?secret=not-forwarded`), 'deleted');
  const [input, init] = request.mock.calls[0].arguments;
  assert.ok(input instanceof URL);
  assert.ok(init);
  const endpoint = new URL(input);
  assert.equal(endpoint.origin, 'https://cdn.syndication.twimg.com');
  assert.equal(endpoint.pathname, '/tweet-result');
  assert.equal(endpoint.searchParams.get('id'), '2104827273790804405');
  assert.equal(endpoint.searchParams.get('token'), '53oictwwcy');
  assert.equal(endpoint.searchParams.get('lang'), 'en');
  assert.ok(!endpoint.searchParams.has('secret'));
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { accept: 'application/json', 'user-agent': 'Googlebot' });
});

test('X status check accepts canonical aliases and photo URLs', async (t) => {
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(tombstone('This Post is unavailable.'))),
  );
  for (const link of [
    'https://twitter.com/user/status/123/photo/1',
    'https://mobile.x.com/i/web/status/123',
    'https://x.com/i/status/123/',
  ]) {
    assert.equal(await getTwitterPostStatus(link), 'unavailable');
  }
  assert.equal(request.mock.callCount(), 3);
});

test('X status check ignores other sites, invalid protocols and non-post URLs', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Must not fetch');
  });
  for (const link of [
    'https://instagram.com/p/123',
    'https://notx.com/user/status/123',
    'https://x.com.example.org/user/status/123',
    'ftp://x.com/user/status/123',
    'https://x.com/user',
    'not a URL',
  ]) {
    assert.equal(await getTwitterPostStatus(link), null);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('only explicit deletion tombstones prove that a post was deleted', async (t) => {
  for (const data of [
    {},
    null,
    [],
    { errors: [{ message: 'Not found' }] },
    { __typename: 'Tweet', text: 'This Post was deleted by the Post author.' },
    { __typename: 'TweetTombstone' },
    tombstone(''),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(data)));
    assert.equal(await getTwitterPostStatus(url), null);
  }
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(tombstone('This Post is unavailable.'))),
  );
  assert.equal(await getTwitterPostStatus(url), 'unavailable');
});

test('HTTP failures, malformed data and timeouts leave post status unknown', async (t) => {
  for (const status of [403, 404, 429, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
    assert.equal(await getTwitterPostStatus(url), null);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  assert.equal(await getTwitterPostStatus(url), null);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  });
  assert.equal(await getTwitterPostStatus(url), null);
});
