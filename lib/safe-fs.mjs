// Safe reads and writes for files the harness puts into projects it doesn't control.
//
// `harness init` writes into whatever repo it runs in, and a repo can contain symlinks. With
// plain fs calls, a cloned repo whose CLAUDE.md is a symlink to ~/.zshrc (or whose .claude/ is a
// symlink to another folder) would get the harness writing into that file. And checking whether
// a file exists before writing it leaves a window where it can be swapped. So here:
//   - every write must land inside the folder it's for (no symlinked parent leads out);
//   - the file itself is opened with O_NOFOLLOW, so the OS refuses a symlink atomically;
//   - "create if missing" is one O_EXCL open, not a check followed by a write.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } = constants;
/** 0 where the platform has no O_NOFOLLOW (Windows); the inside-check still applies there. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** @param {unknown} err @param {string} code */
const is = (err, code) => err instanceof Error && 'code' in err && err.code === code;

/**
 * Refuse a path that resolves outside `base` (a symlinked folder on the way, or `..`).
 * @param {string} base
 * @param {string} path
 */
function assertInside(base, path) {
  const realBase = realpathSync(base);
  const realParent = realpathSync(dirname(path));
  const rel = relative(realBase, realParent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realBase, rel) !== realParent) {
    throw new Error(`refusing to write ${relative(base, path)}: its folder leads outside ${base} (a symlink?)`);
  }
}

/**
 * Always throws: a clear message for a symlink, otherwise the original error.
 * @param {string} path
 * @param {unknown} err
 * @returns {never}
 */
function refuseSymlink(path, err) {
  if (is(err, 'ELOOP') || is(err, 'EMLINK')) throw new Error(`refusing to use ${path}: it is a symlink`, { cause: err });
  throw err;
}

/**
 * Read a text file, or null if it doesn't exist. Refuses a symlink.
 * @param {string} path
 * @returns {string | null}
 */
export function readText(path) {
  let fd;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (is(err, 'ENOENT')) return null;
    refuseSymlink(path, err);
  }
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a text file inside `base`.
 * - mode 'create': only if it doesn't exist yet (atomic); returns false if it already did.
 * - mode 'replace': create or overwrite.
 * - mode 'append': create or add to the end.
 * @param {string} base  the folder the file must stay inside (the project or the repo root)
 * @param {string} rel   path relative to base
 * @param {string} content
 * @param {'create' | 'replace' | 'append'} mode
 * @returns {boolean} whether the file was written
 */
export function writeText(base, rel, content, mode) {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  assertInside(base, path);
  const flags = O_WRONLY | O_CREAT | O_NOFOLLOW | (mode === 'create' ? O_EXCL : mode === 'append' ? O_APPEND : O_TRUNC);
  let fd;
  try {
    fd = openSync(path, flags, 0o644);
  } catch (err) {
    if (mode === 'create' && is(err, 'EEXIST')) return false;
    refuseSymlink(rel, err);
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Is `rel` safe for another program (tsc) to write inside `base`? Its folder exists inside `base`
 * and the file is not a symlink. Used where the harness can't do the write itself.
 * @param {string} base
 * @param {string} rel
 */
export function safeToWrite(base, rel) {
  const path = join(base, rel);
  try {
    mkdirSync(dirname(path), { recursive: true });
    assertInside(base, path);
    return !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink();
  } catch {
    return false;
  }
}
