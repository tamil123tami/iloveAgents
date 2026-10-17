/**
 * dataBackup.js — export / import (backup & restore) of the app data that
 * iloveAgents keeps in the browser's localStorage.
 *
 * Design rules:
 *  - Only keys in BACKUP_SCHEMA are ever exported or restored (an allowlist).
 *    Anything else in a backup file is ignored and reported, never written.
 *  - Secrets are never exported. API keys live in sessionStorage, the
 *    automations key vault (ila_encrypted_vault_v2) is not in the allowlist, and
 *    any `apiKey` field found on an imported scheduled job is dropped.
 *  - Every value is type-checked before it is written. A malformed value skips
 *    that key only; the rest of a valid file is still restored.
 */

export const BACKUP_FORMAT = 'iloveagents-backup'
export const BACKUP_VERSION = 1
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024 // 10 MB

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'openrouter']

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isArrayOfObjects = (v) => Array.isArray(v) && v.every(isPlainObject)
const isArrayOfStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Allowlist of restorable keys. `validate` returns true for an acceptable value;
 * `sanitize` (optional) returns a cleaned copy to write; `label` is shown in the UI.
 */
export const BACKUP_SCHEMA = {
  ila_agent_collections: { label: 'Collections', validate: isArrayOfObjects },
  ila_favorites: { label: 'Favorites', validate: isArrayOfStrings },
  ila_prompt_history: { label: 'Prompt history', validate: isArrayOfObjects },
  ila_ratings: { label: 'Ratings', validate: isPlainObject },
  ila_rating_votes: { label: 'Rating votes', validate: isPlainObject },
  ila_analytics: { label: 'Analytics', validate: isArrayOfObjects },
  ila_execution_traces: { label: 'Execution traces', validate: isArrayOfObjects },
  ila_scheduled_jobs: {
    label: 'Scheduled jobs',
    validate: isArrayOfObjects,
    // Defense in depth: never restore a secret even if a file contains one.
    sanitize: (jobs) => jobs.map(({ apiKey, ...safeJob }) => safeJob),
  },
  ila_scheduler_results: { label: 'Scheduler results', validate: isArrayOfObjects },
  ila_session_spend: {
    label: 'Session spend',
    validate: (v) =>
      isPlainObject(v) &&
      isArrayOfObjects(v.runs) &&
      (v.totalSpend === undefined || (typeof v.totalSpend === 'number' && Number.isFinite(v.totalSpend))),
  },
  iloveAgents_history: { label: 'Run history', validate: isArrayOfObjects },
  iloveagents_default_provider: {
    label: 'Default provider',
    validate: (v) => typeof v === 'string' && PROVIDERS.includes(v),
    raw: true, // stored as a bare string, not JSON
  },
}

export const BACKUP_KEYS = Object.keys(BACKUP_SCHEMA)

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function readKey(storage, key) {
  const raw = storage.getItem(key)
  if (raw === null) return { found: false }
  if (BACKUP_SCHEMA[key].raw) return { found: true, value: raw }
  try {
    return { found: true, value: JSON.parse(raw) }
  } catch {
    return { found: false } // corrupt local value: leave it out of the backup
  }
}

/**
 * Collect every supported key that currently holds valid data.
 * @param {Storage} [storage]
 * @param {Date} [now]
 * @returns {{ format: string, version: number, exportedAt: string, data: Record<string, unknown> }}
 */
export function buildBackup(storage = localStorage, now = new Date()) {
  const data = {}
  for (const key of BACKUP_KEYS) {
    const { found, value } = readKey(storage, key)
    if (!found) continue
    const schema = BACKUP_SCHEMA[key]
    if (!schema.validate(value)) continue
    data[key] = schema.sanitize ? schema.sanitize(value) : value
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    data,
  }
}

/** File name such as `iloveagents-backup-2026-10-17.json`. */
export function backupFileName(now = new Date()) {
  return `iloveagents-backup-${now.toISOString().slice(0, 10)}.json`
}

/** Build the backup and trigger a browser download of it. Returns the backup object. */
export function downloadBackup(storage = localStorage, now = new Date()) {
  const backup = buildBackup(storage, now)
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = backupFileName(now)
  a.click()
  URL.revokeObjectURL(url)
  return backup
}

/**
 * Validate a parsed backup object without touching storage.
 * @param {unknown} backup
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   data: Record<string, unknown>,   // sanitized values that are safe to write
 *   restoredKeys: string[],
 *   skippedKeys: string[],           // allowlisted keys whose value was malformed
 *   ignoredKeys: string[],           // keys that are not in the allowlist
 * }}
 */
export function validateBackup(backup) {
  const empty = { data: {}, restoredKeys: [], skippedKeys: [], ignoredKeys: [] }

  if (!isPlainObject(backup) || backup.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'This is not an iloveAgents backup file.', ...empty }
  }
  if (!Number.isInteger(backup.version) || backup.version < 1 || backup.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: 'This backup was made by an unsupported version of iloveAgents.',
      ...empty,
    }
  }
  if (!isPlainObject(backup.data)) {
    return { ok: false, error: 'The backup file has no data section.', ...empty }
  }

  const data = {}
  const skippedKeys = []
  const ignoredKeys = []

  for (const key of Object.keys(backup.data)) {
    if (!hasOwn(BACKUP_SCHEMA, key)) {
      ignoredKeys.push(key)
      continue
    }
    const schema = BACKUP_SCHEMA[key]
    const value = backup.data[key]
    if (!schema.validate(value)) {
      skippedKeys.push(key)
      continue
    }
    data[key] = schema.sanitize ? schema.sanitize(value) : value
  }

  const restoredKeys = Object.keys(data)
  if (restoredKeys.length === 0) {
    return {
      ok: false,
      error: 'The backup file contains no valid data to restore.',
      data,
      restoredKeys,
      skippedKeys,
      ignoredKeys,
    }
  }
  return { ok: true, data, restoredKeys, skippedKeys, ignoredKeys }
}

/**
 * Parse JSON text from a file and validate it.
 * @param {string} text
 */
export function parseBackupText(text) {
  if (typeof text === 'string' && text.length > MAX_BACKUP_BYTES) {
    return {
      ok: false,
      error: 'The backup file is too large.',
      data: {},
      restoredKeys: [],
      skippedKeys: [],
      ignoredKeys: [],
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: 'The file is not valid JSON.',
      data: {},
      restoredKeys: [],
      skippedKeys: [],
      ignoredKeys: [],
    }
  }
  return validateBackup(parsed)
}

/**
 * Write validated data to storage. Only keys that passed validateBackup are
 * written, so callers must pass `result.data` from a successful validation.
 * @param {Record<string, unknown>} data
 * @param {Storage} [storage]
 * @returns {{ restored: string[], failed: string[] }} failed = writes the browser rejected (e.g. quota)
 */
export function restoreBackupData(data, storage = localStorage) {
  const restored = []
  const failed = []
  for (const key of Object.keys(data)) {
    if (!hasOwn(BACKUP_SCHEMA, key)) continue
    const schema = BACKUP_SCHEMA[key]
    try {
      storage.setItem(key, schema.raw ? data[key] : JSON.stringify(data[key]))
      restored.push(key)
    } catch {
      failed.push(key)
    }
  }
  return { restored, failed }
}
