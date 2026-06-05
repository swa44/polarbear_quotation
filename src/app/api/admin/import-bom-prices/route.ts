import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { checkAdminAuth } from '@/lib/admin-auth'

// 상품명 컬럼이 구수(1구~5구)인 행 = 프레임 가격 행
const FRAME_GANG_NAMES = new Set(['1구', '2구', '3구', '4구', '5구'])
const BOX_CATEGORY = '매립박스'
const FRAME_CATEGORY = '프레임'

function normalizeName(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, '').trim().toLowerCase()
}


function normalizeMaterial(val: string | undefined): 'plastic' | 'metal' {
  if (!val) return 'plastic'
  const v = val.trim().toLowerCase()
  if (v === 'metal' || v.includes('메탈')) return 'metal'
  return 'plastic'
}

// modules 테이블의 category CHECK 제약에 맞게 매핑
function mapModuleCategory(cat: string | undefined): '스위치류' | '콘센트류' | '기타류' {
  if (!cat) return '기타류'
  if (cat.includes('스위치')) return '스위치류'
  if (cat.includes('콘센트')) return '콘센트류'
  return '기타류'
}

interface BomRow {
  상품명: string
  색상: string
  품목코드: string
  제품명: string
  단가: number
  카테고리?: string
  재질?: string
  구수제한?: number | null
}

function parseCSV(text: string): BomRow[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // 실제 헤더 행 찾기 (상품명이 포함된 행)
  const headerIdx = lines.findIndex((l) => l.includes('상품명'))
  if (headerIdx === -1) return []

  const headers = lines[headerIdx].split(',').map((h) => h.trim())
  const rows: BomRow[] = []

  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue

    const cols: string[] = []
    let cur = ''
    let inQuote = false
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote }
      else if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = '' }
      else { cur += ch }
    }
    cols.push(cur.trim())

    const obj = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']))
    const price = Number(String(obj['단가'] ?? '').replace(/[^0-9]/g, '')) || 0

    if (!obj['상품명'] || !obj['품목코드']) continue

    rows.push({
      상품명: obj['상품명'],
      색상: obj['색상'] ?? '',
      품목코드: obj['품목코드'],
      제품명: obj['제품명'] ?? '',
      단가: price,
      카테고리: obj['카테고리'] ?? '',
      재질: obj['재질'] ?? '',
      구수제한: obj['구수제한'] ? (Number(obj['구수제한']) || null) : null,
    })
  }

  return rows
}

export async function POST(req: NextRequest) {
  if (!await checkAdminAuth()) {
    return NextResponse.json({ error: '권한이 없습니다.' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'CSV 파일이 없습니다.' }, { status: 400 })

  const text = await file.text()
  const rows = parseCSV(text)
  if (!rows.length) return NextResponse.json({ error: 'CSV 데이터가 없습니다.' }, { status: 400 })

  try {
  const supabase = createServiceClient()

  // ── frame_colors만 조회 (색상 ID 매핑용, 삭제 대상 아님) ──────
  const colorsRes = await supabase.from('frame_colors').select('id, name, sort_order')
  if (colorsRes.error) return NextResponse.json({ error: `frame_colors 조회 실패: ${colorsRes.error.message}` }, { status: 500 })

  const colors = colorsRes.data ?? []
  const colorIdMap = new Map(colors.map((c) => [c.name, c.id]))
  const colorNormalizedMap = new Map(colors.map((c) => [normalizeName(c.name), c.id]))
  let nextColorSortOrder = colors.reduce((max, c) => Math.max(max, (c as any).sort_order ?? 0), 0) + 1

  // ── 행 분류 ───────────────────────────────────────────────────
  const frameRows = rows.filter(
    (r) => FRAME_GANG_NAMES.has(r.상품명) || r.카테고리 === FRAME_CATEGORY || r.카테고리?.includes('프레임'),
  )
  const boxRows = rows.filter((r) => r.카테고리 === BOX_CATEGORY)
  const moduleRows = rows.filter(
    (r) =>
      !FRAME_GANG_NAMES.has(r.상품명) &&
      r.카테고리 !== FRAME_CATEGORY &&
      !r.카테고리?.includes('프레임') &&
      r.카테고리 !== BOX_CATEGORY,
  )

  // ── 기존 데이터 전체 삭제 (modules, module_parts) ──────────────
  // embedded_boxes는 order_items FK 제약으로 인해 참조 중인 행은 삭제 불가 → 별도 처리
  const { data: refsData } = await supabase.from('order_items').select('embedded_box_id').not('embedded_box_id', 'is', null)
  const referencedBoxIds = [...new Set((refsData ?? []).map((r) => (r as any).embedded_box_id as string).filter(Boolean))]

  const [delModules, delParts] = await Promise.all([
    supabase.from('modules').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('module_parts').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
  ])
  if (delModules.error) return NextResponse.json({ error: `modules 삭제 실패: ${delModules.error.message}` }, { status: 500 })
  if (delParts.error) return NextResponse.json({ error: `module_parts 삭제 실패: ${delParts.error.message}` }, { status: 500 })

  // 참조되지 않는 embedded_boxes만 삭제
  const delBoxes = referencedBoxIds.length > 0
    ? await supabase.from('embedded_boxes').delete().not('id', 'in', `(${referencedBoxIds.join(',')})`)
    : await supabase.from('embedded_boxes').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (delBoxes.error) return NextResponse.json({ error: `embedded_boxes 삭제 실패: ${delBoxes.error.message}` }, { status: 500 })

  // 삭제 후 남아있는 박스(참조 중) 이름 맵
  const { data: remainingBoxes } = await supabase.from('embedded_boxes').select('id, name')
  const existingBoxMap = new Map((remainingBoxes ?? []).map((b) => [normalizeName((b as any).name), (b as any).id as string]))

  let framesUpdated = 0
  let modulesAdded = 0
  let boxesUpdated = 0
  let partsUpserted = 0
  const notFound: string[] = []

  // ── 1. 프레임 (frame_colors 가격 업데이트) ───────────────────
  const frameByColor = new Map<string, Map<number, number>>()
  for (const r of frameRows) {
    const gang = parseInt(r.상품명)
    if (isNaN(gang) || gang < 1 || gang > 5) continue
    if (!frameByColor.has(r.색상)) frameByColor.set(r.색상, new Map())
    frameByColor.get(r.색상)!.set(gang, r.단가)
  }

  for (const [colorName, gangPrices] of frameByColor.entries()) {
    let colorId = colorIdMap.get(colorName) ?? colorNormalizedMap.get(normalizeName(colorName))

    if (!colorId) {
      const materialRow = frameRows.find((r) => r.색상 === colorName)
      const { data: newColor, error } = await supabase
        .from('frame_colors')
        .insert({
          name: colorName,
          material_type: normalizeMaterial(materialRow?.재질),
          price: 0, price_1: 0, price_2: 0, price_3: 0, price_4: 0, price_5: 0,
          is_active: true,
          sort_order: nextColorSortOrder++,
        })
        .select('id')
        .single()
      if (error || !newColor) { notFound.push(`프레임 색상 생성 실패: ${colorName}`); continue }
      colorId = newColor.id
      colorIdMap.set(colorName, colorId)
      colorNormalizedMap.set(normalizeName(colorName), colorId)
    }

    const update: Record<string, number> = {}
    for (const [gang, price] of gangPrices.entries()) update[`price_${gang}`] = price

    const { error } = await supabase.from('frame_colors').update(update).eq('id', colorId)
    if (!error) framesUpdated++
    else notFound.push(`프레임 업데이트 실패: ${colorName}`)
  }

  // ── 2. 매립박스 (embedded_boxes 삽입/업데이트) ──────────────────
  const insertedBoxNames = new Set<string>()
  let boxSortOrder = 1
  for (const r of boxRows) {
    const key = normalizeName(r.상품명)
    if (insertedBoxNames.has(key)) continue
    insertedBoxNames.add(key)

    const existingId = existingBoxMap.get(key)
    if (existingId) {
      const { error } = await supabase.from('embedded_boxes').update({
        price: r.단가,
        image_url: `/boxes/${r.품목코드}.webp`,
        is_active: true,
      }).eq('id', existingId)
      if (!error) boxesUpdated++
      else notFound.push(`매립박스 업데이트 실패: ${r.상품명}`)
    } else {
      const { error } = await supabase.from('embedded_boxes').insert({
        name: r.상품명,
        price: r.단가,
        image_url: `/boxes/${r.품목코드}.webp`,
        is_active: true,
        sort_order: boxSortOrder++,
      })
      if (!error) boxesUpdated++
      else notFound.push(`매립박스 추가 실패: ${r.상품명}`)
    }
  }

  // ── 3. 모듈 (modules 신규 삽입) ─────────────────────────────
  // 상품명+색상으로 묶기: 같은 상품명의 여러 행 = 낱개부품 → 가격 합산
  type ModuleGroup = { 상품명: string; 색상: string; 카테고리: string; totalPrice: number; maxGang: number | null }
  const moduleGroupMap = new Map<string, ModuleGroup>()

  for (const r of moduleRows) {
    const key = `${normalizeName(r.상품명)}||${normalizeName(r.색상)}`
    if (!moduleGroupMap.has(key)) {
      moduleGroupMap.set(key, { 상품명: r.상품명, 색상: r.색상, 카테고리: r.카테고리 ?? '', totalPrice: 0, maxGang: r.구수제한 ?? null })
    }
    moduleGroupMap.get(key)!.totalPrice += r.단가
  }

  let moduleSortOrder = 1
  for (const [, group] of moduleGroupMap) {
    const colorId = colorIdMap.get(group.색상) ?? colorNormalizedMap.get(normalizeName(group.색상))
    if (!colorId) { notFound.push(`색상 없음 (모듈): ${group.상품명} — ${group.색상}`); continue }

    const { error } = await supabase.from('modules').insert({
      frame_color_id: colorId,
      name: group.상품명,
      category: mapModuleCategory(group.카테고리),
      price: group.totalPrice,
      max_gang: group.maxGang,
      is_active: true,
      sort_order: moduleSortOrder++,
    })
    if (!error) modulesAdded++
    else notFound.push(`모듈 추가 실패: ${group.상품명}`)
  }

  // ── 4. module_parts (낱개부품 신규 삽입) ────────────────────
  const partRows = [...frameRows, ...moduleRows, ...boxRows].map((r) => ({
    module_name: r.상품명,
    color_name: r.색상,
    part_code: r.품목코드,
    part_name: r.제품명,
    price: r.단가,
    category: r.카테고리 || null,
    material_type: normalizeMaterial(r.재질),
    is_active: true,
  }))

  if (partRows.length > 0) {
    const { error: insertErr, count } = await supabase
      .from('module_parts')
      .insert(partRows, { count: 'exact' })
    if (insertErr) return NextResponse.json({ error: `module_parts 삽입 실패: ${insertErr.message}` }, { status: 500 })
    partsUpserted = count ?? partRows.length
  }

  return NextResponse.json({ framesUpdated, modulesAdded, boxesUpdated, partsUpserted, notFound })
  } catch (e: any) {
    console.error('[import-bom-prices]', e)
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
