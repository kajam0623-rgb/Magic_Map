# Magic Map

한국 지도에서 지점을 선택하고 반경을 정하면, 반경 안의 전철역과 동/읍/면을 찾아 지역 SEO 키워드를 자동 생성하는 웹앱입니다.

Live Demo: https://magic-map-fawn.vercel.app  
Repository: https://github.com/kajam0623-rgb/Magic_Map

## 소개

Magic Map은 지역 기반 검색 키워드를 빠르게 만들기 위한 반경 지도 도구입니다.

사용자는 주소 검색 또는 지도 클릭으로 중심 좌표를 선택하고, 1km부터 10km까지의 세부 반경과 20km, 30km 확장 반경을 지정할 수 있습니다. 앱은 전국 전철역 CSV와 전국 행정동 GeoJSON을 기준으로 반경 안에 포함되는 지역 요소를 계산한 뒤, 사용자가 입력한 기본 키워드와 조합해 SEO 키워드를 생성합니다.

예를 들어 `마두동` 근처에서 `치과`를 입력하면 `마두역치과`, `마두치과`, `마두동치과`처럼 실제 지역명 기반 키워드를 한 번에 만들 수 있습니다.

## 주요 기능

- 주소 검색 또는 지도 클릭으로 중심 좌표 선택
- 1km~10km, 20km, 30km 반경 선택 UI
- 선택 지점 마커와 반경 원 표시
- 카카오맵 지원, 앱 키가 없을 때 OpenStreetMap 자동 fallback
- `public/data/stations.csv` 기준 전국 전철역 거리 계산
- 반경 안 전철역을 거리 오름차순으로 정렬
- `public/data/eupmyeondong.geojson` 기준 동/읍/면 경계 교차 계산
- Turf.js buffer와 `booleanIntersects` 기반 행정구역 포함 판정
- 쉼표와 줄바꿈으로 여러 기본 키워드 입력
- suffix 포함 키워드와 suffix 제거 키워드 동시 생성
- 중복 키워드 병합 및 원본 출처 `sourceItems` 보존
- 결과 탭: 전체 요약, 전철역, 동/읍/면, 생성 키워드, CSV 다운로드
- 키워드 전체 복사, 선택 키워드 복사
- 중복 병합 ON/OFF, suffix 포함/제거, 전철역/동/읍/면 필터
- UTF-8 BOM CSV 다운로드로 엑셀 한글 깨짐 방지

## 키워드 생성 예시

```txt
마두역 + 치과 -> 마두역치과, 마두치과
마두동 + 치과 -> 마두동치과, 마두치과
조치원읍 + 치과 -> 조치원읍치과, 조치원치과
대화면 + 치과 -> 대화면치과, 대화치과
역삼역 + 치과 -> 역삼역치과, 역삼치과
```

suffix 제거는 문자열 끝에 있을 때만 적용합니다. 이름 중간 글자는 제거하지 않습니다.

## 데이터 기준

이 프로젝트는 카카오 Local API 검색 결과만으로 역이나 행정구역 목록을 만들지 않습니다. 실제 계산은 저장소에 포함된 정적 데이터 파일을 기준으로 수행합니다.

### 전철역

```txt
public/data/stations.csv
```

필수 컬럼:

```csv
id,station_name,line_name,station_type,lat,lng,source
```

현재 데이터는 레일포털의 `전체_도시철도역사정보_20260228` XLSX를 변환한 전국 도시철도/광역철도 역사 데이터입니다. 환승역처럼 원본에 노선별로 중복된 행은 역사명과 도로명주소 기준으로 묶고, 노선명은 `line_name`에 합쳤습니다.

### 동/읍/면

```txt
public/data/eupmyeondong.geojson
```

사용 속성:

```txt
original_name, type, sido, sigungu, source
```

현재 데이터는 `admdongkor`의 `20260401` 전국 행정동 경계 3,558개를 변환한 GeoJSON입니다.

행정구역 포함 여부는 centroid 기준이 아니라 `polygon_intersects` 기준입니다. 거리값은 polygon centroid와 중심점 사이의 참고값으로만 표시합니다.

## 기술 스택

- Next.js
- TypeScript
- React
- Turf.js
- Leaflet / OpenStreetMap fallback
- Kakao Maps optional integration
- CSV / GeoJSON 정적 데이터 처리

## 사용 방법

### 1. 설치

```bash
npm install
```

### 2. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 아래 주소를 엽니다.

```txt
http://localhost:3000
```

### 3. 빌드

```bash
npm run build
```

### 4. 전국 데이터 재생성

```bash
npm run build:data
```

전철역 원본 XLSX가 `tmp/kric_stations.xlsx`에 없으면 레일포털에서 자동 다운로드합니다. `tmp` 폴더는 생성용 캐시이며 저장소에는 포함하지 않습니다.

## 카카오맵 키 설정

카카오 JavaScript 앱 키가 있으면 카카오맵으로 실행할 수 있습니다. 키가 없으면 OpenStreetMap/Leaflet 지도로 자동 전환됩니다.

카카오맵을 사용할 때는 카카오 개발자 콘솔의 Web 플랫폼에 아래 도메인을 등록합니다.

```txt
http://localhost:3000
```

프로젝트 루트에 `.env.local` 파일을 만들고 아래 값을 입력합니다.

```env
NEXT_PUBLIC_KAKAO_MAP_APP_KEY=카카오_JavaScript_앱_키
```

## CSV 다운로드

앱에서 아래 파일을 내려받을 수 있습니다.

```txt
stations_result.csv
admin_areas_result.csv
keyword_results.csv
```

모든 CSV는 UTF-8 BOM을 포함해 엑셀에서 한글이 깨지지 않도록 생성합니다.

## 네이버 검색량 조회

`/keyword-volume` 페이지에서 키워드를 직접 입력하면 네이버 검색광고 API `/keywordstool`을 서버 API Route에서 호출해 월간 PC/모바일 검색량, 총 검색량, 모바일 비중, 클릭률, 경쟁도, 추천 용도를 확인할 수 있습니다.

네이버 API 키는 서버 환경변수로만 사용하며 프론트엔드에 노출하지 않습니다.

```env
NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET_KEY=
NAVER_SEARCHAD_CUSTOMER_ID=
NAVER_SEARCHAD_BASE_URL=https://api.searchad.naver.com
```

검색량 응답이 `< 10`인 경우 화면에는 `< 10`으로 표시하고, 총 검색량과 모바일 비중 계산에서는 편의를 위해 `5`로 환산합니다.

한 번에 최대 50개 키워드까지만 조회할 수 있습니다. 50개를 초과하면 검색량 조회 페이지에서 제한 안내를 표시하며, 사용자는 textarea에서 키워드를 줄인 뒤 다시 조회할 수 있습니다.

### 지역 SEO 키워드와 검색량 조회 연결

기존 지역 SEO 키워드 탭에서 생성된 키워드를 선택한 뒤 `선택 키워드 검색량 조회` 버튼을 누르면 현재 테이블 안에 전체검색, PC검색, 모바일검색, 모바일 비중, 경쟁도, 추천 용도가 바로 표시됩니다. `전체 키워드 검색량 조회` 버튼은 생성된 전체 키워드를 50개씩 나눠 조회합니다.

`/keyword-volume` 페이지는 키워드를 직접 입력해서 검색량만 따로 조회하는 보조 화면입니다.

### Vercel 환경변수

Vercel 배포 환경에서는 아래 값을 Project Settings > Environment Variables에 등록합니다.

```env
NEXT_PUBLIC_KAKAO_MAP_APP_KEY=
NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET_KEY=
NAVER_SEARCHAD_CUSTOMER_ID=
NAVER_SEARCHAD_BASE_URL=https://api.searchad.naver.com
```

네이버 secret key에는 절대 `NEXT_PUBLIC_` prefix를 붙이지 않습니다. `NEXT_PUBLIC_`가 붙은 값은 프론트엔드 번들에 노출될 수 있습니다.

### 배포 후 테스트 순서

1. `/`에서 지도와 반경 원이 표시되는지 확인합니다.
2. 주소 검색과 지도 클릭으로 중심 좌표가 바뀌는지 확인합니다.
3. 기본 키워드를 입력하고 생성 키워드 탭에 결과가 나오는지 확인합니다.
4. 생성 키워드에서 일부 키워드를 선택하고 선택 개수가 표시되는지 확인합니다.
5. 선택/전체 키워드 복사가 동작하는지 확인합니다.
6. `선택 키워드 검색량 조회` 또는 `전체 키워드 검색량 조회`를 눌러 현재 테이블에 전체검색, PC검색, 모바일검색 값이 표시되는지 확인합니다.
7. `/keyword-volume`에서 키워드를 직접 입력해 별도 검색량 조회가 되는지 확인합니다.
8. 50개 초과 키워드 입력 시 `/keyword-volume`에서 제한 안내가 표시되는지 확인합니다.
9. `keyword_volume_results.csv`를 다운로드해 엑셀에서 한글이 깨지지 않는지 확인합니다.

## 확인 방법

1. 배포 페이지 또는 로컬 서버에서 지도가 표시되는지 확인합니다.
2. 주소 검색에 `마두동`을 입력하고 검색합니다.
3. 반경을 `10km`, `20km`, `30km` 중 하나로 바꿔 결과 변화를 확인합니다.
4. 기본 키워드에 `임플란트, 치과`를 입력합니다.
5. 전철역, 동/읍/면, 생성 키워드 탭에 결과가 표시되는지 확인합니다.
6. 생성 키워드 탭에서 `마두역치과`, `마두치과`, `마두동치과` 같은 키워드가 생성되는지 확인합니다.
7. CSV 다운로드 탭에서 3개 CSV 파일을 내려받아 한글이 정상 표시되는지 확인합니다.

## 라이선스

MIT License
