/**
 * Derivation of the session-log directory layout.
 *
 * These two functions are byte-for-byte mirrors of the private helpers inside
 * `@deepseek-ai/dsh-session-persistence-jsonl` (its `projectKey` and
 * `encodeSegment`): the persistence layer exposes no path API and no delete
 * API, so a plugin that has to move a session directory must reproduce the
 * naming rules itself. Keep them in sync when the format changes — a mismatch
 * only ever produces "session directory not found", never a wrong deletion,
 * because every removal is validated against the encoded id first.
 *
 * @module dsh-session-recycle-bin/session-paths
 */

/** Characters a raw code unit may keep without escaping. */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/

/**
 * Escape one raw string into a single filesystem-safe path segment.
 *
 * Safe code units stay literal; every other unit (including `~`) becomes
 * `~XXXX`. Operating on code units preserves lone surrogates and neutralizes
 * `..`, separators and NUL before any filesystem use.
 *
 * @param {string} raw - the segment to encode; must be non-empty.
 * @returns {string} the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && SAFE_UNIT.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable project directory key for a workspace path.
 *
 * Filesystem and drive separators collapse into one `-`; unsafe code units use
 * the same `~XXXX` escape, and the result is bounded for filesystem component
 * limits. The mapping is intentionally lossy, exactly like the persistence
 * backend's.
 *
 * @param {string} cwd - the session's project directory.
 * @returns {string} the `--…--` project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE_UNIT.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Root directory name used by the backend when a session has no `cwd`. */
export const NO_CWD_DIR = '_no-cwd'

/**
 * Whether a decoded value is a plausible single path segment (no traversal).
 * @param {unknown} value - candidate.
 * @returns {boolean} true when it is a plain, traversal-free segment.
 */
export function isSafeSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
}
