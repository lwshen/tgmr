import { escapeMarkdownV2, escapeMarkdownV2Url, normalizeLineBreaks } from './markdown.js';
import type { MediaMetadata } from '../services/downloader.js';

// Telegram media captions are capped at 1024 chars.
const TELEGRAM_CAPTION_MAX = 1024;

export interface CaptionMediaItem {
  isVideo: boolean;
  streamInfo: string;
  fileSizeMB: string;
}

type CaptionMetadata = Pick<
  MediaMetadata,
  'title' | 'description' | 'authorName' | 'authorUsername'
>;

/** Budget escaped text by code point to preserve newlines and whole emoji. */
function truncateForCaption(text: string, budget: number): string {
  if (budget <= 0) return '';
  const escaped = escapeMarkdownV2(text);
  if (escaped.length <= budget) return escaped;
  let truncated = '';
  for (const char of text) {
    const next = escapeMarkdownV2(char);
    if (truncated.length + next.length > budget - 1) break;
    truncated += next;
  }
  return truncated.trimEnd() + '…';
}

function buildPostCaption(
  metadata: CaptionMetadata,
  url: string,
  infoBlock = '',
  includeBody = true,
): string {
  const name = (metadata.authorName ?? '').replace(/\s+/g, ' ').trim();
  const username = (metadata.authorUsername ?? '').replace(/\s+/g, ' ').trim().replace(/^@+/, '');
  const author =
    name && username && name !== username && name !== `@${username}`
      ? `${name} (@${username})`
      : username
        ? `@${username}`
        : name || 'Original post';
  const label = truncateForCaption(author, 256);
  let footer = `🔗 [${label}](${escapeMarkdownV2Url(url)})`;
  // An exceptionally long URL cannot fit in a caption; keep the author text.
  if (footer.length > TELEGRAM_CAPTION_MAX) footer = `🔗 ${label}`;
  let suffix = infoBlock ? `${infoBlock}\n\n${footer}` : footer;
  if (suffix.length > TELEGRAM_CAPTION_MAX) suffix = footer;
  const body = includeBody
    ? truncateForCaption(
        normalizeLineBreaks(metadata.description ?? metadata.title),
        TELEGRAM_CAPTION_MAX - suffix.length - 2,
      )
    : '';
  return body ? `${body}\n\n${suffix}` : suffix;
}

export function buildSingleCaption(
  metadata: CaptionMetadata,
  url: string,
  item: CaptionMediaItem,
  showInfo = false,
  includeBody = true,
): string {
  const infoBlock = showInfo
    ? `\`${escapeMarkdownV2(item.streamInfo)}, ${escapeMarkdownV2(item.fileSizeMB)}MB\``
    : '';
  return buildPostCaption(metadata, url, infoBlock, includeBody);
}

export function buildGroupCaption(
  metadata: CaptionMetadata,
  url: string,
  chunk: CaptionMediaItem[],
  isFirstChunk: boolean,
  showInfo = false,
): string {
  if (!showInfo) return buildPostCaption(metadata, url, '', isFirstChunk);
  const imageFormats = new Map<string, { count: number; codec: string; dims: string | null }>();
  const videoFormats = new Map<string, { count: number; codec: string; dims: string | null }>();
  let chunkTotalSize = 0;

  for (const item of chunk) {
    const tokens = item.streamInfo.trim().split(/\s+/);
    const codec = tokens[0] || 'unknown';
    // Only accept WxH — otherwise the token is bitrate/sample-rate from an
    // audio stream, not dimensions. Prevents "opus image at 128kbps" for audio.
    const dims = tokens[1] && /^\d+x\d+$/.test(tokens[1]) ? tokens[1] : null;
    const key = `${codec}-${dims ?? ''}`;

    if (item.isVideo) {
      const existing = videoFormats.get(key) || { count: 0, codec, dims };
      videoFormats.set(key, { ...existing, count: existing.count + 1 });
    } else {
      const existing = imageFormats.get(key) || { count: 0, codec, dims };
      imageFormats.set(key, { ...existing, count: existing.count + 1 });
    }
    chunkTotalSize += parseFloat(item.fileSizeMB) || 0;
  }

  const formatParts: string[] = [];
  if (imageFormats.size > 0) {
    const summary = Array.from(imageFormats.values())
      .map((i) => {
        const suffix = i.dims ? ` at ${i.dims}` : '';
        return `${i.count} ${i.codec} image${i.count > 1 ? 's' : ''}${suffix}`;
      })
      .join(', ');
    formatParts.push(summary);
  }
  if (videoFormats.size > 0) {
    const summary = Array.from(videoFormats.values())
      .map((i) => {
        const suffix = i.dims ? ` at ${i.dims}` : '';
        return `${i.count} ${i.codec} video${i.count > 1 ? 's' : ''}${suffix}`;
      })
      .join(', ');
    formatParts.push(summary);
  }

  const escapedSize = escapeMarkdownV2(chunkTotalSize.toFixed(1));
  const escapedSummary = escapeMarkdownV2(formatParts.join(', '));
  const sizeLabel = escapedSummary
    ? `\`${escapedSummary}, ${escapedSize}MB total\``
    : `\`${escapedSize}MB total\``;

  return buildPostCaption(metadata, url, sizeLabel, isFirstChunk);
}
