import { useEffect, useState } from 'react'
import { describeError } from '../lobby/messages'
import { currentPushEnv, currentSubscription, disablePush, enablePush, pushSupport, refreshPush } from '../lib/push'
import type { SyncTransport } from '../sync/transport'

type State = 'loading' | 'on' | 'off' | 'blocked'

/** Turn push alerts on or off for this phone (new questions, answers, curses, freezes). */
export function PushToggle({ transport }: { transport: SyncTransport }) {
  const support = pushSupport(currentPushEnv())
  const [state, setState] = useState<State>(() =>
    support === 'ok' && Notification.permission === 'denied' ? 'blocked' : 'loading',
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (support !== 'ok' || Notification.permission === 'denied') return
    let live = true
    currentSubscription()
      .then((sub) => {
        if (!live) return
        setState(sub ? 'on' : 'off')
        if (sub) void refreshPush(transport).catch(() => {})
      })
      .catch(() => live && setState('off'))
    return () => {
      live = false
    }
  }, [support, transport])

  if (support === 'not_configured') return null

  const toggle = async () => {
    setBusy(true)
    setErr(null)
    try {
      if (state === 'on') {
        await disablePush(transport)
        setState('off')
      } else {
        const ok = await enablePush(transport)
        setState(ok ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off')
      }
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="push-toggle">
      <div className="setting-head">
        <span className="setting-label">Alerts on this phone</span>
        {support === 'ok' && state !== 'blocked' && (
          <button className={state === 'on' ? 'secondary small' : 'small'} disabled={busy || state === 'loading'} onClick={() => void toggle()}>
            {state === 'on' ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      <p className="setting-desc">
        {support === 'needs_home_screen'
          ? 'On iPhone, add the app to your Home Screen (Share, Add to Home Screen) and open it from there to get alerts.'
          : support === 'unsupported'
            ? 'This browser cannot show alerts.'
            : state === 'blocked'
              ? 'Alerts are blocked for this app. Allow notifications in your phone settings.'
              : state === 'on'
                ? 'On: new questions, answers, curses and freezes alert you while the app is closed.'
                : 'Get an alert for new questions, answers, curses and freezes while the app is closed.'}
      </p>
      {err && <p className="bad setting-msg">{err}</p>}
    </div>
  )
}
