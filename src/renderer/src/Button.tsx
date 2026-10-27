import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 16px icon rendered left of the label (or alone for icon-only buttons). */
  icon?: ReactNode
  /** Shows the spinner, switches the label, and blocks clicks. */
  loading?: boolean
  /** Label shown while loading (defaults to the normal children). */
  loadingLabel?: string
  /** Native `title` tooltip + `aria-describedby` text when disabled. */
  disabledReason?: string
  ref?: Ref<HTMLButtonElement>
}

/** 14px spinner ring in `currentColor`; pulses instead of rotating with reduced motion. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="btn-spinner"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M12.5 7A5.5 5.5 0 0 0 7 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The one button component used everywhere: primary / secondary / ghost /
 * danger variants, sm (28px) / md (32px) / lg (40px) sizes, optional leading
 * icon, loading state (spinner + label swap, width kept, `aria-busy`), and
 * disabled reasons surfaced as tooltip + screen-reader text.
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  loadingLabel,
  disabledReason,
  className,
  children,
  disabled,
  title,
  ref,
  ...rest
}: ButtonProps) {
  const reasonId = useId()
  const isDisabled = disabled === true || loading
  const showReason = isDisabled && disabledReason !== undefined && disabledReason.length > 0
  const label = loading && loadingLabel !== undefined ? loadingLabel : children
  const iconOnly = label === undefined || label === null || label === false || label === ''
  return (
    <>
      <button
        {...rest}
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading ? 'true' : undefined}
        aria-describedby={showReason ? reasonId : rest['aria-describedby']}
        title={showReason ? disabledReason : title}
        className={[
          'btn',
          `btn-${variant}`,
          `btn-${size}`,
          loading ? 'is-loading' : '',
          iconOnly ? 'btn-icon-only' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {loading ? (
          <span className="btn-icon" aria-hidden="true">
            <Spinner />
          </span>
        ) : (
          icon !== undefined && (
            <span className="btn-icon" aria-hidden="true">
              {icon}
            </span>
          )
        )}
        {!iconOnly && <span className="btn-label">{label}</span>}
      </button>
      {showReason && (
        <span id={reasonId} className="visually-hidden">
          {disabledReason}
        </span>
      )}
    </>
  )
}
