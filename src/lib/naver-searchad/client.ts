import type { NaverKeywordToolResponse } from "@/types/keyword-volume";
import { createNaverSearchAdSignature } from "./signature";

const DEFAULT_NAVER_SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const KEYWORD_TOOL_URI = "/keywordstool";

export class NaverSearchAdConfigError extends Error {
  constructor() {
    super("네이버 검색광고 API 환경변수가 설정되지 않았습니다.");
    this.name = "NaverSearchAdConfigError";
  }
}

export class NaverSearchAdRequestError extends Error {
  status: number;

  constructor(status: number) {
    super("네이버 검색광고 API 요청에 실패했습니다.");
    this.name = "NaverSearchAdRequestError";
    this.status = status;
  }
}

function getNaverSearchAdConfig() {
  const apiKey = process.env.NAVER_SEARCHAD_API_KEY;
  const secretKey = process.env.NAVER_SEARCHAD_SECRET_KEY;
  const customerId = process.env.NAVER_SEARCHAD_CUSTOMER_ID;
  const baseUrl = process.env.NAVER_SEARCHAD_BASE_URL || DEFAULT_NAVER_SEARCHAD_BASE_URL;

  if (!apiKey || !secretKey || !customerId) {
    throw new NaverSearchAdConfigError();
  }

  return {
    apiKey,
    secretKey,
    customerId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

export async function fetchNaverKeywordTool(keyword: string) {
  const config = getNaverSearchAdConfig();
  const method = "GET";
  const timestamp = Date.now().toString();
  const signature = createNaverSearchAdSignature(timestamp, method, KEYWORD_TOOL_URI, config.secretKey);
  const url = new URL(KEYWORD_TOOL_URI, config.baseUrl);

  url.searchParams.set("hintKeywords", keyword);
  url.searchParams.set("showDetail", "1");

  const response = await fetch(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": config.apiKey,
      "X-Customer": config.customerId,
      "X-Signature": signature,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new NaverSearchAdRequestError(response.status);
  }

  return (await response.json()) as NaverKeywordToolResponse;
}
