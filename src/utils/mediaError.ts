import { isRateLimitError } from './hostCooldown.js';

export type MediaErrorCode =
  'deleted' | 'unavailable' | 'authentication_required' | 'no_media' | 'extraction_failed';

/** Keeps diagnostic details in logs while giving users a safe, specific reply. */
export class MediaError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MediaError';
  }
}

/** Contains only size details that are safe to show in a Telegram reply. */
export class MediaSizeLimitError extends Error {
  constructor(sizeBytes: number, limitBytes: number, scope: 'file' | 'album' = 'file') {
    const subject = scope === 'album' ? 'Album total' : 'Media file';
    super(
      `${subject} (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB) exceeds size limit (${limitBytes / (1024 * 1024)}MB)`,
    );
    this.name = 'MediaSizeLimitError';
  }
}

const USER_MESSAGES: Record<MediaErrorCode, string> = {
  deleted: 'This post was deleted by its author. Its media cannot be downloaded from this link.',
  unavailable: 'This post is unavailable. It may be private, restricted, or no longer accessible.',
  authentication_required: 'This post requires login or access permission to download.',
  no_media: 'No downloadable images or videos were found in this post.',
  extraction_failed: 'Could not read the media information from this link. Please try again later.',
};

export function getMediaErrorReply(error: unknown): string {
  if (error instanceof MediaSizeLimitError) {
    return error.message;
  }
  if (isRateLimitError(error)) {
    return 'This site is rate-limiting downloads. Please try again later.';
  }
  return error instanceof MediaError
    ? USER_MESSAGES[error.code]
    : 'Failed to process media. Please try again later.';
}
