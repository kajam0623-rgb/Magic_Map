import { KeywordVolumeSearchForm } from "@/components/keyword-volume/KeywordVolumeSearchForm";

type KeywordVolumePageProps = {
  searchParams?: Promise<{
    keywords?: string | string[];
    source?: string | string[];
  }>;
};

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function KeywordVolumePage({ searchParams }: KeywordVolumePageProps) {
  const params = searchParams ? await searchParams : {};
  const keywordsParam = firstSearchParam(params.keywords);
  const sourceParam = firstSearchParam(params.source);
  const initialInputSource = sourceParam === "localStorage" ? "localStorage" : keywordsParam ? "query" : undefined;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-blue-700">Magic Map</p>
          <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">네이버 검색량 조회</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
            네이버 검색광고 API 기반 월간 PC/모바일 검색량 조회
          </p>
        </header>

        <KeywordVolumeSearchForm initialInputSource={initialInputSource} initialKeywordInput={keywordsParam ?? ""} />
      </div>
    </main>
  );
}
