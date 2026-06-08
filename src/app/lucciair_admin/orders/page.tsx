'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { FanOrder } from '@/types/fan'
import { formatPrice, formatDate, formatPhone, ORDER_STATUS_LABEL, ORDER_STATUS_COLOR } from '@/lib/utils'
import Badge from '@/components/ui/Badge'
import Button from '@/components/ui/Button'
import { ChevronDown, ChevronUp } from 'lucide-react'

const DISCOUNT_RATE = 0.1
const SHIPPING_FEE = 3000

const STATUS_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'quoted', label: '견적 발송' },
  { value: 'waiting_deposit', label: '입금 대기' },
  { value: 'paid', label: '입금 확인' },
  { value: 'shipped', label: '발송됨' },
  { value: 'cancelled', label: '취소됨' },
  { value: 'expired', label: '만료됨' },
]

export default function LucciairAdminOrdersPage() {
  const [orders, setOrders] = useState<FanOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])

  const [editMemo, setEditMemo] = useState<Record<string, string>>({})
  const [editTracking, setEditTracking] = useState<Record<string, string>>({})
  const [editTrackingCompany, setEditTrackingCompany] = useState<Record<string, string>>({})

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/lucciair-admin/orders?status=${statusFilter}`)
    const data = await res.json()
    if (data.orders) {
      setOrders(data.orders)
      setSelectedOrderIds((prev) => prev.filter((id) => data.orders.some((o: FanOrder) => o.id === id)))
      const memos: Record<string, string> = {}
      const trackings: Record<string, string> = {}
      const companies: Record<string, string> = {}
      data.orders.forEach((o: FanOrder) => {
        memos[o.id] = o.admin_memo || ''
        trackings[o.id] = o.tracking_number || ''
        companies[o.id] = o.tracking_company || '로젠택배'
      })
      setEditMemo(memos)
      setEditTracking(trackings)
      setEditTrackingCompany(companies)
    }
    setLoading(false)
  }, [statusFilter])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  const patch = async (id: string, body: object) => {
    setSavingId(id)
    await fetch('/api/lucciair-admin/orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    })
    await fetchOrders()
    setSavingId(null)
  }

  const handleUpdateStatus = (id: string, status: string) => patch(id, { status })

  const handleUpdateTracking = (id: string) =>
    patch(id, { tracking_company: editTrackingCompany[id], tracking_number: editTracking[id] })

  const handleShip = async (id: string) => {
    if (!editTracking[id]?.trim()) { alert('송장번호를 입력해주세요.'); return }
    await patch(id, {
      status: 'shipped',
      tracking_company: editTrackingCompany[id],
      tracking_number: editTracking[id],
      send_shipping_alimtalk: true,
    })
  }

  const handleSaveMemo = (id: string) => patch(id, { admin_memo: editMemo[id] })

  const toggleOrderSelection = (id: string, checked: boolean) => {
    setSelectedOrderIds((prev) => {
      if (checked) return [...prev, id]
      return prev.filter((v) => v !== id)
    })
  }

  const handleBulkExpire = async () => {
    if (selectedOrderIds.length === 0) return
    if (!confirm(`선택한 ${selectedOrderIds.length}건의 견적을 만료 처리할까요?`)) return
    setSavingId('bulk')
    await fetch('/api/lucciair-admin/orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedOrderIds, status: 'expired' }),
    })
    setSelectedOrderIds([])
    await fetchOrders()
    setSavingId(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">견적 관리</h1>
        <Button
          variant="danger"
          size="sm"
          loading={savingId === 'bulk'}
          onClick={handleBulkExpire}
          disabled={selectedOrderIds.length === 0}
        >
          선택 만료 처리 ({selectedOrderIds.length})
        </Button>
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {STATUS_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setStatusFilter(value)}
            className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === value
                ? 'bg-gray-900 text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center text-gray-400 py-16">견적이 없습니다.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((order) => {
            const isExpanded = expandedId === order.id
            const items = order.fan_order_items ?? []
            const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0)
            const discount = Math.round(subtotal * DISCOUNT_RATE)
            const finalPrice = subtotal - discount + SHIPPING_FEE

            return (
              <div key={order.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : order.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="mb-2">
                        <input
                          type="checkbox"
                          checked={selectedOrderIds.includes(order.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => toggleOrderSelection(order.id, e.target.checked)}
                          className="w-4 h-4 accent-gray-900"
                        />
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-semibold text-gray-900">{order.order_number}</span>
                        <Badge className={ORDER_STATUS_COLOR[order.status] ?? 'bg-gray-100 text-gray-500'}>
                          {ORDER_STATUS_LABEL[order.status] ?? order.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-700 mt-1">{order.customer_name} · {formatPhone(order.customer_phone)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatDate(order.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{formatPrice(finalPrice)}</span>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-4 flex flex-col gap-4">
                    {/* 견적 상품 */}
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">견적 상품</p>
                      {items.map((item) => (
                        <div key={item.id} className="text-sm py-2 border-b border-gray-100 last:border-0">
                          <p className="font-medium text-gray-900">{item.fan_name} · {item.color} × {item.quantity}개</p>
                        </div>
                      ))}
                    </div>

                    {/* 배송지 */}
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">배송지</p>
                      {order.shipping_address ? (
                        <>
                          <p className="text-sm text-gray-700 mb-1">수신인: {order.recipient_name || order.customer_name}</p>
                          {order.recipient_phone && (
                            <p className="text-sm text-gray-700 mb-1">수신 연락처: {formatPhone(order.recipient_phone)}</p>
                          )}
                          <p className="text-sm text-gray-800">{order.shipping_address} {order.shipping_detail || ''}</p>
                        </>
                      ) : (
                        <p className="text-sm text-gray-500">고객 배송정보 입력 대기</p>
                      )}
                    </div>

                    {/* 택배사 / 송장번호 */}
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">택배사 / 송장번호</label>
                      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] gap-2 mt-1">
                        <input
                          type="text"
                          placeholder="택배사 입력"
                          value={editTrackingCompany[order.id] || ''}
                          onChange={(e) => setEditTrackingCompany((prev) => ({ ...prev, [order.id]: e.target.value }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-gray-900"
                        />
                        <input
                          type="text"
                          placeholder="송장번호 입력"
                          value={editTracking[order.id] || ''}
                          onChange={(e) => setEditTracking((prev) => ({ ...prev, [order.id]: e.target.value }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-gray-900"
                        />
                        {order.status === 'paid' && (
                          <Button size="sm" loading={savingId === order.id} onClick={() => handleShip(order.id)}>
                            출고 처리
                          </Button>
                        )}
                        {order.status === 'shipped' && (
                          <Button size="sm" variant="secondary" loading={savingId === order.id} onClick={() => handleUpdateTracking(order.id)}>
                            수정
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* 내부 메모 */}
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">내부 메모</label>
                      <div className="flex gap-2 mt-1">
                        <input
                          type="text"
                          placeholder="내부 메모 (고객에게 보이지 않음)"
                          value={editMemo[order.id] || ''}
                          onChange={(e) => setEditMemo((prev) => ({ ...prev, [order.id]: e.target.value }))}
                          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-gray-900"
                        />
                        <Button size="sm" variant="secondary" loading={savingId === order.id} onClick={() => handleSaveMemo(order.id)}>
                          저장
                        </Button>
                      </div>
                    </div>

                    {/* 액션 버튼 */}
                    <div className="flex gap-2 flex-wrap">
                      {order.quote_token && (
                        <Button size="sm" variant="secondary" onClick={() => window.open(`/fan-quotes/${order.quote_token}`, '_blank')}>
                          견적서 열람
                        </Button>
                      )}
                      {order.status === 'waiting_deposit' && (
                        <Button size="sm" loading={savingId === order.id} onClick={() => handleUpdateStatus(order.id, 'paid')}>
                          입금 확인
                        </Button>
                      )}
                      {['quoted', 'shipping_info_submitted', 'waiting_deposit', 'paid'].includes(order.status) && (
                        <Button size="sm" variant="danger" loading={savingId === order.id} onClick={() => handleUpdateStatus(order.id, 'cancelled')}>
                          취소
                        </Button>
                      )}
                      {['quoted', 'shipping_info_submitted', 'waiting_deposit'].includes(order.status) && (
                        <Button size="sm" variant="secondary" loading={savingId === order.id} onClick={() => handleUpdateStatus(order.id, 'expired')}>
                          만료 처리
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
