const DEFAULT_KAKAO_LOCAL_BASE_URL = "https://dapi.kakao.com";
const KEYWORD_SEARCH_PATH = "/v2/local/search/keyword.json";

export class KakaoLocalConfigError extends Error {
  constructor() {
    super("카카오 로컬 API 키가 설정되지 않았습니다.");
    this.name = "KakaoLocalConfigError";
  }
}

export function hasKakaoLocalKey() {
  return Boolean(process.env.KAKAO_REST_API_KEY);
}

/**
 * 키워드로 잡히는 장소 수를 센다. 목록은 필요 없고 meta.total_count만 쓰므로
 * size는 최소로 요청한다. total_count에는 상한이 없다(pageable_count만 45로 잘린다).
 */
export async function fetchPlaceCount(query: string) {
  const restApiKey = process.env.KAKAO_REST_API_KEY;

  if (!restApiKey) {
    throw new KakaoLocalConfigError();
  }

  const baseUrl = (process.env.KAKAO_LOCAL_BASE_URL || DEFAULT_KAKAO_LOCAL_BASE_URL).replace(/\/+$/, "");
  const url = new URL(KEYWORD_SEARCH_PATH, baseUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("size", "1");

  const response = await fetch(url, {
    headers: { Authorization: `KakaoAK ${restApiKey}` },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`카카오 로컬 API 요청 실패 (${response.status})`);
  }

  const data = (await response.json()) as { meta?: { total_count?: number } };

  return data.meta?.total_count ?? 0;
}
