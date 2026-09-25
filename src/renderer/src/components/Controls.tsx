import React from 'react'
import { InfoTip } from './InfoTip'

/** One settings line: label (+ optional "i" explainer) left, control right. */
export function Row({
  title,
  info,
  children
}: {
  title: string
  info?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13.5px] font-medium text-ink">{title}</span>
        {info && <InfoTip text={info} />}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`no-drag relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand/50 ${
        checked ? 'bg-brand' : 'bg-white/[0.12]'
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[21px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

const CHEVRON_BG: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a4abbb' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center'
}

export function Select<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <select
      value={value}
      style={CHEVRON_BG}
      onChange={(e) => onChange(e.target.value as T)}
      className="input min-w-[170px] cursor-pointer appearance-none pr-8"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  suffix
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  suffix?: string
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range"
      />
      <span className="w-16 text-right font-mono text-xs text-ink-muted">
        {value}
        {suffix ?? ''}
      </span>
    </div>
  )
}

export function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section>
      <h2 className="px-1 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
        {title}
      </h2>
      <div className="card flex flex-col divide-y divide-white/[0.045] px-4 py-1.5">
        {children}
      </div>
    </section>
  )
}
