import { describe, it, expect } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_KEYS,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  backupFileName,
  buildBackup,
  parseBackupText,
  restoreBackupData,
  validateBackup,
} from './dataBackup'

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    },
    keys: () => [...map.keys()],
  }
}

const NOW = new Date('2026-10-17T10:00:00.000Z')

const validStore = () =>
  createStorage({
    ila_favorites: JSON.stringify(['code-reviewer', 'regex-generator']),
    ila_agent_collections: JSON.stringify([{ id: 'c1', name: 'Mine', agentIds: ['code-reviewer'] }]),
    ila_ratings: JSON.stringify({ 'code-reviewer': { up: 2, down: 0 } }),
    ila_session_spend: JSON.stringify({ runs: [{ cost: 0.01 }], totalSpend: 0.01 }),
    iloveagents_default_provider: 'anthropic',
  })

describe('buildBackup', () => {
  it('exports only supported keys that hold data', () => {
    const backup = buildBackup(validStore(), NOW)
    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.version).toBe(BACKUP_VERSION)
    expect(backup.exportedAt).toBe('2026-10-17T10:00:00.000Z')
    expect(Object.keys(backup.data).sort()).toEqual(
      [
        'ila_agent_collections',
        'ila_favorites',
        'ila_ratings',
        'ila_session_spend',
        'iloveagents_default_provider',
      ].sort(),
    )
    expect(backup.data.iloveagents_default_provider).toBe('anthropic')
  })

  it('never exports API keys, the automation key vault, or unrelated keys', () => {
    const store = validStore()
    store.setItem('ila_encrypted_vault_v2', JSON.stringify({ a: 'secret' }))
    store.setItem('iloveagents_openai_key', 'sk-secret')
    store.setItem('ila_apikey_openai', 'sk-secret')
    store.setItem('ila_theme', 'dark')
    const json = JSON.stringify(buildBackup(store, NOW))
    expect(json).not.toContain('secret')
    expect(json).not.toContain('ila_encrypted_vault_v2')
    expect(json).not.toContain('ila_theme')
  })

  it('strips an apiKey field from scheduled jobs', () => {
    const store = createStorage({
      ila_scheduled_jobs: JSON.stringify([{ id: 'j1', agentId: 'a', apiKey: 'sk-leak' }]),
    })
    const backup = buildBackup(store, NOW)
    expect(backup.data.ila_scheduled_jobs).toEqual([{ id: 'j1', agentId: 'a' }])
    expect(JSON.stringify(backup)).not.toContain('sk-leak')
  })

  it('skips corrupt JSON and values with the wrong shape', () => {
    const store = createStorage({
      ila_favorites: '{not json',
      ila_ratings: JSON.stringify(['wrong', 'shape']),
      ila_agent_collections: JSON.stringify([{ id: 'c1' }]),
    })
    const backup = buildBackup(store, NOW)
    expect(Object.keys(backup.data)).toEqual(['ila_agent_collections'])
  })

  it('returns an empty data object when nothing is stored', () => {
    expect(buildBackup(createStorage(), NOW).data).toEqual({})
  })
})

describe('validateBackup', () => {
  const wrap = (data, overrides = {}) => ({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    data,
    ...overrides,
  })

  it('accepts a valid backup and lists restored keys', () => {
    const result = validateBackup(wrap({ ila_favorites: ['a', 'b'] }))
    expect(result.ok).toBe(true)
    expect(result.restoredKeys).toEqual(['ila_favorites'])
    expect(result.data).toEqual({ ila_favorites: ['a', 'b'] })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'backup'],
    ['the wrong format', wrap({}, { format: 'something-else' })],
    ['a missing format', { version: 1, data: {} }],
  ])('rejects %s', (_label, input) => {
    const result = validateBackup(input)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not an iloveAgents backup/i)
  })

  it.each([0, 2, 1.5, '1', null])('rejects unsupported version %s', (version) => {
    const result = validateBackup(wrap({ ila_favorites: ['a'] }, { version }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unsupported version/i)
  })

  it('rejects a missing or non-object data section', () => {
    expect(validateBackup(wrap(undefined)).ok).toBe(false)
    expect(validateBackup(wrap([])).ok).toBe(false)
    expect(validateBackup(wrap('x')).error).toMatch(/no data section/i)
  })

  it('ignores unexpected keys and reports them without restoring them', () => {
    const result = validateBackup(
      wrap({
        ila_favorites: ['a'],
        ila_encrypted_vault_v2: { evil: true },
        iloveagents_openai_key: 'sk-x',
        someRandomKey: 1,
      }),
    )
    expect(result.ok).toBe(true)
    expect(Object.keys(result.data)).toEqual(['ila_favorites'])
    expect(result.ignoredKeys.sort()).toEqual(
      ['ila_encrypted_vault_v2', 'iloveagents_openai_key', 'someRandomKey'].sort(),
    )
  })

  it('treats a __proto__ key as unexpected and does not pollute prototypes', () => {
    const text = '{"format":"iloveagents-backup","version":1,"data":{"__proto__":{"polluted":true},"ila_favorites":["a"]}}'
    const result = parseBackupText(text)
    expect(result.ok).toBe(true)
    expect(result.ignoredKeys).toContain('__proto__')
    expect({}.polluted).toBeUndefined()
    expect(result.data.polluted).toBeUndefined()
  })

  it('skips malformed values but keeps the valid ones', () => {
    const result = validateBackup(
      wrap({
        ila_favorites: [1, 2, 3],
        ila_agent_collections: [{ id: 'c1' }],
        ila_ratings: 'nope',
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.restoredKeys).toEqual(['ila_agent_collections'])
    expect(result.skippedKeys.sort()).toEqual(['ila_favorites', 'ila_ratings'])
  })

  it('fails when no key is valid', () => {
    const result = validateBackup(wrap({ ila_favorites: 'x', other: 1 }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no valid data/i)
  })

  it('only accepts known default providers', () => {
    expect(validateBackup(wrap({ iloveagents_default_provider: 'openai' })).ok).toBe(true)
    expect(validateBackup(wrap({ iloveagents_default_provider: 'evil-provider' })).ok).toBe(false)
    expect(validateBackup(wrap({ iloveagents_default_provider: 5 })).ok).toBe(false)
  })

  it('validates session spend structure', () => {
    expect(validateBackup(wrap({ ila_session_spend: { runs: [], totalSpend: 1.5 } })).ok).toBe(true)
    expect(validateBackup(wrap({ ila_session_spend: { runs: 'x' } })).ok).toBe(false)
    expect(validateBackup(wrap({ ila_session_spend: { runs: [], totalSpend: 'lots' } })).ok).toBe(false)
    expect(validateBackup(wrap({ ila_session_spend: { runs: [], totalSpend: Infinity } })).ok).toBe(false)
  })

  it('drops apiKey from imported scheduled jobs', () => {
    const result = validateBackup(
      wrap({ ila_scheduled_jobs: [{ id: 'j1', apiKey: 'sk-leak', cron: '* * * * *' }] }),
    )
    expect(result.ok).toBe(true)
    expect(result.data.ila_scheduled_jobs).toEqual([{ id: 'j1', cron: '* * * * *' }])
  })
})

describe('parseBackupText', () => {
  it('rejects text that is not JSON', () => {
    const result = parseBackupText('hello')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not valid JSON/i)
  })

  it('rejects oversized input', () => {
    const result = parseBackupText('x'.repeat(MAX_BACKUP_BYTES + 1))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/too large/i)
  })
})

describe('restoreBackupData', () => {
  it('writes JSON for structured keys and a bare string for the default provider', () => {
    const storage = createStorage()
    const { restored, failed } = restoreBackupData(
      { ila_favorites: ['a'], iloveagents_default_provider: 'gemini' },
      storage,
    )
    expect(failed).toEqual([])
    expect(restored.sort()).toEqual(['ila_favorites', 'iloveagents_default_provider'])
    expect(storage.getItem('ila_favorites')).toBe('["a"]')
    expect(storage.getItem('iloveagents_default_provider')).toBe('gemini')
  })

  it('never writes keys outside the allowlist', () => {
    const storage = createStorage()
    restoreBackupData({ ila_encrypted_vault_v2: { x: 1 }, ila_favorites: ['a'] }, storage)
    expect(storage.keys()).toEqual(['ila_favorites'])
  })

  it('reports keys the browser refuses to store', () => {
    const storage = createStorage()
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    const { restored, failed } = restoreBackupData({ ila_favorites: ['a'] }, storage)
    expect(restored).toEqual([])
    expect(failed).toEqual(['ila_favorites'])
  })
})

describe('round trip', () => {
  it('restores exactly what was exported', () => {
    const source = validStore()
    const text = JSON.stringify(buildBackup(source, NOW))

    const parsed = parseBackupText(text)
    expect(parsed.ok).toBe(true)

    const target = createStorage({ ila_favorites: JSON.stringify(['old']) })
    restoreBackupData(parsed.data, target)

    for (const key of Object.keys(parsed.data)) {
      expect(target.getItem(key)).toBe(source.getItem(key))
    }
    expect(JSON.parse(target.getItem('ila_favorites'))).toEqual(['code-reviewer', 'regex-generator'])
  })
})

describe('helpers', () => {
  it('names the backup file by date', () => {
    expect(backupFileName(NOW)).toBe('iloveagents-backup-2026-10-17.json')
  })

  it('covers every data set listed in the issue', () => {
    expect(BACKUP_KEYS).toEqual(
      expect.arrayContaining([
        'ila_agent_collections',
        'ila_favorites',
        'ila_prompt_history',
        'ila_ratings',
        'ila_rating_votes',
        'ila_analytics',
        'ila_execution_traces',
        'ila_scheduled_jobs',
        'ila_scheduler_results',
        'ila_session_spend',
        'iloveAgents_history',
        'iloveagents_default_provider',
      ]),
    )
  })
})
