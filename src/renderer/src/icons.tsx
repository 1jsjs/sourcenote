/**
 * Inline SVG icons drawn for this app (no icon font, no remote assets).
 * All are 16px, 1.5px stroke, round caps, `currentColor`.
 */

function Base({
  children,
  label,
}: {
  children: React.ReactNode
  label?: string
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined ? 'true' : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
    >
      {children}
    </svg>
  )
}

export function PlusIcon() {
  return (
    <Base>
      <path d="M8 3v10M3 8h10" />
    </Base>
  )
}

export function WaveformButtonIcon() {
  return (
    <Base>
      <path d="M2.5 6.5v3M5.5 4v8M8.5 6v4M11.5 3.5v9M14 6.5v3" />
    </Base>
  )
}

export function FileIcon() {
  return (
    <Base>
      <path d="M3.5 1.8h6L12.5 5v9.2h-9V1.8z" />
      <path d="M9.3 1.8V5h3.2" />
    </Base>
  )
}

export function ListCheckIcon() {
  return (
    <Base>
      <path d="M2 2.2 2.8 3l1.7-1.9" />
      <path d="M2 8.2l.8.8L4.5 7" />
      <path d="M2 14.2l.8.8 1.7-2" />
      <path d="M6.5 1.5H14M6.5 8H14M6.5 14H14" />
    </Base>
  )
}

export function PenIcon() {
  return (
    <Base>
      <path d="M11.5 2.5 13.5 4.5 5.5 12.5l-3 1 1-3 8.5-8z" />
      <path d="M10 4l2 2" />
    </Base>
  )
}

export function CheckButtonIcon() {
  return (
    <Base>
      <path d="M2.8 8.5l3.5 3.5L13.2 4.5" />
    </Base>
  )
}

export function PlayButtonIcon() {
  return (
    <Base>
      <path d="M5 3.2v9.6L12.5 8 5 3.2z" />
    </Base>
  )
}

export function PauseButtonIcon() {
  return (
    <Base>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </Base>
  )
}

export function ChevronLeftIcon() {
  return (
    <Base>
      <path d="M10 3 5.5 8 10 13" />
    </Base>
  )
}

export function ChevronRightIcon() {
  return (
    <Base>
      <path d="M6 3l4.5 5L6 13" />
    </Base>
  )
}

export function MoreIcon() {
  return (
    <Base>
      <path d="M3 8h.01M8 8h.01M13 8h.01" strokeWidth="2.2" />
    </Base>
  )
}

export function CloseIcon() {
  return (
    <Base>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Base>
  )
}

export function UploadIcon() {
  return (
    <Base>
      <path d="M8 11.5V3" />
      <path d="M5 5.8 8 2.8l3 3" />
      <path d="M2.8 11v2a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-2" />
    </Base>
  )
}

export function TrashIcon() {
  return (
    <Base>
      <path d="M2.8 4h10.4M6.5 4V2.5h3V4M4.5 4l.7 9.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8L11.5 4" />
      <path d="M6.8 7v4M9.2 7v4" />
    </Base>
  )
}

export function PencilIcon() {
  return (
    <Base>
      <path d="M11.5 2.5 13.5 4.5 5.5 12.5l-3 1 1-3 8.5-8z" />
    </Base>
  )
}
