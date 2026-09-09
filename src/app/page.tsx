import { MagicMap } from "@/components/MagicMap";

export default function Home() {
  return (
    <main className="min-h-screen bg-canvas px-4 py-5 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-rule pb-4">
          <div className="flex items-baseline gap-3">
            <h1 className="whitespace-nowrap text-xl font-semibold tracking-tight text-ink">Magic Map</h1>
            <p className="text-sm text-ink-soft">반경 안 지명으로 지역 SEO 키워드를 만든다</p>
          </div>
          <p className="eyebrow">전철역 · 동읍면 · 시군구 × 네이버 검색량</p>
        </header>

        <MagicMap />
      </div>
    </main>
  );
}
