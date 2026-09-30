/** Keep filename titles useful after yt-dlp applies its restricted character set. */
export function getYtDlpOutputArgs(outputDir: string): string[] {
  return [
    '--restrict-filenames',
    // Use yt-dlp's own sanitization, including accent and Unicode normalization.
    // fulltitle preserves empty extractor titles before yt-dlp invents a title.
    // A separate field preserves the original title for captions and metadata.
    '--parse-metadata',
    '%(fulltitle|)#S:%(tgmr_filename_title)s',
    '--replace-in-metadata',
    'tgmr_filename_title',
    '^[^A-Za-z0-9]*$',
    'no title',
    '--output',
    `${outputDir}/%(tgmr_filename_title|no title)s-%(id)s.%(ext)s`,
  ];
}
