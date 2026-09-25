import { useStore } from '../store'

const BARS = 13
// Per-bar weighting so the centre reacts more (a natural spectrum look).
const WEIGHTS = Array.from({ length: BARS }, (_, i) => {
  const c = (BARS - 1) / 2
  return 0.4 + 0.6 * (1 - Math.abs(i - c) / c)
})

export function LevelMeter({ active }: { active: boolean }): JSX.Element {
  const level = useStore((s) => s.level)
  return (
    <div className="flex h-10 items-center justify-center gap-1.5">
      {WEIGHTS.map((w, i) => {
        const h = active ? Math.max(0.08, Math.min(1, level * w * (0.7 + ((i * 37) % 11) / 18))) : 0.08
        return (
          <div
            key={i}
            className="w-1.5 rounded-full bg-gradient-to-t from-brand to-brand-glow transition-[height] duration-75"
            style={{ height: `${h * 100}%`, opacity: active ? 0.55 + h * 0.45 : 0.2 }}
          />
        )
      })}
    </div>
  )
}
