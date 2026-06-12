"use client";

import type { KeywordVolumeItem } from "@/types/keyword-volume";

type KeywordVolumeCsvDownloadButtonProps = {
  items: KeywordVolumeItem[];
};

function csvEscape(value: string | number) {
  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildCsv(headers: string[], rows: (string | number)[][]) {
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

export function KeywordVolumeCsvDownloadButton({ items }: KeywordVolumeCsvDownloadButtonProps) {
  function downloadCsv() {
    const csv = buildCsv(
      [
        "keyword",
        "pc_search_count",
        "mobile_search_count",
        "total_search_count",
        "mobile_ratio",
        "pc_ctr",
        "mobile_ctr",
        "competition",
        "recommend_use",
      ],
      items.map((item) => [
        item.keyword,
        item.monthlyPcQcCntDisplay,
        item.monthlyMobileQcCntDisplay,
        item.totalCount,
        item.mobileRatio.toFixed(1),
        item.monthlyAvePcCtr,
        item.monthlyAveMobileCtr,
        item.compIdx,
        item.recommendUse.join("; "),
      ]),
    );
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "keyword_volume_results.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={items.length === 0}
      type="button"
      onClick={downloadCsv}
    >
      keyword_volume_results.csv 다운로드
    </button>
  );
}
