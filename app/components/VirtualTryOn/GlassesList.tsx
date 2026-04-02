'use client'

import type { Glasses } from '@/app/data/glasses'

interface GlassesListProps {
  items: Glasses[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClear: () => void
}

export default function GlassesList({ items, selectedId, onSelect, onClear }: GlassesListProps) {
  return (
    <div className="w-full bg-white flex flex-col divide-y divide-gray-100">
      {items.map((g) => {
        const isSelected = g.id === selectedId
        return (
          <div
            key={g.id}
            className={`flex items-center gap-4 px-4 py-3 transition-colors ${
              isSelected ? 'bg-gray-50' : 'bg-white'
            }`}
          >
            {/* Thumbnail */}
            <div
              className={`w-16 h-16 rounded-lg flex-shrink-0 flex items-center justify-center text-2xl border-2 transition-colors ${
                isSelected ? 'border-black' : 'border-gray-200'
              }`}
              style={{ background: `${g.color}15` }}
            >
              <GlassesIcon color={g.color} />
            </div>

            {/* Name */}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 text-sm truncate">{g.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">${g.price}</p>
            </div>

            {/* Action button */}
            {isSelected ? (
              <button
                onClick={onClear}
                className="px-4 py-2 rounded-full text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                clear
              </button>
            ) : (
              <button
                onClick={() => onSelect(g.id)}
                className="px-4 py-2 rounded-full text-sm font-medium bg-black text-white hover:bg-gray-800 transition-colors"
              >
                apply
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function GlassesIcon({ color }: { color: string }) {
  return (
    <svg width="44" height="20" viewBox="0 0 44 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="3" width="17" height="14" rx="7" stroke={color} strokeWidth="2.2" fill={`${color}30`} />
      <rect x="26" y="3" width="17" height="14" rx="7" stroke={color} strokeWidth="2.2" fill={`${color}30`} />
      <line x1="18" y1="10" x2="26" y2="10" stroke={color} strokeWidth="2" />
      <line x1="1" y1="8" x2="0" y2="2" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="43" y1="8" x2="44" y2="2" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
