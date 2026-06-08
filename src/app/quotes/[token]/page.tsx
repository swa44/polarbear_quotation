"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { formatDate, formatPrice } from "@/lib/utils";
import { ModulePart, Order } from "@/types";

declare global {
  interface Window {
    daum?: {
      Postcode: new (options: {
        oncomplete: (data: {
          roadAddress: string;
          jibunAddress: string;
          bname: string;
          buildingName: string;
          apartment: "Y" | "N";
          zonecode: string;
        }) => void;
      }) => { open: () => void };
    };
  }
}

type QuoteResponse = {
  quote: Order;
  bank: {
    bankName: string;
    bankAccount: string;
    bankHolder: string;
  };
};

export default function QuotePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [data, setData] = useState<QuoteResponse | null>(null);
  const [parts, setParts] = useState<ModulePart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [postcodeReady, setPostcodeReady] = useState(false);
  const [shippingFormOpen, setShippingFormOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [trackingCopied, setTrackingCopied] = useState(false);
  const [showReturnNotice, setShowReturnNotice] = useState(false);

  const [recipientName, setRecipientName] = useState("");
  const [receiverPhone, setReceiverPhone] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [shippingDetail, setShippingDetail] = useState("");
  const [shippingMemo, setShippingMemo] = useState("");

  const canSubmitShipping = useMemo(() => {
    if (!data?.quote) return false;
    return ["quoted", "shipping_info_submitted", "waiting_deposit"].includes(
      data.quote.status,
    );
  }, [data]);

  useEffect(() => {
    fetch("/api/module-parts")
      .then((r) => r.json())
      .then(({ parts: p }) => {
        if (p) setParts(p);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (window.daum?.Postcode) {
      setPostcodeReady(true);
      return;
    }

    const existingScript = document.getElementById("daum-postcode-script");
    if (existingScript) {
      const onLoad = () => setPostcodeReady(true);
      existingScript.addEventListener("load", onLoad);
      return () => existingScript.removeEventListener("load", onLoad);
    }

    const script = document.createElement("script");
    script.id = "daum-postcode-script";
    script.src =
      "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
    script.async = true;
    script.onload = () => setPostcodeReady(true);
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError("");
        const res = await fetch(`/api/quotes/${token}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok)
          throw new Error(json.error || "견적을 불러오지 못했습니다.");
        if (cancelled) return;

        setData(json);
        setRecipientName(
          json.quote.recipient_name || json.quote.customer_name || "",
        );
        setReceiverPhone(
          json.quote.recipient_phone || json.quote.customer_phone || "",
        );
        setShippingAddress(json.quote.shipping_address || "");
        setShippingDetail(
          (json.quote.shipping_detail || "").split(" / ")[0] || "",
        );
        setShippingMemo(
          (json.quote.shipping_detail || "").split(" / ").slice(1).join(" / "),
        );
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "견적 조회에 실패했습니다.";
        if (!cancelled) setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSearchAddress = () => {
    if (!window.daum?.Postcode) {
      alert(
        "주소 검색 스크립트를 불러오는 중입니다. 잠시 후 다시 시도해주세요.",
      );
      return;
    }

    new window.daum.Postcode({
      oncomplete: (data) => {
        const baseAddress = data.roadAddress || data.jibunAddress;
        let extraAddress = "";

        if (data.roadAddress) {
          const extras = [
            data.bname,
            data.apartment === "Y" ? data.buildingName : "",
          ].filter(Boolean);

          if (extras.length > 0) {
            extraAddress = ` (${extras.join(", ")})`;
          }
        }

        setShippingAddress(`[${data.zonecode}] ${baseAddress}${extraAddress}`);
      },
    }).open();
  };

  const handleSubmitShipping = async () => {
    if (
      !recipientName.trim() ||
      !receiverPhone.trim() ||
      !shippingAddress.trim()
    ) {
      alert("수령인, 연락처, 주소를 입력해주세요.");
      return;
    }

    try {
      setSaving(true);
      setError("");
      const res = await fetch(`/api/quotes/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientName,
          receiverPhone,
          shippingAddress,
          shippingDetail,
          shippingMemo,
        }),
      });
      const json = await res.json();
      if (!res.ok)
        throw new Error(json.error || "배송정보 저장에 실패했습니다.");
      setSaved(true);

      const refreshed = await fetch(`/api/quotes/${token}`, {
        cache: "no-store",
      });
      const refreshedJson = await refreshed.json();
      if (refreshed.ok) setData(refreshedJson);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "배송정보 저장에 실패했습니다.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopyAccount = async () => {
    const accountNumber = "68991001584904";

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(accountNumber);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = accountNumber;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const copiedByCommand = document.execCommand("copy");
        document.body.removeChild(textArea);

        if (!copiedByCommand) {
          throw new Error("execCommand copy failed");
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("아래 계좌번호를 복사해주세요.", accountNumber);
    }
  };

  const handleCopyTrackingNumber = async (trackingNumber: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(trackingNumber);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = trackingNumber;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const copiedByCommand = document.execCommand("copy");
        document.body.removeChild(textArea);

        if (!copiedByCommand) {
          throw new Error("execCommand copy failed");
        }
      }
      setTrackingCopied(true);
      setTimeout(() => setTrackingCopied(false), 1800);
    } catch {
      window.prompt("아래 송장번호를 복사해주세요.", trackingNumber);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-12">
        <div className="max-w-lg mx-auto flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-12">
        <div className="max-w-lg mx-auto bg-white rounded-2xl border border-red-100 p-5">
          <h1 className="text-lg font-bold text-gray-900">견적서 확인</h1>
          <p className="text-sm text-red-600 mt-2">
            {error || "견적서를 찾을 수 없습니다."}
          </p>
        </div>
      </div>
    );
  }

  const { quote, bank } = data;

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="max-w-lg mx-auto flex flex-col gap-4">
        <section className="bg-white rounded-2xl border border-gray-100 p-5">
          <h1 className="text-xl font-bold text-gray-900">견적서</h1>
          {quote.quote_expires_at && (
            <p className="text-xs text-gray-500 mt-1">
              유효기간: {formatDate(quote.quote_expires_at)}
            </p>
          )}
        </section>

        <section className="bg-white rounded-2xl border border-gray-400 p-5">
          <p className="text-md font-semibold text-gray-500 mb-2">공급자</p>
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2 text-md">
              <span className="text-gray-500 w-20 shrink-0">상호명</span>
              <span className="text-gray-800 font-medium">
                주식회사 폴라베어
              </span>
            </div>
            <div className="flex gap-2 text-md">
              <span className="text-gray-500 w-20 shrink-0">등록번호</span>
              <span className="text-gray-800">883-87-01986</span>
            </div>
            <div className="flex gap-2 text-md">
              <span className="text-gray-500 w-20 shrink-0">소재지</span>
              <span className="text-gray-800">
                대전 유성구 반석로 148 전면 1층
              </span>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-blue-200 p-5">
          <p className="text-sm font-semibold text-gray-700 mb-3">견적 항목</p>
          <div className="flex flex-col gap-3">
            {(quote.order_items || []).map((item) => {
              const isSet = item.modules.length > 0;
              return (
                <div
                  key={item.id}
                  className="border border-blue-100 bg-blue-50 rounded-xl p-3"
                >
                  <p className="text-sm font-semibold text-gray-900 mb-2">
                    {isSet
                      ? `${item.gang_count}구 · ${item.frame_color_name} × ${item.quantity}개`
                      : `${item.frame_color_name} × ${item.quantity}개`}
                  </p>

                  {isSet ? (
                    <div className="flex flex-col gap-2">
                      {/* 프레임 */}
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-600">
                          {item.gang_count}구 프레임 · {item.frame_color_name}
                        </span>
                        <span className="font-medium text-gray-800">
                          {formatPrice(item.frame_color_price)}
                        </span>
                      </div>

                      {/* 모듈별 부품 내역 */}
                      {item.modules.map((m, i) => {
                        const moduleParts = parts.filter(
                          (p) =>
                            p.module_name === m.module_name &&
                            p.color_name === item.frame_color_name,
                        );
                        return (
                          <div
                            key={`${item.id}-m${i}`}
                            className="flex flex-col gap-0.5"
                          >
                            <p className="text-xs font-semibold text-gray-700">
                              {m.module_name}
                            </p>
                            {moduleParts.length > 0 ? (
                              moduleParts.map((p) => (
                                <div
                                  key={p.id}
                                  className="flex justify-between text-xs pl-2"
                                >
                                  <span className="text-gray-500">
                                    {p.part_name}
                                  </span>
                                  <span className="text-gray-700">
                                    {formatPrice(p.price)}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="flex justify-between text-xs pl-2">
                                <span className="text-gray-500">모듈</span>
                                <span className="text-gray-700">
                                  {formatPrice(m.module_price)}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* 매립박스 */}
                      {item.embedded_box_name && (
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-600">
                            매립박스 · {item.embedded_box_name}
                          </span>
                          <span className="font-medium text-gray-800">
                            {formatPrice(item.embedded_box_price)}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : null}

                  <div className="flex justify-between text-sm font-semibold text-gray-900 mt-2 pt-2 border-t border-blue-100">
                    <span>소계</span>
                    <span>
                      {item.quantity > 1
                        ? `${formatPrice(item.item_price)} × ${item.quantity} = ${formatPrice(item.total_price)}`
                        : formatPrice(item.total_price)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {(() => {
            const discountedProduct = Math.round((quote.total_price * 0.65) / 10) * 10;
            const discountAmount = quote.total_price - discountedProduct;
            const finalPrice = discountedProduct + 3000;
            return (
              <div className="flex flex-col gap-1.5 mt-4 pt-3 border-t border-gray-100">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">상품 금액</span>
                  <span className="text-sm text-gray-700">
                    {formatPrice(quote.total_price)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-red-500">폴라베어 특별 프로모션</span>
                  <span className="text-sm font-medium text-red-500">-{formatPrice(discountAmount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">배송비</span>
                  <span className="text-sm text-gray-700">{formatPrice(3000)}</span>
                </div>
                <div className="flex items-center justify-between pt-1.5 border-t border-gray-100">
                  <span className="text-sm text-gray-500">최종 금액</span>
                  <span className="text-lg font-bold text-gray-900">
                    {formatPrice(finalPrice)}
                  </span>
                </div>
              </div>
            );
          })()}
        </section>

        {quote.tracking_company && quote.tracking_number && (
          <section className="bg-orange-100 rounded-2xl border border-gray-300 p-5">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-sm font-semibold text-orange-700">배송조회</p>
              <button
                onClick={() => handleCopyTrackingNumber(quote.tracking_number!)}
                className="text-xs px-3 py-1.5 rounded-lg border border-orange-300 text-orange-700 hover:bg-orange-50"
              >
                {trackingCopied ? "복사됨" : "송장번호 복사"}
              </button>
            </div>
            <p className="text-sm text-orange-800">
              택배사 : {quote.tracking_company}
            </p>
            <p className="text-sm text-orange-800">
              송장번호 : {quote.tracking_number}
            </p>
          </section>
        )}

        {!(quote.tracking_company && quote.tracking_number) && (
          <section className="bg-white rounded-2xl border border-gray-300 p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-gray-700">
                입금 계좌 안내
              </p>
              <button
                onClick={handleCopyAccount}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {copied ? "복사됨" : "계좌번호 복사"}
              </button>
            </div>
            <p className="text-sm text-gray-700 mt-2">은행 : 국민은행</p>
            <p className="text-sm text-gray-700">계좌 : 538237-04-004330</p>
            <p className="text-sm text-gray-700">예금주 : (주)폴라베어</p>
          </section>
        )}

        {!(quote.tracking_company && quote.tracking_number) && (
          <section className="bg-red-50 rounded-2xl border border-gray-300 p-5">
            <p className="text-sm text-red-600">
              ･ 구매를 원하시는 분은 배송 정보를 입력해주세요.<br />
              &nbsp;&nbsp;&nbsp;확인 후 입금 및 제품 관련 연락 드리겠습니다.
            </p>
            <p className="text-sm text-red-600 mt-1">
              ･ 견적서 유효기간 내 배송요청이 없을 경우,<br />
              &nbsp;&nbsp;&nbsp;해당 주문서는 삭제됩니다.
            </p>
            <p className="text-sm text-red-600 mt-1">
              ･ 추가 문의는 010-8434-8204 로 연락주세요.
            </p>
          </section>
        )}

        {!(quote.tracking_company && quote.tracking_number) && (
          <section className="bg-white rounded-2xl border border-gray-100 p-5 flex flex-col gap-3">
            <h2 className="text-base font-bold text-gray-900">배송정보 입력</h2>
            {quote.status === 'expired' && (
              <p className="text-sm text-red-500">견적서 유효기간이 만료되어 배송정보를 입력할 수 없습니다.</p>
            )}
            {quote.status === 'cancelled' && (
              <p className="text-sm text-red-500">취소된 견적서입니다.</p>
            )}
            {(quote.status === 'paid' || quote.status === 'shipped') && (
              <p className="text-sm text-gray-500">이미 처리된 주문입니다.</p>
            )}
            {!shippingFormOpen && canSubmitShipping && !saved && (
              <Button
                onClick={() => setShippingFormOpen(true)}
                fullWidth
                size="lg"
              >
                배송정보 입력하기
              </Button>
            )}
            {shippingFormOpen && (
              <>
                <Input
                  label="수령인"
                  placeholder="수령인 이름"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  disabled={saved}
                />
                <Input
                  label="연락처"
                  placeholder="01012345678"
                  value={receiverPhone}
                  onChange={(e) => setReceiverPhone(e.target.value)}
                  disabled={saved}
                />
                <Input
                  label="주소"
                  placeholder="클릭하여 주소 검색"
                  value={shippingAddress}
                  onClick={handleSearchAddress}
                  onChange={() => {}}
                  readOnly
                  disabled={!postcodeReady || saved}
                  className="cursor-pointer"
                />
                <Input
                  label="상세주소"
                  placeholder="동/호수, 건물명"
                  value={shippingDetail}
                  onChange={(e) => setShippingDetail(e.target.value)}
                  disabled={saved}
                />
                <Input
                  label="배송메모 (선택)"
                  placeholder="부재시 경비실 보관 등"
                  value={shippingMemo}
                  onChange={(e) => setShippingMemo(e.target.value)}
                  disabled={saved}
                />
              </>
            )}

            {saved && (
              <p className="text-sm text-green-700">
                배송정보가 저장되었습니다. 입금 확인 후 출고됩니다.
              </p>
            )}
            {error && <p className="text-sm text-red-500">{error}</p>}

            {shippingFormOpen && !saved && (
              <Button
                onClick={() => setShowReturnNotice(true)}
                loading={saving}
                fullWidth
                size="lg"
              >
                배송정보 제출
              </Button>
            )}
          </section>
        )}
      </div>

      {showReturnNotice && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-50"
            onClick={() => setShowReturnNotice(false)}
          />
          <div className="fixed inset-x-6 top-1/2 -translate-y-1/2 z-50 max-w-sm mx-auto bg-white rounded-2xl shadow-xl p-6 flex flex-col gap-4">
            <h2 className="text-base font-bold text-gray-900">안내</h2>
            <p className="text-md text-gray-700 leading-relaxed text-center">
              해당 제품은 개별 포장이 되어있는 제품으로
              <br />
              개봉 후 단순변심등의 이유로는 <br />
              반품이 되지 않습니다.
              <br />
              <br />
              <p className="font-bold text-red-600">
                반드시, 제품 수령 후 <br />
                품목 확인하시고 개봉해주세요.
              </p>
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <Button
                onClick={() => {
                  setShowReturnNotice(false);
                  handleSubmitShipping();
                }}
                loading={saving}
                fullWidth
                size="lg"
              >
                확인했습니다.
              </Button>
              <Button
                onClick={() => setShowReturnNotice(false)}
                variant="ghost"
                fullWidth
              >
                취소
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
