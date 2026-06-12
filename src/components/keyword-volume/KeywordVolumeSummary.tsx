import type { KeywordVolumeItem, KeywordVolumeSummary as KeywordVolumeSummaryData } from "@/types/keyword-volume";

type KeywordVolumeSummaryProps = {
  items: KeywordVolumeItem[];
  summary: KeywordVolumeSummaryData | null;
};

function formatNumber(value: number) {
  return value.toLocaleString("ko-KR");
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function KeywordVolumeSummary({ items, summary }: KeywordVolumeSummaryProps) {
  const totalSearchCount = items.reduce((sum, item) => sum + item.totalCount, 0);
  const averageMobileRatio = Math.round(average(items.map((item) => item.mobileRatio)) * 10) / 10;
  const mainSeoCount = items.filter((item) => item.recommendUse.includes("메인 SEO")).length;
  const longTailCount = items.filter((item) => item.recommendUse.includes("롱테일")).length;

  const cards = [
    { label: "입력 키워드 수", value: formatNumber(summary?.inputKeywordCount ?? 0) },
    { label: "조회 결과 수", value: formatNumber(summary?.resultCount ?? 0) },
    { label: "총 검색량 합계", value: formatNumber(totalSearchCount) },
    { label: "모바일 평균 비중", value: `${averageMobileRatio.toFixed(1)}%` },
    { label: "메인 SEO 후보", value: formatNumber(mainSeoCount) },
    { label: "롱테일 후보", value: formatNumber(longTailCount) },
  ];

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {cards.map((card) => (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" key={card.label}>
          <dt className="text-xs font-medium text-slate-500">{card.label}</dt>
          <dd className="mt-2 text-xl font-semibold text-slate-950">{card.value}</dd>
        </div>
      ))}
    </section>
  );
}
