export type KeywordVolumeRequest = {
  keywords: string[];
};

export type KeywordVolumeItem = {
  keyword: string;
  relKeyword: string;
  monthlyPcQcCntDisplay: string;
  monthlyMobileQcCntDisplay: string;
  monthlyPcQcCntValue: number;
  monthlyMobileQcCntValue: number;
  totalCount: number;
  mobileRatio: number;
  monthlyAvePcClkCnt: number;
  monthlyAveMobileClkCnt: number;
  monthlyAvePcCtr: number;
  monthlyAveMobileCtr: number;
  compIdx: string;
  recommendUse: string[];
};

export type KeywordVolumeSummary = {
  inputKeywordCount: number;
  resultCount: number;
  failedCount: number;
  failedKeywords: string[];
  failedItems?: KeywordVolumeFailedItem[];
};

export type KeywordVolumeResponse = {
  items: KeywordVolumeItem[];
  summary: KeywordVolumeSummary;
};

export type KeywordVolumeErrorResponse = {
  error: string;
  message: string;
  failedKeywords?: string[];
};

export type KeywordVolumeFailedItem = {
  keyword: string;
  reason: "NO_RESULT" | "REQUEST_FAILED";
};

export type NaverKeywordToolItem = {
  relKeyword?: string;
  monthlyPcQcCnt?: number | string;
  monthlyMobileQcCnt?: number | string;
  monthlyAvePcClkCnt?: number | string;
  monthlyAveMobileClkCnt?: number | string;
  monthlyAvePcCtr?: number | string;
  monthlyAveMobileCtr?: number | string;
  compIdx?: string;
};

export type NaverKeywordToolResponse = {
  keywordList?: NaverKeywordToolItem[];
};
