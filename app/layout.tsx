import type { Metadata } from 'next'
import './globals.css'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Buy-Sell Consistency Tracker',
  description: '买卖一致性跟踪系统',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-neutral-950 text-neutral-100">
        <nav className="border-b border-neutral-800 bg-neutral-900">
          <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
            <Link href="/" className="text-sm font-semibold tracking-tight text-neutral-100 hover:text-white">
              买卖一致性
            </Link>
            <div className="flex items-center gap-6 text-sm text-neutral-400">
              <Link href="/" className="hover:text-neutral-100 transition-colors">持仓总览</Link>
              <Link href="/buy" className="hover:text-neutral-100 transition-colors">记录买入</Link>
            </div>
          </div>
        </nav>
        <main className="mx-auto max-w-6xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  )
}
