import { MagicMap } from "@/components/MagicMap";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-blue-700">Magic Map</p>
          <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">지역 SEO 반경 지도</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
            결과를 탭으로 정리하고 복사, 필터, 네이버 검색량 조회와 엑셀 저장까지 제공합니다.
          </p>
        </header>

        <MagicMap />
      </div>
    </main>
  );
}
