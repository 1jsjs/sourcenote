import { useEffect, useId, useState } from 'react'
import type { ApiKeySource, AppLanguage } from '../../shared/types'
import Button from './Button'
import { t, type MessageKey } from './i18n'

const STATUS_KEY: Record<ApiKeySource, MessageKey> = {
  none: 'apiKeyStatusNone',
  saved: 'apiKeyStatusSaved',
  keychain: 'apiKeyStatusKeychain',
  env: 'apiKeyStatusEnv',
}

/**
 * Enter, replace, or remove the Meta API key. The key only travels one way
 * (renderer -> main, where safeStorage encrypts it); the dialog learns where
 * the key in use comes from, never the key itself.
 */
export default function ApiKeyDialog({
  lang,
  source,
  onClose,
  onChanged,
}: {
  lang: AppLanguage
  source: ApiKeySource
  onClose: () => void
  onChanged: (source: ApiKeySource, message: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const inputId = useId()
  const errorId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && busy === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const run = async (kind: 'save' | 'clear'): Promise<void> => {
    if (busy !== null) return
    setBusy(kind)
    setError(null)
    try {
      const next =
        kind === 'save'
          ? await window.sourcenote.saveApiKey(draft)
          : await window.sourcenote.clearApiKey()
      setDraft('')
      onChanged(next, t(lang, kind === 'save' ? 'apiKeySaved' : 'apiKeyCleared'))
    } catch (err) {
      // ipcRenderer.invoke prefixes "Error invoking remote method ...: Error: ".
      const message = err instanceof Error ? err.message : String(err)
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal key-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="key-dialog-title">
          {t(lang, 'apiKeyTitle')}
        </h2>
        <p className="modal-text">{t(lang, 'apiKeyIntro')}</p>
        <p className={source === 'none' ? 'key-status missing' : 'key-status'}>
          {t(lang, STATUS_KEY[source])}
        </p>
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault()
            void run('save')
          }}
        >
          <label htmlFor={inputId} className="key-label">
            {t(lang, 'apiKeyLabel')}
          </label>
          <input
            id={inputId}
            type="password"
            value={draft}
            placeholder={t(lang, 'apiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
          />
          {error !== null && (
            <p id={errorId} className="key-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions key-actions">
            {source === 'saved' && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="key-clear"
                loading={busy === 'clear'}
                disabled={busy === 'save'}
                onClick={() => void run('clear')}
              >
                {t(lang, 'apiKeyClear')}
              </Button>
            )}
            <Button type="button" variant="secondary" size="md" disabled={busy !== null} onClick={onClose}>
              {t(lang, 'cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={busy === 'save'}
              loadingLabel={t(lang, 'apiKeySaving')}
              disabled={busy === 'clear' || draft.trim().length === 0}
            >
              {t(lang, 'apiKeySave')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
