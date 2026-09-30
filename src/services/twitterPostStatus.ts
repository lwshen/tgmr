export type TwitterPostStatus = 'deleted' | 'unavailable';

const STATUS_CHECK_TIMEOUT_MS = 5_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Best-effort diagnosis after extraction fails, using X's public embed API.
 * Missing data, HTTP errors, and timeouts are inconclusive, not proof of deletion.
 * This request never carries the downloader's cookies or per-site headers.
 */
export async function getTwitterPostStatus(url: string): Promise<TwitterPostStatus | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (
      !['x.com', 'twitter.com'].some(
        (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
      )
    ) {
      return null;
    }
    const match = parsed.pathname.match(
      /^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/,
    );
    if (!match) return null;

    const id = match[1];
    // Public embed token, computed like yt-dlp's Twitter syndication extractor.
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const endpoint = new URL('https://cdn.syndication.twimg.com/tweet-result');
    endpoint.search = new URLSearchParams({ id, lang: 'en', token }).toString();
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(STATUS_CHECK_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'Googlebot' },
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || data.__typename !== 'TweetTombstone') return null;
    if (!isRecord(data.tombstone) || !isRecord(data.tombstone.text)) return null;
    const reason = data.tombstone.text.text;
    if (typeof reason !== 'string' || !reason.trim()) return null;
    return /\b(?:post|tweet) (?:was|has been) deleted by (?:the (?:post|tweet) author|its author)\b/i.test(
      reason,
    )
      ? 'deleted'
      : 'unavailable';
  } catch {
    return null;
  }
}
