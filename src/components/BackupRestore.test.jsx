import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BackupRestore from './BackupRestore'
import { BACKUP_FORMAT, BACKUP_VERSION } from '../lib/dataBackup'

const fakeFile = (text, size = text.length) => ({ size, text: async () => text })

const backupText = (data) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', data })

async function chooseFile(file) {
  const input = screen.getByTestId('backup-file-input')
  fireEvent.change(input, { target: { files: [file] } })
}

describe('BackupRestore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('export', () => {
    it('downloads a backup file with saved data and no secrets', async () => {
      localStorage.setItem('ila_favorites', JSON.stringify(['code-reviewer']))
      sessionStorage.setItem('ila_apikey_openai', 'sk-secret')

      let blob
      URL.createObjectURL = vi.fn((b) => {
        blob = b
        return 'blob:backup'
      })
      URL.revokeObjectURL = vi.fn()
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

      render(<BackupRestore />)
      fireEvent.click(screen.getByRole('button', { name: /export data/i }))

      expect(click).toHaveBeenCalledTimes(1)
      const text = await blob.text?.() ?? (await new Response(blob).text())
      const parsed = JSON.parse(text)
      expect(parsed.format).toBe(BACKUP_FORMAT)
      expect(parsed.data.ila_favorites).toEqual(['code-reviewer'])
      expect(text).not.toContain('sk-secret')
      expect(screen.getByRole('status')).toHaveTextContent(/exported 1 data set/i)

      sessionStorage.clear()
    })
  })

  describe('import', () => {
    it('shows an error for a file that is not a backup, and writes nothing', async () => {
      render(<BackupRestore reload={vi.fn()} />)
      await chooseFile(fakeFile('{"hello":"world"}'))

      expect(await screen.findByRole('alert')).toHaveTextContent(/not an iloveAgents backup/i)
      expect(screen.queryByRole('button', { name: /replace my data/i })).toBeNull()
      expect(localStorage.length).toBe(0)
    })

    it('shows an error for invalid JSON', async () => {
      render(<BackupRestore reload={vi.fn()} />)
      await chooseFile(fakeFile('not json at all'))
      expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/i)
    })

    it('does not touch storage until the user confirms', async () => {
      localStorage.setItem('ila_favorites', JSON.stringify(['old']))
      render(<BackupRestore reload={vi.fn()} />)
      await chooseFile(fakeFile(backupText({ ila_favorites: ['new'] })))

      expect(await screen.findByText(/will replace your current data/i)).toBeInTheDocument()
      expect(JSON.parse(localStorage.getItem('ila_favorites'))).toEqual(['old'])
    })

    it('cancel leaves existing data untouched', async () => {
      localStorage.setItem('ila_favorites', JSON.stringify(['old']))
      const reload = vi.fn()
      render(<BackupRestore reload={reload} />)
      await chooseFile(fakeFile(backupText({ ila_favorites: ['new'] })))

      fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))
      expect(screen.queryByRole('button', { name: /replace my data/i })).toBeNull()
      expect(JSON.parse(localStorage.getItem('ila_favorites'))).toEqual(['old'])
      expect(reload).not.toHaveBeenCalled()
    })

    it('restores valid data on confirm, ignores unexpected keys, then reloads', async () => {
      const reload = vi.fn()
      render(<BackupRestore reload={reload} />)
      await chooseFile(
        fakeFile(
          backupText({
            ila_favorites: ['new'],
            ila_ratings: 'malformed',
            ila_encrypted_vault_v2: { evil: true },
          }),
        ),
      )

      expect(await screen.findByText(/skipped \(invalid\): ratings/i)).toBeInTheDocument()
      expect(screen.getByText(/ignored \(unrecognised\): 1 item/i)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /replace my data/i }))

      expect(JSON.parse(localStorage.getItem('ila_favorites'))).toEqual(['new'])
      expect(localStorage.getItem('ila_ratings')).toBeNull()
      expect(localStorage.getItem('ila_encrypted_vault_v2')).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent(/restored favorites/i)

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 })
    })

    it('rejects an oversized file without reading it', async () => {
      const text = vi.fn()
      render(<BackupRestore reload={vi.fn()} />)
      await chooseFile({ size: 50 * 1024 * 1024, text })

      expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
      expect(text).not.toHaveBeenCalled()
    })
  })
})
