import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { extractThesisPoints } from '@/lib/llm-analyzer'
import { StockSnapshot } from '@/lib/types'

// POST /api/thesis-points — LLM-extract thesis points for an existing buy record.
// Body: { buyRecordId: number } | { buyRecordId, points: [...] } to save user-edited points.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { buyRecordId, points } = body as {
      buyRecordId: number
      points?: Array<{ id: string; point: string }>
    }

    if (!buyRecordId) {
      return NextResponse.json({ error: 'buyRecordId required' }, { status: 400 })
    }

    const record = await prisma.buyRecord.findUnique({
      where: { id: buyRecordId },
      include: { position: { include: { stock: true } } },
    })
    if (!record) {
      return NextResponse.json({ error: 'Buy record not found' }, { status: 404 })
    }

    // Save user-confirmed points directly
    if (points) {
      await prisma.buyRecord.update({
        where: { id: buyRecordId },
        data: { thesisPointsJson: JSON.stringify(points) },
      })
      return NextResponse.json({ thesisPoints: points })
    }

    // LLM extraction
    let snapshot: StockSnapshot
    try {
      snapshot = JSON.parse(record.snapshotJson)
    } catch {
      snapshot = {} as StockSnapshot
    }
    const extracted = await extractThesisPoints(
      record.thesis,
      snapshot,
      record.position.stock.name
    )
    await prisma.buyRecord.update({
      where: { id: buyRecordId },
      data: { thesisPointsJson: JSON.stringify(extracted) },
    })
    return NextResponse.json({ thesisPoints: extracted })
  } catch (e) {
    console.error('/api/thesis-points POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
