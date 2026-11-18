interface Props {
  value: number
  onChange: (n: number) => void
  /** For screen readers: "Fewer <label>" / "More <label>". */
  label: string
  disabled?: boolean
  min?: number
  max?: number
}

/** -/count/+ control (deck builder, default copies). */
export function Stepper({ value, onChange, label, disabled = false, min = 0, max = 99 }: Props) {
  return (
    <span className="stepper">
      <button
        type="button"
        className="secondary"
        aria-label={`Fewer ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="stepper-count" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="secondary"
        aria-label={`More ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </span>
  )
}
