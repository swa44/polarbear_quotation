import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ORDER_STATUS_LABEL } from '@/lib/utils'
import { checkAdminAuth } from '@/lib/admin-auth'
import { sendShippingAlimtalk } from '@/lib/alimtalk'

type OrderModule = {
  module_name: string
}

type OrderItemForExport = {
  gang_count: number
  quantity: number
  frame_color_name: string
  modules: OrderModule[]
  embedded_box_name?: string | null
}

type OrderForExport = {
  id: string
  order_number: string
  created_at: string
  customer_name: string
  customer_phone: string
  recipient_name: string | null
  recipient_phone: string | null
  shipping_address: string
  shipping_detail: string | null
  status: string
  total_price: number
  tracking_company: string | null
  tracking_number: string | null
  order_items?: OrderItemForExport[]
}

type BomRow = {
  productName: string
  color: string
  itemCode: string
  itemName: string
}

export async function GET(req: NextRequest) {
  try {
    if (!await checkAdminAuth()) {
      return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const format = searchParams.get('format')
    const idsParam = searchParams.get('ids')
    const ids = idsParam
      ? idsParam.split(',').map((id) => id.trim()).filter(Boolean)
      : []

    const supabase = createServiceClient()
    let query = supabase
      .from('orders')
      .select('*, order_items(*)')
      .order('created_at', { ascending: false })

    if (status && status !== 'all') {
      query = query.eq('status', status)
    }
    if (ids.length > 0) {
      query = query.in('id', ids)
    }

    const { data, error } = await query
    if (error) throw error

    // CSV 다운로드
    if (format === 'csv') {
      const csv = generateCsv((data || []) as OrderForExport[])
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="orders_${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      })
    }
    if (format === 'picking_csv') {
      const bomRows = await readPickingBomMapFromDb()
      const csv = generatePickingCsv((data || []) as OrderForExport[], bomRows)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="picking_${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      })
    }

    return NextResponse.json({ orders: data })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: '조회에 실패했습니다.' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (!await checkAdminAuth()) {
      return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })
    }

    const { id, ids, status, tracking_number, tracking_company, admin_memo } = await req.json()

    const supabase = createServiceClient()
    const updateData: Record<string, unknown> = {}

    if (status) updateData.status = status
    if (tracking_number !== undefined) updateData.tracking_number = tracking_number
    if (tracking_company !== undefined) updateData.tracking_company = tracking_company
    if (admin_memo !== undefined) updateData.admin_memo = admin_memo
    if (status === 'paid') updateData.paid_at = new Date().toISOString()
    if (status === 'shipped') updateData.shipped_at = new Date().toISOString()
    if (status === 'cancelled') updateData.cancelled_at = new Date().toISOString()

    // 여러 건 일괄 처리 (예: 선택한 견적 일괄 만료)
    if (Array.isArray(ids) && ids.length > 0) {
      const { error: bulkError } = await supabase.from('orders').update(updateData).in('id', ids)
      if (bulkError) throw bulkError
      return NextResponse.json({ success: true })
    }

    const { data, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', id)
      .select('*, order_items(*)')
      .single()

    if (error) throw error

    if (status === 'shipped' && data.customer_phone && data.quote_token) {
      const siteBase = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '')
        || `${req.headers.get('x-forwarded-proto') ?? 'https'}://${req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''}`
      const quoteUrl = `${siteBase}/quotes/${data.quote_token}`
      sendShippingAlimtalk({
        to: data.customer_phone,
        trackingCompany: tracking_company ?? '',
        trackingNumber: tracking_number ?? '',
        quoteUrl,
      }).catch((e) => console.error('[Shipping alimtalk error]', e))
    }

    return NextResponse.json({ success: true, order: data })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: '수정에 실패했습니다.' }, { status: 500 })
  }
}

function generateCsv(orders: OrderForExport[]): string {
  const BOM = '\uFEFF'
  const headers = [
    '견적번호', '요청일시', '고객명', '연락처', '수신인', '수신연락처', '배송지', '상세주소',
    '상태', '합계금액', '택배사', '송장번호', '상품내역',
  ]

  const rows = orders.map((o) => {
    const items = (o.order_items || [])
      .map((item) => {
        const modules = item.modules.map((m) => m.module_name).join('+')
        return `${item.gang_count}구[${item.frame_color_name}](${modules})x${item.quantity}`
      })
      .join(' / ')

    return [
      o.order_number,
      new Date(o.created_at).toLocaleString('ko-KR'),
      o.customer_name,
      o.customer_phone,
      o.recipient_name || o.customer_name,
      o.recipient_phone || o.customer_phone,
      o.shipping_address,
      o.shipping_detail || '',
      ORDER_STATUS_LABEL[o.status] || o.status,
      o.total_price,
      o.tracking_company || '',
      o.tracking_number || '',
      items,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  })

  return BOM + [headers.join(','), ...rows].join('\n')
}

async function readPickingBomMapFromDb(): Promise<BomRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('module_parts')
    .select('module_name, color_name, part_code, part_name')
    .eq('is_active', true)

  if (error) throw error
  if (!data || data.length === 0) throw new Error('module_parts 데이터가 없습니다. BOM CSV를 먼저 업로드해주세요.')

  return data.map((p) => ({
    productName: p.module_name,
    color: p.color_name ?? '',
    itemCode: p.part_code,
    itemName: p.part_name,
  }))
}

function generatePickingCsv(orders: OrderForExport[], bomRows: BomRow[]): string {
  const BOM = '\uFEFF'
  const map = new Map<string, BomRow[]>()
  const itemNameMap = new Map<string, BomRow[]>()
  for (const row of bomRows) {
    const key = buildBomKey(row.productName, row.color)
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)

    const nameKey = buildBomKey(row.itemName, row.color)
    const nameList = itemNameMap.get(nameKey) ?? []
    nameList.push(row)
    itemNameMap.set(nameKey, nameList)
  }

  type PartEntry = { itemCode: string; itemName: string; color: string; qty: number }

  const addToAggregate = (
    aggregate: Map<string, PartEntry>,
    unmatched: Set<string>,
    lookupName: string,
    color: string,
    qty: number,
  ) => {
    const bomKey = buildBomKey(lookupName, color)
    const mapped = map.get(bomKey)
    if (!mapped || mapped.length === 0) {
      unmatched.add(`${lookupName} / ${color}`)
      return
    }
    for (const part of mapped) {
      const key = `${part.itemCode}||${part.itemName}||${part.color}`
      const current = aggregate.get(key) ?? { itemCode: part.itemCode, itemName: part.itemName, color: part.color, qty: 0 }
      current.qty += qty
      aggregate.set(key, current)
    }
  }

  const addPartRowDirect = (
    aggregate: Map<string, PartEntry>,
    part: BomRow,
    qty: number,
  ) => {
    const key = `${part.itemCode}||${part.itemName}||${part.color}`
    const current = aggregate.get(key) ?? { itemCode: part.itemCode, itemName: part.itemName, color: part.color, qty: 0 }
    current.qty += qty
    aggregate.set(key, current)
  }

  const addByItemName = (
    aggregate: Map<string, PartEntry>,
    lookupItemName: string,
    color: string,
    qty: number,
  ): boolean => {
    const key = buildBomKey(lookupItemName, color)
    const mapped = itemNameMap.get(key)
    if (!mapped || mapped.length === 0) return false
    for (const part of mapped) {
      addPartRowDirect(aggregate, part, qty)
    }
    return true
  }

  const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

  const headers = ['견적번호', '수신인', '연락처', '주소', '품목코드', '제품명', '색상', '수량']
  const allRows: string[] = []
  const allUnmatched = new Set<string>()

  for (const order of orders) {
    const aggregate = new Map<string, PartEntry>()
    const unmatched = new Set<string>()

    for (const item of order.order_items ?? []) {
      const isSingle = !item.modules || item.modules.length === 0

      if (isSingle) {
        // 낱개는 제품명(품목코드 1:1)만 허용.
        // 세트용 상품명 확장 매핑을 타면 인서트 주문 시 커버까지 함께 집계될 수 있어 금지한다.
        if (addByItemName(aggregate, item.frame_color_name, '', item.quantity)) {
          // matched by itemName
        } else {
          const colorMatch = item.frame_color_name.match(/^(.*?)\s+\(([^)]+)\)\s*$/)
          if (colorMatch) {
            const pName = colorMatch[1].trim()
            const pColor = colorMatch[2].trim()
            if (addByItemName(aggregate, pName, pColor, item.quantity)) {
              // noop
            } else if (addByItemName(aggregate, pName, '', item.quantity)) {
              // noop
            } else {
              unmatched.add(item.frame_color_name)
            }
          } else {
            if (!addByItemName(aggregate, item.frame_color_name, '', item.quantity)) {
              unmatched.add(item.frame_color_name)
            }
          }
        }
      } else {
        const colorKey = extractColorKey(item.frame_color_name)
        addToAggregate(aggregate, unmatched, `${item.gang_count}구`, colorKey, item.quantity)
        for (const mod of item.modules) {
          addToAggregate(aggregate, unmatched, mod.module_name, colorKey, item.quantity)
        }
        if (item.embedded_box_name) {
          const parsed = parseEmbeddedBoxName(item.embedded_box_name)
          if (parsed && parsed.qty > 0) {
            addToAggregate(aggregate, unmatched, parsed.name, '', parsed.qty)
          }
        }
      }
    }

    const address = [order.shipping_address, order.shipping_detail].filter(Boolean).join(' ')
    const shippingCells = [
      order.order_number,
      order.recipient_name ?? order.customer_name,
      order.recipient_phone ?? order.customer_phone,
      address,
    ]

    Array.from(aggregate.values())
      .sort((a, b) =>
        a.itemCode.localeCompare(b.itemCode) ||
        a.itemName.localeCompare(b.itemName) ||
        a.color.localeCompare(b.color)
      )
      .forEach((row) => {
        allRows.push([...shippingCells, row.itemCode, row.itemName, row.color, row.qty].map(csvCell).join(','))
      })

    for (const label of unmatched) {
      allUnmatched.add(`${order.order_number}: ${label}`)
    }
  }

  // 매핑 누락 항목은 에러 대신 CSV 하단에 표기
  const unmatchedRows = Array.from(allUnmatched).sort().map((label) =>
    `"[매핑누락] ${label}","","","","","","",""`
  )

  return BOM + [headers.join(','), ...allRows, ...unmatchedRows].join('\n')
}

function buildBomKey(productName: string, color: string): string {
  return `${normalizeMatchText(productName)}||${normalizeMatchText(color)}`
}

function normalizeMatchText(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase()
}

// frame_color_name에서 BOM 색상 키 추출
// "프레임 3구 앤트러사이트 (앤트라사이트)" → "앤트라사이트"
// "화이트" → "화이트"
function extractColorKey(frameColorName: string): string {
  const match = frameColorName.match(/\(([^)]+)\)\s*$/)
  return match ? match[1].trim() : frameColorName
}

function parseEmbeddedBoxName(value: string): { name: string; qty: number } | null {
  const match = value.match(/^(.*?)\s*x(\d+)\s*$/i)
  if (!match) return null
  const qty = Number(match[2])
  return {
    name: match[1].trim(),
    qty: Number.isFinite(qty) ? qty : 0,
  }
}
