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
  // 카카오 로컬에서 센 경쟁 장소 수. 키가 없거나 조회에 실패하면 없다.
  placeCount?: number;
  // 검색량 대비 경쟁 장소 수. 클수록 노려볼 만하다.
  opportunityScore?: number;
};

export type KeywordVolumeSummary = {
  inputKeywordCount: number;
  resultCount: number;
  failedCount: number;
  failedKeywords: string[];
  failedItems?: KeywordVolumeFailedItem[];
  naverRequestCount?: number;
  batchedResolvedCount?: number;
  placeCountResolved?: number;
  placeLookupSkipped?: boolean;
  placeLookupError?: string;
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
