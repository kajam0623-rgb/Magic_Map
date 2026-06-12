import type { KeywordVolumeItem } from "@/types/keyword-volume";

type KeywordVolumeResultTableProps = {
  items: KeywordVolumeItem[];
  isLoading: boolean;
  hasSearched: boolean;
};

function formatNumber(value: number) {
  return value.toLocaleString("ko-KR");
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

export function KeywordVolumeResultTable({ items, isLoading, hasSearched }: KeywordVolumeResultTableProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <h2 className="text-xl font-semibold text-slate-950">검색량 결과</h2>
        <p className="mt-1 text-sm text-slate-500">
          네이버 검색광고 API 응답을 기준으로 검색량과 추천 용도를 계산합니다.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">키워드</th>
              <th className="px-4 py-3">PC 검색량</th>
              <th className="px-4 py-3">모바일 검색량</th>
              <th className="px-4 py-3">총 검색량</th>
              <th className="px-4 py-3">모바일 비중</th>
              <th className="px-4 py-3">PC 클릭률</th>
              <th className="px-4 py-3">모바일 클릭률</th>
              <th className="px-4 py-3">경쟁도</th>
              <th className="px-4 py-3">추천 용도</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {items.length > 0 ? (
              items.map((item) => (
                <tr className="align-top hover:bg-slate-50" key={item.keyword}>
                  <td className="px-4 py-3 font-semibold text-slate-950">
                    {item.keyword}
                    {item.relKeyword !== item.keyword && (
                      <span className="mt-1 block text-xs font-normal text-slate-500">응답: {item.relKeyword}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{item.monthlyPcQcCntDisplay}</td>
                  <td className="px-4 py-3 text-slate-700">{item.monthlyMobileQcCntDisplay}</td>
                  <td className="px-4 py-3 font-semibold text-slate-950">{formatNumber(item.totalCount)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatPercent(item.mobileRatio)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatPercent(item.monthlyAvePcCtr)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatPercent(item.monthlyAveMobileCtr)}</td>
                  <td className="px-4 py-3 text-slate-700">{item.compIdx || "-"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {item.recommendUse.map((recommendation) => (
                        <span className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700" key={recommendation}>
                          {recommendation}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-4 py-12 text-center text-slate-500" colSpan={9}>
                  {isLoading
                    ? "네이버 검색광고 API로 검색량을 조회하는 중입니다."
                    : hasSearched
                      ? "표시할 검색량 결과가 없습니다."
                      : "키워드를 입력하고 조회 버튼을 누르면 결과가 표시됩니다."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
