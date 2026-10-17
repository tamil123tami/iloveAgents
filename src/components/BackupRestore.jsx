import { useRef, useState } from 'react'
import { Download, Upload, DatabaseBackup, AlertTriangle, Check } from 'lucide-react'
import {
  BACKUP_SCHEMA,
  MAX_BACKUP_BYTES,
  downloadBackup,
  parseBackupText,
  restoreBackupData,
} from '../lib/dataBackup'

const buttonBase =
  'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors'

function describeKeys(keys) {
  return keys.map((k) => BACKUP_SCHEMA[k]?.label ?? k).join(', ')
}

/**
 * Export / import of the app's local data (favorites, history, collections, ...).
 * `reload` is injectable so tests can observe it; it defaults to a page reload so
 * every hook re-reads the restored data.
 */
export default function BackupRestore({ reload = () => window.location.reload() }) {
  const fileInputRef = useRef(null)
  const [pending, setPending] = useState(null) // validated import awaiting confirmation
  const [status, setStatus] = useState(null) // { type: 'success' | 'error', message }

  const handleExport = () => {
    try {
      const backup = downloadBackup()
      const count = Object.keys(backup.data).length
      setStatus({
        type: 'success',
        message:
          count === 0
            ? 'Exported a backup file, but there was no saved data to include yet.'
            : `Exported ${count} data ${count === 1 ? 'set' : 'sets'}. API keys are never included.`,
      })
    } catch {
      setStatus({ type: 'error', message: 'Could not create the backup file.' })
    }
  }

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = '' // allow picking the same file again later
    if (!file) return
    setPending(null)

    if (file.size > MAX_BACKUP_BYTES) {
      setStatus({ type: 'error', message: 'The backup file is too large.' })
      return
    }

    let text
    try {
      text = await file.text()
    } catch {
      setStatus({ type: 'error', message: 'Could not read that file.' })
      return
    }

    const result = parseBackupText(text)
    if (!result.ok) {
      setStatus({ type: 'error', message: result.error })
      return
    }
    setStatus(null)
    setPending(result)
  }

  const handleConfirmImport = () => {
    if (!pending) return
    const { restored, failed } = restoreBackupData(pending.data)
    const skipped = pending.skippedKeys.length + failed.length
    setPending(null)

    if (restored.length === 0) {
      setStatus({
        type: 'error',
        message: 'Nothing could be restored. Your browser storage may be full or blocked.',
      })
      return
    }
    setStatus({
      type: 'success',
      message:
        `Restored ${describeKeys(restored)}.` +
        (skipped > 0 ? ` ${skipped} item(s) were skipped.` : '') +
        ' Reloading…',
    })
    setTimeout(reload, 800)
  }

  return (
    <section className="mb-8 rounded-xl border dark:bg-surface-card dark:border-border bg-white border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b dark:border-border border-gray-100">
        <div className="flex items-center gap-2">
          <DatabaseBackup size={16} className="text-accent" />
          <h2 className="text-sm font-bold dark:text-text-primary text-gray-900">Backup &amp; Restore</h2>
        </div>
        <p className="text-xs dark:text-text-secondary text-gray-500 mt-1">
          Save your favorites, history, collections, ratings, and other local data to a file, or
          restore it on another browser or device. API keys are never included.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            className={`${buttonBase} text-white bg-accent hover:opacity-90`}
          >
            <Download size={15} />
            Export data
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`${buttonBase} border dark:border-border border-gray-200 dark:text-text-primary text-gray-700 dark:hover:bg-surface-hover hover:bg-gray-50`}
          >
            <Upload size={15} />
            Import data
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Choose a backup file to import"
            data-testid="backup-file-input"
          />
        </div>

        {pending && (
          <div className="flex flex-col gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs dark:text-text-secondary text-gray-600 leading-relaxed">
                <p className="font-medium dark:text-text-primary text-gray-800">
                  Import will replace your current data for: {describeKeys(pending.restoredKeys)}.
                </p>
                {pending.skippedKeys.length > 0 && (
                  <p>Skipped (invalid): {describeKeys(pending.skippedKeys)}.</p>
                )}
                {pending.ignoredKeys.length > 0 && (
                  <p>Ignored (unrecognised): {pending.ignoredKeys.length} item(s).</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleConfirmImport}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 transition-colors"
              >
                Replace my data
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="px-4 py-2 rounded-lg text-xs font-medium transition-colors dark:text-text-secondary dark:hover:bg-surface-hover text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {status && (
          <p
            role={status.type === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 text-xs ${
              status.type === 'error' ? 'text-red-500' : 'text-emerald-500'
            }`}
          >
            {status.type === 'success' && <Check size={13} className="flex-shrink-0 mt-0.5" />}
            {status.message}
          </p>
        )}
      </div>
    </section>
  )
}
