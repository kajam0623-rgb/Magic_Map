import { NextResponse } from "next/server";
import { fetchNaverKeywordTool, NaverSearchAdConfigError, NaverSearchAdRequestError } from "@/lib/naver-searchad/client";
import {
  findBestKeywordToolItem,
  findExactKeywordToolItem,
  MAX_KEYWORD_VOLUME_INPUT_COUNT,
  normalizeKeywordList,
  normalizeKeywordVolumeItem,
} from "@/lib/naver-searchad/normalize";
import type { KeywordVolumeFailedItem, KeywordVolumeRequest, KeywordVolumeResponse } from "@/types/keyword-volume";

export const runtime = "nodejs";
export const maxDuration = 60;

const NAVER_KEYWORD_REQUEST_DELAY_MS = 300;
const NAVER_KEYWORD_RETRY_COUNT = 4;
// 네이버 검색광고 keywordstool은 hintKeywords에 쉼표로 최대 5개까지 받는다.
// 키워드 도구는 다른 API보다 5~6배 강하게 스로틀되므로 동시 요청 대신 요청 수 자체를 줄인다.
const NAVER_HINT_KEYWORDS_PER_REQUEST = 5;
// 429를 받으면 공식 가이드에 따라 일반 지연보다 훨씬 길게 쉬어야 한다.
const NAVER_KEYWORD_THROTTLED_DELAY_MULTIPLIER = 6;

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelayMs(attemptIndex: number, error: unknown) {
  const isThrottled = error instanceof NaverSearchAdRequestError && error.status === 429;
  const multiplier = isThrottled ? NAVER_KEYWORD_THROTTLED_DELAY_MULTIPLIER : 1;

  return NAVER_KEYWORD_REQUEST_DELAY_MS * attemptIndex * multiplier;
}

async function fetchNaverKeywordToolWithRetry(keyword: string | string[]) {
  let lastResponse = null as Awaited<ReturnType<typeof fetchNaverKeywordTool>> | null;
  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex <= NAVER_KEYWORD_RETRY_COUNT; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await sleep(retryDelayMs(attemptIndex, lastError));
    }

    try {
      lastResponse = await fetchNaverKeywordTool(keyword);

      if ((lastResponse.keywordList ?? []).length > 0) {
        return lastResponse;
      }
    } catch (error) {
      lastError = error;

      if (error instanceof NaverSearchAdConfigError || attemptIndex === NAVER_KEYWORD_RETRY_COUNT) {
        throw error;
      }
    }
  }

  return lastResponse ?? { keywordList: [] };
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function sortKeywordVolumeItems(left: KeywordVolumeResponse["items"][number], right: KeywordVolumeResponse["items"][number]) {
  if (right.totalCount !== left.totalCount) {
    return right.totalCount - left.totalCount;
  }

  if (right.mobileRatio !== left.mobileRatio) {
    return right.mobileRatio - left.mobileRatio;
  }

  return left.keyword.localeCompare(right.keyword, "ko-KR");
}

export async function POST(request: Request) {
  let body: KeywordVolumeRequest;

  try {
    body = (await request.json()) as KeywordVolumeRequest;
  } catch {
    return NextResponse.json(
      {
        error: "INVALID_JSON",
        message: "요청 본문을 JSON으로 해석하지 못했습니다.",
      },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.keywords)) {
    return NextResponse.json(
      {
        error: "INVALID_KEYWORDS",
        message: "keywords는 문자열 배열이어야 합니다.",
      },
      { status: 400 },
    );
  }

  const { keywords, isTooMany } = normalizeKeywordList(body.keywords);

  if (keywords.length === 0) {
    return NextResponse.json(
      {
        error: "EMPTY_KEYWORDS",
        message: "조회할 키워드를 1개 이상 입력해 주세요.",
      },
      { status: 400 },
    );
  }

  if (isTooMany) {
    return NextResponse.json(
      {
        error: "TOO_MANY_KEYWORDS",
        message: `한 번에 최대 ${MAX_KEYWORD_VOLUME_INPUT_COUNT}개 키워드까지만 조회할 수 있습니다.`,
      },
      { status: 400 },
    );
  }

  const items: KeywordVolumeResponse["items"] = [];
  const failedKeywords: string[] = [];
  const failedItems: KeywordVolumeFailedItem[] = [];
  // 묶음 요청에서 정확히 매칭되지 않은 키워드만 개별로 다시 조회한다.
  const unresolvedKeywords: string[] = [];
  let naverRequestCount = 0;
  let batchedResolvedCount = 0;

  const batches = chunkArray(keywords, NAVER_HINT_KEYWORDS_PER_REQUEST);

  for (const batch of batches) {
    try {
      const response = await fetchNaverKeywordToolWithRetry(batch);
      naverRequestCount += 1;
      const keywordList = response.keywordList ?? [];

      for (const keyword of batch) {
        const matchedItem = findExactKeywordToolItem(keyword, keywordList);

        if (matchedItem) {
          items.push(normalizeKeywordVolumeItem(keyword, matchedItem));
          batchedResolvedCount += 1;
        } else {
          unresolvedKeywords.push(keyword);
        }
      }
    } catch (error) {
      if (error instanceof NaverSearchAdConfigError) {
        return NextResponse.json(
          {
            error: "NAVER_SEARCHAD_CONFIG_MISSING",
            message:
              "네이버 검색광고 API 환경변수가 설정되지 않았습니다. .env.local에 API 키, Secret Key, Customer ID를 설정해 주세요.",
          },
          { status: 500 },
        );
      }

      naverRequestCount += 1;
      unresolvedKeywords.push(...batch);
    }

    await sleep(NAVER_KEYWORD_REQUEST_DELAY_MS);
  }

  for (const keyword of unresolvedKeywords) {
    try {
      const response = await fetchNaverKeywordToolWithRetry(keyword);
      naverRequestCount += 1;
      const matchedItem = findBestKeywordToolItem(keyword, response.keywordList ?? []);

      if (!matchedItem) {
        failedKeywords.push(keyword);
        failedItems.push({ keyword, reason: "NO_RESULT" });
        await sleep(NAVER_KEYWORD_REQUEST_DELAY_MS);
        continue;
      }

      items.push(normalizeKeywordVolumeItem(keyword, matchedItem));
      await sleep(NAVER_KEYWORD_REQUEST_DELAY_MS);
    } catch (error) {
      if (error instanceof NaverSearchAdConfigError) {
        return NextResponse.json(
          {
            error: "NAVER_SEARCHAD_CONFIG_MISSING",
            message:
              "네이버 검색광고 API 환경변수가 설정되지 않았습니다. .env.local에 API 키, Secret Key, Customer ID를 설정해 주세요.",
          },
          { status: 500 },
        );
      }

      naverRequestCount += 1;
      failedKeywords.push(keyword);
      failedItems.push({ keyword, reason: "REQUEST_FAILED" });
      await sleep(NAVER_KEYWORD_REQUEST_DELAY_MS);
    }
  }

  const sortedItems = items.sort(sortKeywordVolumeItems);

  return NextResponse.json({
    items: sortedItems,
    summary: {
      inputKeywordCount: keywords.length,
      resultCount: sortedItems.length,
      failedCount: failedKeywords.length,
      failedKeywords,
      failedItems,
      naverRequestCount,
      batchedResolvedCount,
    },
  } satisfies KeywordVolumeResponse);
}
