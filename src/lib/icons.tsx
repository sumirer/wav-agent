/**
 * 内联图标集。
 * 全部使用 currentColor，尺寸随 fontSize/width 属性变化，避免引入图标库依赖。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...props }: IconProps): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlayIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M6 4.5 19 12 6 19.5z" fill="currentColor" stroke="none" />
  </Base>
)

export const PauseIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.1" fill="currentColor" stroke="none" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.1" fill="currentColor" stroke="none" />
  </Base>
)

export const StopIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Base>
)

export const SettingsIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15H3.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1.1z" />
  </Base>
)

export const PlusIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M12 5v14M5 12h14" />
  </Base>
)

export const TrashIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Base>
)

export const SaveIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M5 4h11l3 3v13H5z" />
    <path d="M9 4v5h6V4M9 20v-6h6v6" />
  </Base>
)

export const WaveIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M3 12h2l2-6 3 12 3-9 2 5 2-3h4" />
  </Base>
)

export const EditIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M4 20h4l10-10-4-4L4 16z" />
    <path d="M13.5 6.5 17.5 10.5" />
  </Base>
)

export const SparkIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
  </Base>
)

export const FolderIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M3 7h5l2 2h11v10H3z" />
  </Base>
)

export const RefreshIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />
  </Base>
)

export const CloseIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Base>
)

export const CheckIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M5 13l4.5 4.5L19 7" />
  </Base>
)

export const LoopIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M17 3l3 3-3 3" />
    <path d="M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3" />
    <path d="M4 18h12a4 4 0 0 0 4-4v-1" />
  </Base>
)

export const StopCircleIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" stroke="none" />
  </Base>
)

export const ChevronIcon = (props: IconProps): JSX.Element => (
  <Base {...props}>
    <path d="M6 9l6 6 6-6" />
  </Base>
)
