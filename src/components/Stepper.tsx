interface Props {
  value: number
  onChange: (n: number) => void
  /** For screen readers: "Fewer <label>" / "More <label>". */
  label: string
  disabled?: boolean
  min?: number
  max?: number
  /** Amount per tap (default 1). */
  step?: number
  /** How the value reads (default the number). */
  format?: (n: number) => string
}

/** -/count/+ control (deck builder, default copies). */
export function Stepper({ value, onChange, label, disabled = false, min = 0, max = 99, step = 1, format = String }: Props) {
  return (
    <span className="stepper">
      <button
        type="button"
        className="secondary"
        aria-label={`Fewer ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </button>
      <span className="stepper-count" aria-live="polite">
        {format(value)}
      </span>
      <button
        type="button"
        className="secondary"
        aria-label={`More ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </button>
    </span>
  )
}
