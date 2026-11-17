import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

function joinUrl(code: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}?join=${code}`
}

/** Big join code, with a QR that opens the app with the code filled in. */
export function JoinCode({ code }: { code: string }) {
  const [showQr, setShowQr] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const url = joinUrl(code)

  useEffect(() => {
    if (!showQr) return
    let cancelled = false
    QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#1a1a1a', light: '#ffffff' } })
      .then((d) => !cancelled && setQr(d))
      .catch(() => !cancelled && setQr(null))
    return () => {
      cancelled = true
    }
  }, [showQr, url])

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Hide + Drink', text: `Join code ${code}`, url })
        return
      } catch {
        // Cancelled or unsupported: fall back to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked; the code is on screen anyway.
    }
  }

  return (
    <section className="card join-card">
      <p className="muted">Join code</p>
      <p className="join-code" aria-label={`Join code ${code.split('').join(' ')}`}>
        {code}
      </p>
      {showQr && (
        <div className="qr">{qr ? <img src={qr} alt={`QR code to join game ${code}`} /> : <span>…</span>}</div>
      )}
      <div className="row center">
        <button className="secondary" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Hide QR' : 'Show QR'}
        </button>
        <button className="secondary" onClick={share}>
          {copied ? 'Link copied' : 'Share link'}
        </button>
      </div>
    </section>
  )
}
