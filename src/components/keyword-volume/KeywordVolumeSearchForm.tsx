"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  MAX_KEYWORD_VOLUME_INPUT_COUNT,
  normalizeKeywordInput,
} from "@/lib/naver-searchad/normalize";
import type {
  KeywordVolumeErrorResponse,
  KeywordVolumeItem,
  KeywordVolumeResponse,
  KeywordVolumeSummary as KeywordVolumeSummaryData,
} from "@/types/keyword-volume";
import { KeywordVolumeCsvDownloadButton } from "./KeywordVolumeCsvDownloadButton";
import { KeywordVolumeResultTable } from "./KeywordVolumeResultTable";
import { KeywordVolumeSummary } from "./KeywordVolumeSummary";

const KEYWORD_VOLUME_LOCAL_STORAGE_KEY = "localSeoKeywordVolumePayload";

type KeywordVolumeSearchFormProps = {
  initialKeywordInput?: string;
  initialInputSource?: "query" | "localStorage";
};

export function KeywordVolumeSearchForm({ initialKeywordInput = "", initialInputSource }: KeywordVolumeSearchFormProps) {
  const [inputValue, setInputValue] = useState(initialKeywordInput);
  const [items, setItems] = useState<KeywordVolumeItem[]>([]);
  const [summary, setSummary] = useState<KeywordVolumeSummaryData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState(
    initialKeywordInput && initialInputSource === "query" ? "지역 SEO 키워드에서 전달된 키워드를 불러왔습니다." : "",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const normalizedInput = useMemo(() => normalizeKeywordInput(inputValue), [inputValue]);
  const inputCountLabel = `${normalizedInput.keywords.length.toLocaleString("ko-KR")} / ${MAX_KEYWORD_VOLUME_INPUT_COUNT}개`;

  useEffect(() => {
    if (initialInputSource !== "localStorage") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      try {
        const storedKeywords = window.localStorage.getItem(KEYWORD_VOLUME_LOCAL_STORAGE_KEY) ?? "";

        setInputValue(storedKeywords);
        setNoticeMessage(
          storedKeywords
            ? "브라우저 저장소에서 지역 SEO 키워드를 불러왔습니다. 조회 버튼을 눌러 검색량을 확인하세요."
            : "브라우저 저장소에서 전달된 키워드를 찾지 못했습니다.",
        );
      } catch {
        setNoticeMessage("브라우저 저장소를 읽지 못했습니다. 키워드를 직접 입력해 주세요.");
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [initialInputSource]);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setErrorMessage("");

    if (normalizedInput.keywords.length === 0) {
      setErrorMessage("조회할 키워드를 1개 이상 입력해 주세요.");
      return;
    }

    if (normalizedInput.isTooMany) {
      setErrorMessage(`한 번에 최대 ${MAX_KEYWORD_VOLUME_INPUT_COUNT}개 키워드까지만 조회할 수 있습니다.`);
      return;
    }

    setIsLoading(true);
    setHasSearched(true);

    try {
      const response = await fetch("/api/naver-keyword-volume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keywords: normalizedInput.keywords }),
      });
      const data = (await response.json()) as KeywordVolumeResponse | KeywordVolumeErrorResponse;

      if (!response.ok) {
        const errorData = data as KeywordVolumeErrorResponse;

        setItems([]);
        setSummary(null);
        setErrorMessage(errorData.message || "검색량 조회에 실패했습니다.");
        return;
      }

      const result = data as KeywordVolumeResponse;

      setItems(result.items);
      setSummary(result.summary);
      setErrorMessage("");
    } catch {
      setItems([]);
      setSummary(null);
      setErrorMessage("검색량 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setIsLoading(false);
    }
  }

  function resetSearch() {
    setInputValue("");
    setItems([]);
    setSummary(null);
    setErrorMessage("");
    setNoticeMessage("");
    setIsLoading(false);
    setHasSearched(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <form className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm" onSubmit={submitSearch}>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-800" htmlFor="keyword-volume-input">
            키워드 입력
          </label>
          <textarea
            id="keyword-volume-input"
            className="min-h-40 w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
            placeholder={"마두치과, 마두동치과\n백석치과"}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
          />
          <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p>쉼표 또는 줄바꿈으로 여러 키워드를 입력할 수 있습니다.</p>
            <p className={normalizedInput.isTooMany ? "font-semibold text-red-600" : "text-slate-500"}>
              정규화된 키워드 {inputCountLabel}
            </p>
          </div>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {noticeMessage && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
            {noticeMessage}
          </div>
        )}

        {summary && summary.failedKeywords.length > 0 && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            일부 키워드는 조회하지 못했습니다: {summary.failedKeywords.join(", ")}
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoading}
            type="submit"
          >
            {isLoading ? "조회 중..." : "조회"}
          </button>
          <button
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-500"
            disabled={isLoading}
            type="button"
            onClick={resetSearch}
          >
            초기화
          </button>
          <KeywordVolumeCsvDownloadButton items={items} />
        </div>
      </form>

      <KeywordVolumeSummary items={items} summary={summary} />
      <KeywordVolumeResultTable hasSearched={hasSearched} isLoading={isLoading} items={items} />
    </div>
  );
}
