export type ParsedSearchCount = {
  display: string;
  value: number;
};

export function parseSearchCount(rawValue: unknown): ParsedSearchCount {
  const rawText = String(rawValue ?? "").trim();

  if (!rawText) {
    return { display: "", value: 0 };
  }

  if (rawText === "< 10" || rawText === "<10") {
    return { display: "< 10", value: 5 };
  }

  const numericValue = Number(rawText.replace(/,/g, ""));

  if (!Number.isFinite(numericValue)) {
    return { display: rawText, value: 0 };
  }

  return {
    display: Math.round(numericValue).toLocaleString("ko-KR"),
    value: numericValue,
  };
}

export function parseMetricNumber(rawValue: unknown) {
  const numericValue = Number(String(rawValue ?? "0").replace(/,/g, ""));

  return Number.isFinite(numericValue) ? numericValue : 0;
}
