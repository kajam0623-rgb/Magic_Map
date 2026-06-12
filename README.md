# Magic Map

한국 지도에서 중심 지점과 1km~10km 반경을 선택하고, CSV 기준 전철역과 GeoJSON 기준 행정구역을 기본 키워드와 조합한 뒤 결과를 복사하거나 CSV로 내려받는 지역 SEO 키워드 생성 웹앱의 5단계 구현입니다.

## 현재 기능

- 카카오맵 표시
- 카카오 앱 키가 없을 때 OpenStreetMap 자동 fallback 표시
- 주소 검색으로 중심 좌표 선택
- 지도 클릭으로 중심 좌표 선택
- 1km~10km 반경 선택
- 선택 지점 마커 표시
- 선택 반경 원 표시
- `public/data/stations.csv` 로딩
- 선택 중심점과 각 역 사이 거리 계산
- 반경 안 전철역만 거리 오름차순으로 표시
- 결과 테이블에 역명, 노선, 거리, 위도, 경도, 출처 표시
- `public/data/eupmyeondong.geojson` 로딩
- Turf.js buffer로 반경 원 polygon 생성
- 반경 원 polygon과 행정구역 polygon이 교차하는 경우만 표시
- 행정구역 결과 테이블에 원본명, 유형, 시도, 시군구, 거리, 포함 기준, 출처 표시
- 쉼표와 줄바꿈으로 여러 기본 키워드 입력
- 반경 안 전철역과 동·읍·면을 기본 키워드와 조합
- suffix 포함 결과와 suffix 제거 결과를 모두 생성
- 중복 키워드는 병합하고 `sourceItems`에 원본 출처를 모두 보존
- 결과 탭: 전체 요약, 전철역, 동/읍/면, 생성 키워드, CSV 다운로드
- 키워드 전체 복사와 선택 키워드 복사
- 중복 병합 ON/OFF 토글
- suffix 포함/제거 필터
- 전철역/동/읍/면 필터
- UTF-8 BOM이 포함된 CSV 다운로드

행정구역 포함 여부는 centroid 기준이 아니라 `polygon_intersects` 기준입니다. 행정구역 거리값은 polygon centroid와 중심점 사이의 참고값으로만 표시합니다.

suffix 제거는 문자열 끝에 있을 때만 적용합니다. 이름 중간 글자는 제거하지 않습니다.

## 키워드 생성 규칙 예시

```txt
마두역 + 치과 -> 마두역치과, 마두치과
마두동 + 치과 -> 마두동치과, 마두치과
조치원읍 + 치과 -> 조치원읍치과, 조치원치과
대화면 + 치과 -> 대화면치과, 대화치과
역삼역 + 치과 -> 역삼역치과, 역삼치과
```

## 역 데이터 CSV

앱은 카카오 Local API가 아니라 아래 파일만 기준으로 역 목록을 계산합니다.

```txt
public/data/stations.csv
```

필수 컬럼은 다음 순서와 이름을 기준으로 처리합니다.

```csv
id,station_name,line_name,station_type,lat,lng,source
```

현재 파일은 레일포털의 `전체_도시철도역사정보_20260228` XLSX를 변환한 전국 도시철도/광역철도 역사 데이터입니다. 환승역처럼 원본에 노선별로 중복된 행은 역사명과 도로명주소 기준으로 묶고, 노선명은 `line_name`에 합쳤습니다.

## 행정구역 GeoJSON

앱은 아래 파일을 읽어 반경 원과 행정구역 경계 교차 여부를 계산합니다.

```txt
public/data/eupmyeondong.geojson
```

속성은 아래 값을 사용합니다.

```txt
original_name, type, sido, sigungu, source
```

현재 파일은 `admdongkor`의 최신 `20260401` 전국 행정동 경계 3,558개를 변환한 GeoJSON입니다.

## 전국 데이터 재생성

아래 명령으로 `public/data/stations.csv`와 `public/data/eupmyeondong.geojson`을 다시 생성할 수 있습니다.

```bash
node scripts/build-national-data.mjs
```

전철역 원본 XLSX가 `tmp/kric_stations.xlsx`에 없으면 레일포털에서 자동 다운로드합니다. `tmp` 폴더는 생성용 캐시이며 저장소에는 포함하지 않습니다.

## 다운로드 파일

```txt
stations_result.csv
admin_areas_result.csv
keyword_results.csv
```

CSV는 UTF-8 BOM을 포함해 엑셀에서 한글이 깨지지 않도록 생성합니다.

## 지도 키 설정

카카오 개발자 콘솔에서 JavaScript 앱 키를 발급받으면 카카오맵으로 실행할 수 있습니다. 키가 없으면 앱은 OpenStreetMap/Leaflet 지도로 자동 전환됩니다.

카카오맵을 사용할 때만 Web 플랫폼에 로컬 도메인을 등록합니다.

```txt
http://localhost:3000
```

프로젝트 루트에 `.env.local` 파일을 만들고 아래 값을 입력합니다.

```env
NEXT_PUBLIC_KAKAO_MAP_APP_KEY=카카오_JavaScript_앱_키
```

키가 없으면 `.env.local`을 만들지 않아도 됩니다. 이 경우 지도 클릭, 마커, 반경 원, 주소 검색은 OpenStreetMap 기준으로 동작합니다.

## 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000`을 열어 확인합니다.

## 확인 방법

1. 지도가 표시되는지 확인합니다. 카카오 키가 없으면 OpenStreetMap 지도가 표시됩니다.
2. 주소 검색에 `서울특별시 중구 세종대로 110`을 입력하고 검색합니다.
3. 마커와 원이 검색 위치로 이동하는지 확인합니다.
4. 지도 위 다른 지점을 클릭해 마커와 원이 이동하는지 확인합니다.
5. 반경 슬라이더 또는 1~10 버튼을 눌러 원 크기가 바뀌는지 확인합니다.
6. 결과 테이블의 역 목록이 반경 변경에 따라 바뀌고, 거리 오름차순으로 표시되는지 확인합니다.
7. 행정구역 테이블에 `polygon_intersects` 기준 결과가 표시되는지 확인합니다.
8. 화면에 `행정구역은 경계 교차 기준, 거리는 중심점 참고값입니다.` 문구가 보이는지 확인합니다.
9. 기본 키워드에 `치과, 임플란트`처럼 입력하고 생성 키워드 테이블을 확인합니다.
10. 같은 키워드가 여러 원본에서 나오면 한 행으로 병합되고 `sourceItems`가 여러 개 표시되는지 확인합니다.
11. 생성 키워드 탭에서 중복 병합, suffix 필터, 전철역/동/읍/면 필터를 바꿔 결과가 변하는지 확인합니다.
12. 키워드 전체 복사와 선택 키워드 복사를 확인합니다.
13. CSV 다운로드 탭에서 3개 CSV 파일을 내려받아 엑셀에서 한글이 깨지지 않는지 확인합니다.
