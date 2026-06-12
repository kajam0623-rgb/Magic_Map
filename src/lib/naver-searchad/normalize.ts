import type { KeywordVolumeItem, NaverKeywordToolItem } from "@/types/keyword-volume";
import { parseMetricNumber, parseSearchCount } from "./parse-count";
import { buildKeywordVolumeRecommendations } from "./recommend";

export const MAX_KEYWORD_VOLUME_INPUT_COUNT = 50;

export function normalizeKeywordInput(input: string) {
  return normalizeKeywordList(input.split(/[,\n]/));
}

export function normalizeKeywordList(values: unknown[]) {
  const keywords = Array.from(
    new Set(
      values
        .flatMap((value) => String(value ?? "").split(/[,\n]/))
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );

  return {
    keywords,
    isTooMany: keywords.length > MAX_KEYWORD_VOLUME_INPUT_COUNT,
  };
}

function compactKeyword(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function findBestKeywordToolItem(keyword: string, items: NaverKeywordToolItem[]) {
  const compactInput = compactKeyword(keyword);

  return (
    items.find((item) => compactKeyword(item.relKeyword ?? "") === compactInput) ??
    items.find((item) => compactKeyword(item.relKeyword ?? "").includes(compactInput)) ??
    items[0]
  );
}

function roundOneDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export function normalizeKeywordVolumeItem(keyword: string, item: NaverKeywordToolItem): KeywordVolumeItem {
  const pcSearchCount = parseSearchCount(item.monthlyPcQcCnt);
  const mobileSearchCount = parseSearchCount(item.monthlyMobileQcCnt);
  const totalCount = pcSearchCount.value + mobileSearchCount.value;
  const mobileRatio = totalCount > 0 ? roundOneDecimal((mobileSearchCount.value / totalCount) * 100) : 0;
  const compIdx = item.compIdx ?? "";

  return {
    keyword,
    relKeyword: item.relKeyword ?? keyword,
    monthlyPcQcCntDisplay: pcSearchCount.display,
    monthlyMobileQcCntDisplay: mobileSearchCount.display,
    monthlyPcQcCntValue: pcSearchCount.value,
    monthlyMobileQcCntValue: mobileSearchCount.value,
    totalCount,
    mobileRatio,
    monthlyAvePcClkCnt: parseMetricNumber(item.monthlyAvePcClkCnt),
    monthlyAveMobileClkCnt: parseMetricNumber(item.monthlyAveMobileClkCnt),
    monthlyAvePcCtr: parseMetricNumber(item.monthlyAvePcCtr),
    monthlyAveMobileCtr: parseMetricNumber(item.monthlyAveMobileCtr),
    compIdx,
    recommendUse: buildKeywordVolumeRecommendations(totalCount, mobileRatio, compIdx),
  };
}
