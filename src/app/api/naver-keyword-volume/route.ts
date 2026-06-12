import { NextResponse } from "next/server";
import { fetchNaverKeywordTool, NaverSearchAdConfigError } from "@/lib/naver-searchad/client";
import {
  findBestKeywordToolItem,
  MAX_KEYWORD_VOLUME_INPUT_COUNT,
  normalizeKeywordList,
  normalizeKeywordVolumeItem,
} from "@/lib/naver-searchad/normalize";
import type { KeywordVolumeFailedItem, KeywordVolumeRequest, KeywordVolumeResponse } from "@/types/keyword-volume";

export const runtime = "nodejs";
const NAVER_KEYWORD_REQUEST_DELAY_MS = 300;
const NAVER_KEYWORD_RETRY_COUNT = 4;

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchNaverKeywordToolWithRetry(keyword: string) {
  let lastResponse = null as Awaited<ReturnType<typeof fetchNaverKeywordTool>> | null;

  for (let attemptIndex = 0; attemptIndex <= NAVER_KEYWORD_RETRY_COUNT; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await sleep(NAVER_KEYWORD_REQUEST_DELAY_MS * attemptIndex);
    }

    try {
      lastResponse = await fetchNaverKeywordTool(keyword);

      if ((lastResponse.keywordList ?? []).length > 0) {
        return lastResponse;
      }
    } catch (error) {
      if (error instanceof NaverSearchAdConfigError || attemptIndex === NAVER_KEYWORD_RETRY_COUNT) {
        throw error;
      }
    }
  }

  return lastResponse ?? { keywordList: [] };
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

  for (const keyword of keywords) {
    try {
      const response = await fetchNaverKeywordToolWithRetry(keyword);
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
    },
  } satisfies KeywordVolumeResponse);
}
