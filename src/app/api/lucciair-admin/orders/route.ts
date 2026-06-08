import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { checkAdminAuth } from '@/lib/admin-auth'
import { sendShippingAlimtalk } from '@/lib/alimtalk'

export async function GET(req: NextRequest) {
  if (!await checkAdminAuth()) return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })

  const status = req.nextUrl.searchParams.get('status') || 'all'
  const supabase = createServiceClient()

  let query = supabase
    .from('fan_orders')
    .select('*, fan_order_items(*)')
    .order('created_at', { ascending: false })

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: '조회에 실패했습니다.' }, { status: 500 })
  return NextResponse.json({ orders: data })
}

export async function PATCH(req: NextRequest) {
  if (!await checkAdminAuth()) return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })

  try {
    const body = await req.json() as {
      id?: string
      ids?: string[]
      status?: string
      admin_memo?: string
      tracking_number?: string
      tracking_company?: string
      send_shipping_alimtalk?: boolean
    }
    const { id, ids, send_shipping_alimtalk, ...updates } = body

    const supabase = createServiceClient()

    if (updates.status === 'paid') Object.assign(updates, { paid_at: new Date().toISOString() })
    if (updates.status === 'shipped') Object.assign(updates, { shipped_at: new Date().toISOString() })
    if (updates.status === 'cancelled') Object.assign(updates, { cancelled_at: new Date().toISOString() })

    // 여러 건 일괄 처리 (예: 선택한 견적 일괄 만료)
    if (Array.isArray(ids) && ids.length > 0) {
      const { error: bulkError } = await supabase
        .from('fan_orders')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .in('id', ids)
      if (bulkError) throw bulkError
      return NextResponse.json({ success: true })
    }

    const { error } = await supabase.from('fan_orders').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) throw error

    if (send_shipping_alimtalk) {
      const { data: order } = await supabase
        .from('fan_orders')
        .select('customer_phone, quote_token')
        .eq('id', id)
        .single()
      if (order?.customer_phone && order?.quote_token) {
        const envBase = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || ''
        const quoteUrl = `${envBase}/fan-quotes/${order.quote_token}`
        sendShippingAlimtalk({
          to: order.customer_phone,
          trackingCompany: updates.tracking_company || '',
          trackingNumber: updates.tracking_number || '',
          quoteUrl,
        }).catch((e) => console.error('[Fan shipping alimtalk error]', e))
      }
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: '업데이트에 실패했습니다.' }, { status: 500 })
  }
}
