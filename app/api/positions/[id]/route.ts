import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Market } from '@/lib/types'

// GET /api/positions/[id] — full position detail
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const positionId = parseInt(id)

  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' } },
      sellRecords: { orderBy: { soldAt: 'desc' } },
      refreshLogs: { orderBy: { refreshedAt: 'desc' } },
    },
  })

  if (!position) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(position)
}
