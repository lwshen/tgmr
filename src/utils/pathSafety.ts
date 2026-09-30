import { isAbsolute, relative, resolve, sep } from 'path';

/**
 * Validates that a file path resolves to a location strictly inside the base directory.
 * Rejects paths equal to baseDir itself (only files within it are allowed).
 * Uses path.relative for cross-platform safety.
 */
export function assertSafePath(filePath: string, baseDir: string): string {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  const rel = relative(base, resolved);
  // Only a complete parent-directory segment escapes the base. Filenames
  // such as "...-video.mp4" and "..album" are valid children.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${filePath} is outside ${baseDir}`);
  }
  return resolved;
}
