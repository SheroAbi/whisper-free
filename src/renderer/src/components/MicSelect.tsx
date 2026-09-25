import { useEffect, useState, useCallback } from 'react'
import { Select } from './Controls'

export function MicSelect({
  value,
  onChange
}: {
  value: string | null
  onChange: (id: string | null) => void
}): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  const enumerate = useCallback(async () => {
    try {
      let list = await navigator.mediaDevices.enumerateDevices()
      const inputs = list.filter((d) => d.kind === 'audioinput')
      // Labels are hidden until mic permission is granted once.
      if (inputs.length && inputs.every((d) => !d.label)) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
        if (tmp) tmp.getTracks().forEach((t) => t.stop())
        list = await navigator.mediaDevices.enumerateDevices()
      }
      setDevices(list.filter((d) => d.kind === 'audioinput'))
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [enumerate])

  const options = [
    { value: '', label: 'System default' },
    ...devices.map((d, i) => ({
      value: d.deviceId,
      label: d.label || `Microphone ${i + 1}`
    }))
  ]

  return (
    <Select
      value={value ?? ''}
      options={options}
      onChange={(v) => onChange(v === '' ? null : v)}
    />
  )
}
