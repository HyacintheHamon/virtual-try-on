'use client'

import dynamic from 'next/dynamic'

const VirtualTryOn = dynamic(() => import('./index'), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-black text-white text-sm">
      Loading…
    </div>
  ),
})

export default function TryOnClient() {
  return <VirtualTryOn />
}
