/** A file entry to be included in a ZIP archive. */
export interface ZipEntry {
  /** Absolute path to the file on disk. */
  path: string;
  /** Name to use inside the ZIP archive. */
  name: string;
  /** File size in bytes (used for Content-Length pre-calculation). */
  size: number;
}
