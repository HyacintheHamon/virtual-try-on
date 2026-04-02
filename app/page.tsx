import TryOnClient from '@/app/components/VirtualTryOn/TryOnClient'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Virtual Try-On',
  description: 'Try glasses virtually with AI face tracking',
}

export default function Home() {
  return <TryOnClient />
}
