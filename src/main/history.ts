import Store from 'electron-store'
import type { HistoryItem } from '../shared/types'

const MAX_ITEMS = 100

/** Persistent ring buffer of recent dictations (newest first). */
export class HistoryManager {
  private store = new Store<{ items: HistoryItem[] }>({
    name: 'history',
    defaults: { items: [] }
  })

  list(): HistoryItem[] {
    return this.store.get('items')
  }

  add(item: HistoryItem): HistoryItem[] {
    const items = [item, ...this.store.get('items')].slice(0, MAX_ITEMS)
    this.store.set('items', items)
    return items
  }

  remove(id: string): HistoryItem[] {
    const items = this.store.get('items').filter((i) => i.id !== id)
    this.store.set('items', items)
    return items
  }

  clear(): void {
    this.store.set('items', [])
  }
}

export const history = new HistoryManager()
