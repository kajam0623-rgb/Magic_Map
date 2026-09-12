"use client";

import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import { point } from "@turf/helpers";
import type { Feature, FeatureCollection, GeoJsonProperties, MultiPolygon, Polygon } from "geojson";
import type * as Leaflet from "leaflet";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { KeywordVolumeErrorResponse, KeywordVolumeItem, KeywordVolumeResponse } from "@/types/keyword-volume";

type Coordinate = {
  lat: number;
  lng: number;
};

type Station = {
  id: string;
  stationName: string;
  lineName: string;
  stationType: string;
  lat: number;
  lng: number;
  source: string;
};

type StationWithDistance = Station & {
  distanceKm: number;
};

type AdminProperties = GeoJsonProperties & {
  id?: string;
  original_name?: string;
  originalName?: string;
  name?: string;
  adm_nm?: string;
  type?: string;
  admin_type?: string;
  sido?: string;
  sidonm?: string;
  sigungu?: string;
  sggnm?: string;
  source?: string;
};

type AdminFeature = Feature<Polygon | MultiPolygon, AdminProperties>;

type AdminArea = {
  id: string;
  originalName: string;
  type: string;
  sido: string;
  sigungu: string;
  source: string;
  feature: AdminFeature;
  // 데이터 로드 시 한 번만 계산해 두고 반경이 바뀔 때마다 재사용한다.
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  centroidCoord: Coordinate;
};

type AdminAreaWithDistance = AdminArea & {
  distanceKm: number;
  includeRule: "polygon_intersects";
};

type KeywordSourceItem = {
  id: string;
  originalName: string;
  keywordLocationName: string;
  itemType: "station" | "admin_area";
  targetType: "전철역" | "시군구" | "동" | "읍" | "면";
  generationRule: "suffix_included" | "suffix_removed";
  source: string;
};

type GeneratedKeyword = {
  rowId: string;
  keyword: string;
  baseKeyword: string;
  sourceItems: KeywordSourceItem[];
};

type ResultTab = "summary" | "stations" | "adminAreas" | "keywords" | "pagePlan";
type SuffixFilter = "all" | KeywordSourceItem["generationRule"];
type TargetTypeFilter = "all" | KeywordSourceItem["targetType"];
type KeywordSort = "volume" | "opportunity";

type OpenStreetMapSearchResult = {
  display_name?: string;
  lat: string;
  lon: string;
};

const DEFAULT_CENTER: Coordinate = {
  lat: 37.566535,
  lng: 126.9779692,
};

const DEFAULT_RADIUS_KM = 3;
// 서버가 키워드를 5개씩 묶어 네이버에 보내므로 한 요청에 25개까지 담아도 네이버 호출은 5회다.
const KEYWORD_VOLUME_BATCH_SIZE = 25;
const KEYWORD_VOLUME_MAX_PASSES = 4;
const KEYWORD_ROW_RENDER_STEP = 200;
const KEYWORD_VOLUME_PASS_DELAY_MS = 700;
const radiusOptions = [...Array.from({ length: 10 }, (_, index) => index + 1), 20, 30];
const adminSuffixes = ["동", "읍", "면"];
const sigunguSuffixes = ["구", "시", "군"];
const MIN_LOCATION_NAME_LENGTH = 2;
const FIRST_BATCH_PAGE_COUNT = 5;
const resultTabs: { id: ResultTab; label: string }[] = [
  { id: "summary", label: "전체 요약" },
  { id: "stations", label: "전철역" },
  { id: "adminAreas", label: "동/읍/면" },
  { id: "keywords", label: "생성 키워드" },
  { id: "pagePlan", label: "만들 페이지" },
];

function formatCoordinate(value: number) {
  return value.toFixed(6);
}

function formatDistance(distanceKm: number) {
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)}m`;
  }

  return `${distanceKm.toFixed(2)}km`;
}

function parseBaseKeywords(input: string) {
  return Array.from(
    new Set(
      input
        .split(/[,\n]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
}

function withStationSuffix(stationName: string) {
  return stationName.endsWith("역") ? stationName : `${stationName}역`;
}

// 괄호 안 부역명(강변(동서울터미널))은 별도 검색어라 본역명만 남긴다.
function normalizeStationName(stationName: string) {
  return stationName.replace(/\s*[（(].*$/, "").trim();
}

// 행정동 번호(범어1동, 수성2·3가동)로는 아무도 검색하지 않는다.
// 번호를 떼어 법정동 형태(범어동, 수성동)로 되돌린다.
function normalizeAdminName(name: string) {
  const matchedSuffix = adminSuffixes.find((suffix) => name.endsWith(suffix));

  if (!matchedSuffix) {
    return name;
  }

  const stem = name
    .slice(0, -matchedSuffix.length)
    .replace(/[0-9·.]+가?$/, "")
    .replace(/[0-9·.]+$/, "");

  return stem.length > 0 ? `${stem}${matchedSuffix}` : name;
}

function removeTrailingSuffix(name: string, suffixes: string[]) {
  const matchedSuffix = suffixes.find((suffix) => name.endsWith(suffix));

  if (!matchedSuffix || name.length <= matchedSuffix.length) {
    return name;
  }

  return name.slice(0, -matchedSuffix.length);
}

function keywordLocationVariants(nameWithSuffix: string, suffixes: string[]) {
  const bareName = removeTrailingSuffix(nameWithSuffix, suffixes);

  return Array.from(
    new Set(
      [
        { name: nameWithSuffix, rule: "suffix_included" as const },
        { name: bareName, rule: "suffix_removed" as const },
      ]
        // 상동 -> 상, 중동 -> 중처럼 한 글자만 남으면 지명 구실을 못 한다.
        .filter((variant) => variant.name.length >= MIN_LOCATION_NAME_LENGTH)
        .map((variant) => `${variant.name}\t${variant.rule}`),
    ),
  ).map((serialized) => {
    const [name, rule] = serialized.split("\t") as [string, KeywordSourceItem["generationRule"]];

    return { name, rule };
  });
}

// 경기도에는 고양시덕양구처럼 시와 구가 한 이름에 붙은 시군구가 서른아홉 개 있다.
// 그대로 두면 "고양시덕양"처럼 아무도 검색하지 않는 말이 나오므로 구와 시로 나눈다.
function sigunguNames(sigungu: string) {
  const compound = sigungu.match(/^(.+?시)(.+구)$/);

  return compound ? [compound[2], compound[1]] : [sigungu];
}

function isTargetAdminArea(area: AdminAreaWithDistance) {
  return adminSuffixes.includes(area.type) || adminSuffixes.some((suffix) => area.originalName.endsWith(suffix));
}

function adminTargetType(area: AdminAreaWithDistance): KeywordSourceItem["targetType"] {
  const suffix = adminSuffixes.find((candidate) => area.type === candidate || area.originalName.endsWith(candidate));

  return (suffix ?? "동") as KeywordSourceItem["targetType"];
}

function sourceItemKey(sourceItem: KeywordSourceItem) {
  return [
    sourceItem.itemType,
    sourceItem.id,
    sourceItem.keywordLocationName,
    sourceItem.targetType,
    sourceItem.generationRule,
  ].join(":");
}

function addGeneratedKeyword(
  keywords: Map<string, GeneratedKeyword>,
  rows: GeneratedKeyword[],
  mergeDuplicates: boolean,
  keyword: string,
  baseKeyword: string,
  sourceItem: KeywordSourceItem,
) {
  if (!mergeDuplicates) {
    rows.push({
      rowId: `${keyword}:${sourceItemKey(sourceItem)}:${rows.length}`,
      keyword,
      baseKeyword,
      sourceItems: [sourceItem],
    });
    return;
  }

  const current = keywords.get(keyword);

  if (current) {
    const sourceKey = sourceItemKey(sourceItem);
    const hasSource = current.sourceItems.some((item) => sourceItemKey(item) === sourceKey);

    if (!hasSource) {
      current.sourceItems.push(sourceItem);
    }

    return;
  }

  keywords.set(keyword, {
    rowId: keyword,
    keyword,
    baseKeyword,
    sourceItems: [sourceItem],
  });
}

function generateSeoKeywords(
  baseKeywords: string[],
  stations: StationWithDistance[],
  adminAreas: AdminAreaWithDistance[],
  mergeDuplicates: boolean,
) {
  const keywordMap = new Map<string, GeneratedKeyword>();
  const keywordRows: GeneratedKeyword[] = [];

  const sigunguAreas = new Map<string, AdminAreaWithDistance>();

  for (const area of adminAreas) {
    if (area.sigungu && !sigunguAreas.has(area.sigungu)) {
      sigunguAreas.set(area.sigungu, area);
    }
  }

  for (const baseKeyword of baseKeywords) {
    for (const station of stations) {
      const stationNameWithSuffix = withStationSuffix(normalizeStationName(station.stationName));
      const variants = keywordLocationVariants(stationNameWithSuffix, ["역"]);

      for (const variant of variants) {
        addGeneratedKeyword(keywordMap, keywordRows, mergeDuplicates, `${variant.name}${baseKeyword}`, baseKeyword, {
          id: station.id,
          originalName: station.stationName,
          keywordLocationName: variant.name,
          itemType: "station",
          targetType: "전철역",
          generationRule: variant.rule,
          source: station.source,
        });
      }
    }

    // 수성구치과, 강남치과처럼 시군구 단위 키워드가 동 단위보다 검색량이 큰 경우가 많다.
    for (const [sigungu, area] of sigunguAreas) {
      const variants = sigunguNames(sigungu).flatMap((name) => keywordLocationVariants(name, sigunguSuffixes));

      for (const variant of variants) {
        addGeneratedKeyword(keywordMap, keywordRows, mergeDuplicates, `${variant.name}${baseKeyword}`, baseKeyword, {
          id: `sigungu:${sigungu}`,
          originalName: sigungu,
          keywordLocationName: variant.name,
          itemType: "admin_area",
          targetType: "시군구",
          generationRule: variant.rule,
          source: area.source,
        });
      }
    }

    for (const area of adminAreas.filter(isTargetAdminArea)) {
      const normalizedName = normalizeAdminName(area.originalName);
      const variants = keywordLocationVariants(normalizedName, adminSuffixes);

      for (const variant of variants) {
        addGeneratedKeyword(keywordMap, keywordRows, mergeDuplicates, `${variant.name}${baseKeyword}`, baseKeyword, {
          id: area.id,
          originalName: area.originalName,
          keywordLocationName: variant.name,
          itemType: "admin_area",
          targetType: adminTargetType(area),
          generationRule: variant.rule,
          source: area.source,
        });
      }
    }
  }

  const rows = mergeDuplicates ? Array.from(keywordMap.values()) : keywordRows;

  return rows.sort((left, right) => left.keyword.localeCompare(right.keyword, "ko-KR"));
}

function sourceMatchesFilters(sourceItem: KeywordSourceItem, suffixFilter: SuffixFilter, targetTypeFilter: TargetTypeFilter) {
  const suffixMatched = suffixFilter === "all" || sourceItem.generationRule === suffixFilter;
  const targetMatched = targetTypeFilter === "all" || sourceItem.targetType === targetTypeFilter;

  return suffixMatched && targetMatched;
}

function filterGeneratedKeywords(
  keywords: GeneratedKeyword[],
  suffixFilter: SuffixFilter,
  targetTypeFilter: TargetTypeFilter,
) {
  return keywords
    .map((keyword) => ({
      ...keyword,
      sourceItems: keyword.sourceItems.filter((sourceItem) =>
        sourceMatchesFilters(sourceItem, suffixFilter, targetTypeFilter),
      ),
    }))
    .filter((keyword) => keyword.sourceItems.length > 0);
}

function excelEscape(value: string | number) {
  const text = String(value);

  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let isQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && isQuoted && nextChar === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      isQuoted = !isQuoted;
    } else if (char === "," && !isQuoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function parseStationsCsv(csvText: string) {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const columnIndex = new Map(headers.map((header, index) => [header, index]));
  const requiredColumns = ["id", "station_name", "line_name", "station_type", "lat", "lng", "source"];
  const hasRequiredColumns = requiredColumns.every((column) => columnIndex.has(column));

  if (!hasRequiredColumns) {
    throw new Error("stations.csv 컬럼은 id, station_name, line_name, station_type, lat, lng, source 기준이어야 합니다.");
  }

  return lines
    .slice(1)
    .map((line) => {
      const row = parseCsvLine(line);
      const lat = Number(row[columnIndex.get("lat") ?? -1]);
      const lng = Number(row[columnIndex.get("lng") ?? -1]);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      return {
        id: row[columnIndex.get("id") ?? -1] ?? "",
        stationName: row[columnIndex.get("station_name") ?? -1] ?? "",
        lineName: row[columnIndex.get("line_name") ?? -1] ?? "",
        stationType: row[columnIndex.get("station_type") ?? -1] ?? "",
        lat,
        lng,
        source: row[columnIndex.get("source") ?? -1] ?? "",
      };
    })
    .filter((station): station is Station => station !== null && station.id !== "" && station.stationName !== "");
}

function textValue(value: unknown, fallback = "-") {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

function isPolygonFeature(feature: Feature): feature is AdminFeature {
  return feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
}

function parseAdminGeoJson(geoJson: unknown) {
  const collection = geoJson as FeatureCollection;

  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("eupmyeondong.geojson은 FeatureCollection 형식이어야 합니다.");
  }

  return collection.features.filter(isPolygonFeature).map((feature, index) => {
    const properties = feature.properties ?? {};
    const [minLng, minLat, maxLng, maxLat] = bbox(feature);
    const [centroidLng, centroidLat] = centroid(feature).geometry.coordinates;

    return {
      id: textValue(properties.id, `admin-${index + 1}`),
      originalName: textValue(
        properties.original_name ?? properties.originalName ?? properties.name ?? properties.adm_nm,
      ),
      type: textValue(properties.type ?? properties.admin_type),
      sido: textValue(properties.sido ?? properties.sidonm),
      sigungu: textValue(properties.sigungu ?? properties.sggnm),
      source: textValue(properties.source),
      feature,
      bounds: { minLng, minLat, maxLng, maxLat },
      centroidCoord: { lat: centroidLat, lng: centroidLng },
    };
  });
}

// 반경 원이 지도에 여유 있게 들어가는 배율을 구한다. fitBounds는 컨테이너 크기가
// 확정되기 전에 불리면 원을 한쪽으로 밀어버려서 직접 계산한다.
function zoomForRadius(radiusKm: number, latitude: number, viewportPx: number) {
  const usablePx = Math.max(viewportPx * 0.82, 120);
  const metersPerPixel = (radiusKm * 2000) / usablePx;
  const equatorMetersPerPixel = 156543.03392 * Math.cos((latitude * Math.PI) / 180);
  const zoom = Math.log2(equatorMetersPerPixel / metersPerPixel);

  // 내림이라 원이 화면을 넘치는 일은 없다.
  return Math.max(3, Math.min(18, Math.floor(zoom)));
}

// 검색량 단계별 색. 지형도 수심 단계처럼 옅은 청록에서 짙은 청록으로 간다.
const heatColors = ["#dcebea", "#a9d2d2", "#6fb3b6", "#3a9199", "#0d7a82"];

// 검색량은 몇몇 동에 크게 몰려서 최댓값 대비로 나누면 대부분 같은 색이 된다.
// 순위로 끊어야 다섯 단계가 고르게 쓰인다.
function heatColorFor(value: number, sortedValues: number[]) {
  if (sortedValues.length === 0) {
    return heatColors[0];
  }

  const rank = sortedValues.filter((candidate) => candidate < value).length / sortedValues.length;
  const index = Math.min(heatColors.length - 1, Math.floor(rank * heatColors.length));

  return heatColors[index];
}

function distanceBetweenKm(origin: Coordinate, target: Coordinate) {
  const earthRadiusKm = 6371.0088;
  const latDistance = ((target.lat - origin.lat) * Math.PI) / 180;
  const lngDistance = ((target.lng - origin.lng) * Math.PI) / 180;
  const originLat = (origin.lat * Math.PI) / 180;
  const targetLat = (target.lat * Math.PI) / 180;

  const haversine =
    Math.sin(latDistance / 2) ** 2 +
    Math.cos(originLat) * Math.cos(targetLat) * Math.sin(lngDistance / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function scriptSource(appKey: string) {
  const params = new URLSearchParams({
    appkey: appKey,
    autoload: "false",
    libraries: "services",
  });

  return `https://dapi.kakao.com/v2/maps/sdk.js?${params.toString()}`;
}

export function MagicMap() {
  const appKey = process.env.NEXT_PUBLIC_KAKAO_MAP_APP_KEY;
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const markerRef = useRef<kakao.maps.Marker | null>(null);
  const circleRef = useRef<kakao.maps.Circle | null>(null);
  const geocoderRef = useRef<kakao.maps.services.Geocoder | null>(null);
  const leafletMapRef = useRef<Leaflet.Map | null>(null);
  const shouldFitRadiusRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const previousRadiusKmRef = useRef(DEFAULT_RADIUS_KM);
  const leafletMarkerRef = useRef<Leaflet.Marker | null>(null);
  const leafletCircleRef = useRef<Leaflet.Circle | null>(null);
  const leafletHeatLayerRef = useRef<Leaflet.GeoJSON | null>(null);

  const [isSdkReady, setIsSdkReady] = useState(false);
  const [isLeafletReady, setIsLeafletReady] = useState(false);
  const [kakaoLoadError, setKakaoLoadError] = useState("");
  const [leafletLoadError, setLeafletLoadError] = useState("");
  const [address, setAddress] = useState("");
  const [baseKeywordInput, setBaseKeywordInput] = useState("");
  const [activeTab, setActiveTab] = useState<ResultTab>("summary");
  const [mergeDuplicates, setMergeDuplicates] = useState(true);
  const [suffixFilter, setSuffixFilter] = useState<SuffixFilter>("all");
  const [targetTypeFilter, setTargetTypeFilter] = useState<TargetTypeFilter>("all");
  const [keywordSort, setKeywordSort] = useState<KeywordSort>("volume");
  const [showAllPagePlans, setShowAllPagePlans] = useState(false);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState("");
  const [keywordVolumeStatus, setKeywordVolumeStatus] = useState("");
  const [isKeywordVolumeLoading, setIsKeywordVolumeLoading] = useState(false);
  const [keywordVolumeByKeyword, setKeywordVolumeByKeyword] = useState<Record<string, KeywordVolumeItem>>({});
  const [keywordVolumeFailedKeywords, setKeywordVolumeFailedKeywords] = useState<string[]>([]);
  const [searchStatus, setSearchStatus] = useState("");
  const [center, setCenter] = useState<Coordinate>(DEFAULT_CENTER);
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [stations, setStations] = useState<Station[]>([]);
  const [stationLoadStatus, setStationLoadStatus] = useState("stations.csv를 불러오는 중입니다.");
  const [adminAreas, setAdminAreas] = useState<AdminArea[]>([]);
  const [adminLoadStatus, setAdminLoadStatus] = useState("eupmyeondong.geojson을 불러오는 중입니다.");
  const [visibleKeywordRowCount, setVisibleKeywordRowCount] = useState(KEYWORD_ROW_RENDER_STEP);

  const selectedLabel = useMemo(
    () => `${formatCoordinate(center.lat)}, ${formatCoordinate(center.lng)}`,
    [center],
  );
  const shouldUseLeaflet = !appKey || Boolean(kakaoLoadError);
  const activeMapLoadError = shouldUseLeaflet ? leafletLoadError : kakaoLoadError;
  const isMapReady = shouldUseLeaflet ? isLeafletReady : isSdkReady;
  const mapOverlayMessage =
    activeMapLoadError || (shouldUseLeaflet ? "OpenStreetMap 지도를 불러오는 중입니다." : "카카오맵을 불러오는 중입니다.");
  const mapOverlayDescription = shouldUseLeaflet
    ? "카카오 앱 키가 없거나 카카오맵을 불러오지 못해 키 없는 지도로 자동 전환했습니다."
    : "앱 키와 카카오 개발자 콘솔의 Web 플랫폼 도메인을 확인해 주세요.";
  const nearbyStations = useMemo<StationWithDistance[]>(() => {
    return stations
      .map((station) => ({
        ...station,
        distanceKm: distanceBetweenKm(center, station),
      }))
      .filter((station) => station.distanceKm <= radiusKm)
      .sort((left, right) => left.distanceKm - right.distanceKm);
  }, [center, radiusKm, stations]);
  const baseKeywords = useMemo(() => parseBaseKeywords(baseKeywordInput), [baseKeywordInput]);
  const intersectingAdminAreas = useMemo<AdminAreaWithDistance[]>(() => {
    const centerPoint = point([center.lng, center.lat]);
    const radiusPolygon = buffer(centerPoint, radiusKm, { units: "kilometers", steps: 64 });

    if (!radiusPolygon) {
      return [];
    }

    // 전국 3,500여 개 폴리곤을 매번 전수 판정하면 반경을 바꿀 때마다 화면이 멈춘다.
    // 값싼 bounding box 겹침 검사로 후보를 먼저 걸러내고, 남은 것만 폴리곤 교차를 본다.
    const latDelta = radiusKm / 111.32;
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    const lngDelta = radiusKm / (111.32 * Math.max(Math.abs(cosLat), 0.01));
    const searchMinLat = center.lat - latDelta;
    const searchMaxLat = center.lat + latDelta;
    const searchMinLng = center.lng - lngDelta;
    const searchMaxLng = center.lng + lngDelta;

    return adminAreas
      .filter((area) => {
        const { minLng, minLat, maxLng, maxLat } = area.bounds;

        if (maxLat < searchMinLat || minLat > searchMaxLat || maxLng < searchMinLng || minLng > searchMaxLng) {
          return false;
        }

        return booleanIntersects(radiusPolygon, area.feature);
      })
      .map((area) => ({
        ...area,
        distanceKm: distanceBetweenKm(center, area.centroidCoord),
        includeRule: "polygon_intersects" as const,
      }))
      .sort((left, right) => left.distanceKm - right.distanceKm);
  }, [adminAreas, center, radiusKm]);
  const generatedKeywords = useMemo(
    () => generateSeoKeywords(baseKeywords, nearbyStations, intersectingAdminAreas, mergeDuplicates),
    [baseKeywords, intersectingAdminAreas, mergeDuplicates, nearbyStations],
  );
  const filteredGeneratedKeywords = useMemo(
    () => filterGeneratedKeywords(generatedKeywords, suffixFilter, targetTypeFilter),
    [generatedKeywords, suffixFilter, targetTypeFilter],
  );
  const displayedGeneratedKeywords = useMemo(() => {
    return [...filteredGeneratedKeywords].sort((left, right) => {
      const leftVolume = keywordVolumeByKeyword[left.keyword];
      const rightVolume = keywordVolumeByKeyword[right.keyword];

      if (leftVolume && rightVolume) {
        if (keywordSort === "opportunity") {
          const leftScore = leftVolume.opportunityScore ?? -1;
          const rightScore = rightVolume.opportunityScore ?? -1;

          if (rightScore !== leftScore) {
            return rightScore - leftScore;
          }
        }

        if (rightVolume.totalCount !== leftVolume.totalCount) {
          return rightVolume.totalCount - leftVolume.totalCount;
        }

        if (rightVolume.mobileRatio !== leftVolume.mobileRatio) {
          return rightVolume.mobileRatio - leftVolume.mobileRatio;
        }

        return left.keyword.localeCompare(right.keyword, "ko-KR");
      }

      if (leftVolume) {
        return -1;
      }

      if (rightVolume) {
        return 1;
      }

      return left.keyword.localeCompare(right.keyword, "ko-KR");
    });
  }, [filteredGeneratedKeywords, keywordVolumeByKeyword, keywordSort]);
  // 30km 반경이면 1,400행이 넘어 DOM이 폭발한다. 화면에는 일부만 그리고,
  // 선택/복사/엑셀은 아래처럼 필터된 전체를 그대로 대상으로 둔다.
  const renderedGeneratedKeywords = useMemo(
    () => displayedGeneratedKeywords.slice(0, visibleKeywordRowCount),
    [displayedGeneratedKeywords, visibleKeywordRowCount],
  );
  const hiddenKeywordRowCount = displayedGeneratedKeywords.length - renderedGeneratedKeywords.length;
  // 조회한 검색량을 그 키워드를 만들어 낸 행정구역으로 되돌려 합산한다.
  const volumeByAdminAreaId = useMemo(() => {
    const totals = new Map<string, number>();

    for (const generatedKeyword of generatedKeywords) {
      const volume = keywordVolumeByKeyword[generatedKeyword.keyword];

      if (!volume) {
        continue;
      }

      for (const sourceItem of generatedKeyword.sourceItems) {
        if (sourceItem.itemType !== "admin_area") {
          continue;
        }

        totals.set(sourceItem.id, (totals.get(sourceItem.id) ?? 0) + volume.totalCount);
      }
    }

    return totals;
  }, [generatedKeywords, keywordVolumeByKeyword]);

  // 키워드 하나에 페이지 하나를 만들 수는 없다. 같은 지명을 노리는 키워드는
  // 한 페이지가 같이 먹으므로 지명 단위로 묶어서 "만들 페이지"로 내놓는다.
  const pagePlans = useMemo(() => {
    const groups = new Map<
      string,
      { locationName: string; targetType: string; keywords: { keyword: string; totalCount: number; opportunityScore?: number }[] }
    >();

    for (const generatedKeyword of filteredGeneratedKeywords) {
      const volume = keywordVolumeByKeyword[generatedKeyword.keyword];
      const sourceItem = generatedKeyword.sourceItems[0];

      if (!sourceItem) {
        continue;
      }

      const key = sourceItem.keywordLocationName;
      const group = groups.get(key) ?? {
        locationName: key,
        targetType: sourceItem.targetType,
        keywords: [],
      };

      group.keywords.push({
        keyword: generatedKeyword.keyword,
        totalCount: volume?.totalCount ?? 0,
        opportunityScore: volume?.opportunityScore,
      });
      groups.set(key, group);
    }

    return Array.from(groups.values())
      .map((group) => {
        const keywords = [...group.keywords].sort((left, right) => right.totalCount - left.totalCount);
        const scores = keywords.map((item) => item.opportunityScore).filter((score): score is number => score !== undefined);

        return {
          ...group,
          keywords,
          totalVolume: keywords.reduce((sum, item) => sum + item.totalCount, 0),
          bestScore: scores.length > 0 ? Math.max(...scores) : undefined,
        };
      })
      .sort((left, right) => right.totalVolume - left.totalVolume);
  }, [filteredGeneratedKeywords, keywordVolumeByKeyword]);

  // 한 번에 손댈 수 있는 분량은 정해져 있다. 상위 다섯 개를 먼저 만들고
  // 그것이 검색량의 몇 퍼센트를 덮는지 같이 보여준다.
  const pagePlanPriority = useMemo(() => {
    const totalVolume = pagePlans.reduce((sum, plan) => sum + plan.totalVolume, 0);
    const firstBatchCount = Math.min(FIRST_BATCH_PAGE_COUNT, pagePlans.length);
    const coveredVolume = pagePlans
      .slice(0, firstBatchCount)
      .reduce((sum, plan) => sum + plan.totalVolume, 0);
    const coverageRatio = totalVolume > 0 ? Math.round((coveredVolume / totalVolume) * 100) : 0;

    return { firstBatchCount, totalVolume, coveredVolume, coverageRatio };
  }, [pagePlans]);

  const selectedKeywordRows = useMemo(
    () => displayedGeneratedKeywords.filter((keyword) => selectedKeywordIds.includes(keyword.rowId)),
    [displayedGeneratedKeywords, selectedKeywordIds],
  );
  const keywordVolumeResultCount = Object.keys(keywordVolumeByKeyword).length;
  const keywordVolumeFailedSet = useMemo(() => new Set(keywordVolumeFailedKeywords), [keywordVolumeFailedKeywords]);
  const radiusSliderIndex = Math.max(0, radiusOptions.indexOf(radiusKm));
  const radiusStats = [
    { label: "전철역", value: nearbyStations.length },
    { label: "동·읍·면", value: intersectingAdminAreas.length },
    { label: "생성 키워드", value: generatedKeywords.length },
  ];

  useEffect(() => {
    let isCanceled = false;

    async function loadStations() {
      try {
        const response = await fetch("/data/stations.csv", { cache: "no-store" });

        if (!response.ok) {
          throw new Error("public/data/stations.csv 파일을 찾지 못했습니다.");
        }

        const csvText = await response.text();
        const parsedStations = parseStationsCsv(csvText);

        if (!isCanceled) {
          setStations(parsedStations);
          setStationLoadStatus(`${parsedStations.length.toLocaleString("ko-KR")}개 역 데이터를 불러왔습니다.`);
        }
      } catch (error) {
        if (!isCanceled) {
          setStations([]);
          setStationLoadStatus(error instanceof Error ? error.message : "역 데이터를 불러오지 못했습니다.");
        }
      }
    }

    void loadStations();

    return () => {
      isCanceled = true;
    };
  }, []);

  useEffect(() => {
    let isCanceled = false;

    async function loadAdminAreas() {
      try {
        const response = await fetch("/data/eupmyeondong.geojson", { cache: "no-store" });

        if (!response.ok) {
          throw new Error("public/data/eupmyeondong.geojson 파일을 찾지 못했습니다.");
        }

        const parsedAdminAreas = parseAdminGeoJson(await response.json());

        if (!isCanceled) {
          setAdminAreas(parsedAdminAreas);
          setAdminLoadStatus(`${parsedAdminAreas.length.toLocaleString("ko-KR")}개 행정구역을 불러왔습니다.`);
        }
      } catch (error) {
        if (!isCanceled) {
          setAdminAreas([]);
          setAdminLoadStatus(error instanceof Error ? error.message : "행정구역 데이터를 불러오지 못했습니다.");
        }
      }
    }

    void loadAdminAreas();

    return () => {
      isCanceled = true;
    };
  }, []);

  useEffect(() => {
    if (!appKey) {
      return;
    }

    if (window.kakao?.maps) {
      window.kakao.maps.load(() => setIsSdkReady(true));
      return;
    }

    const existingScript = document.getElementById("kakao-map-sdk") as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", () => {
        window.kakao?.maps.load(() => setIsSdkReady(true));
      });
      return;
    }

    const script = document.createElement("script");
    script.id = "kakao-map-sdk";
    script.src = scriptSource(appKey);
    script.async = true;
    script.onload = () => {
      window.kakao?.maps.load(() => setIsSdkReady(true));
    };
    script.onerror = () => {
      setKakaoLoadError("카카오맵 SDK를 불러오지 못했습니다. OpenStreetMap 지도로 전환합니다.");
    };
    document.head.appendChild(script);
  }, [appKey]);

  useEffect(() => {
    if (!shouldUseLeaflet || !mapContainerRef.current || leafletMapRef.current) {
      return;
    }

    let isCanceled = false;
    let resizeObserver: ResizeObserver | null = null;
    const invalidateTimers: number[] = [];

    async function initializeLeafletMap() {
      try {
        const leaflet = await import("leaflet");

        if (isCanceled || !mapContainerRef.current) {
          return;
        }

        const initialPosition: Leaflet.LatLngExpression = [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng];
        const map = leaflet.map(mapContainerRef.current, {
          center: initialPosition,
          zoom: 12,
          zoomControl: false,
        });
        // 통계 카드가 왼쪽 위를 쓰므로 줌은 반대편으로 보낸다.
        leaflet.control.zoom({ position: "topright" }).addTo(map);
        const markerIcon = leaflet.divIcon({
          className: "magic-map-marker",
          html: "<span></span>",
          iconAnchor: [12, 12],
          iconSize: [24, 24],
        });
        const marker = leaflet.marker(initialPosition, { icon: markerIcon }).addTo(map);
        const circle = leaflet
          .circle(initialPosition, {
            radius: DEFAULT_RADIUS_KM * 1000,
            color: "#0d7a82",
            fillColor: "#5eb3b8",
            fillOpacity: 0.18,
            opacity: 0.9,
            weight: 2,
          })
          .addTo(map);

        leaflet
          .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            detectRetina: true,
            maxZoom: 19,
          })
          .addTo(map);

        map.on("click", (event: Leaflet.LeafletMouseEvent) => {
          setCenter({
            lat: event.latlng.lat,
            lng: event.latlng.lng,
          });
          setSearchStatus("지도에서 중심 좌표를 선택했습니다.");
        });

        leafletMapRef.current = map;
        leafletMarkerRef.current = marker;
        leafletCircleRef.current = circle;
        setIsLeafletReady(true);
        resizeObserver = new ResizeObserver(() => {
          map.invalidateSize();
        });
        resizeObserver.observe(mapContainerRef.current);

        for (const delay of [0, 100, 400, 1000]) {
          invalidateTimers.push(window.setTimeout(() => map.invalidateSize(), delay));
        }
      } catch {
        setLeafletLoadError("OpenStreetMap 지도를 불러오지 못했습니다.");
      }
    }

    void initializeLeafletMap();

    return () => {
      isCanceled = true;
      resizeObserver?.disconnect();
      invalidateTimers.forEach((timer) => window.clearTimeout(timer));

      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
      }

      leafletMapRef.current = null;
      leafletMarkerRef.current = null;
      leafletCircleRef.current = null;
      setIsLeafletReady(false);
    };
  }, [shouldUseLeaflet]);

  useEffect(() => {
    if (!isSdkReady || !mapContainerRef.current || mapRef.current || !window.kakao?.maps) {
      return;
    }

    const initialPosition = new window.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng);
    const map = new window.kakao.maps.Map(mapContainerRef.current, {
      center: initialPosition,
      level: 6,
    });
    const marker = new window.kakao.maps.Marker({
      map,
      position: initialPosition,
    });
    const circle = new window.kakao.maps.Circle({
      map,
      center: initialPosition,
      radius: DEFAULT_RADIUS_KM * 1000,
      strokeWeight: 2,
      strokeColor: "#0d7a82",
      strokeOpacity: 0.9,
      strokeStyle: "solid",
      fillColor: "#5eb3b8",
      fillOpacity: 0.18,
    });
    const geocoder = new window.kakao.maps.services.Geocoder();

    const handleMapClick = (event: KakaoMapClickEvent) => {
      const nextCenter = {
        lat: event.latLng.getLat(),
        lng: event.latLng.getLng(),
      };

      setCenter(nextCenter);
      setSearchStatus("지도에서 중심 좌표를 선택했습니다.");
    };

    window.kakao.maps.event.addListener(map, "click", handleMapClick);

    mapRef.current = map;
    markerRef.current = marker;
    circleRef.current = circle;
    geocoderRef.current = geocoder;

    return () => {
      window.kakao?.maps.event.removeListener(map, "click", handleMapClick);
      marker.setMap(null);
      circle.setMap(null);
    };
  }, [isSdkReady]);

  useEffect(() => {
    if (!mapRef.current || !markerRef.current || !circleRef.current || !window.kakao?.maps) {
      return;
    }

    const nextPosition = new window.kakao.maps.LatLng(center.lat, center.lng);
    mapRef.current.setCenter(nextPosition);
    markerRef.current.setPosition(nextPosition);
    circleRef.current.setPosition(nextPosition);
    circleRef.current.setRadius(radiusKm * 1000);
  }, [center, radiusKm]);

  useEffect(() => {
    if (!leafletMapRef.current || !leafletMarkerRef.current || !leafletCircleRef.current) {
      return;
    }

    const nextPosition: Leaflet.LatLngExpression = [center.lat, center.lng];
    leafletMarkerRef.current.setLatLng(nextPosition);
    leafletCircleRef.current.setLatLng(nextPosition);
    leafletCircleRef.current.setRadius(radiusKm * 1000);

    // 주소를 찾았거나 반경을 바꿨다면 그 원을 보려는 것이므로 화면에 맞춘다.
    // 지도를 직접 클릭해 중심만 옮길 때는 사용자가 맞춰 둔 배율을 유지한다.
    const radiusChanged = previousRadiusKmRef.current !== radiusKm;
    previousRadiusKmRef.current = radiusKm;

    if (shouldFitRadiusRef.current || radiusChanged) {
      shouldFitRadiusRef.current = false;

      // 지도가 직접 잰 크기를 써야 배율이 맞는다. 컨테이너를 읽으면 레이아웃이
      // 확정되기 전 값이 잡힌다.
      leafletMapRef.current.invalidateSize({ animate: false });
      const size = leafletMapRef.current.getSize();

      // 배율까지 함께 바꿀 때 Leaflet은 줌 애니메이션을 쓰는데, 그 애니메이션은
      // requestAnimationFrame에 기대고 있어 탭이 뒤에 있으면 끝나지 않는다.
      leafletMapRef.current.setView(nextPosition, zoomForRadius(radiusKm, center.lat, Math.min(size.x, size.y)), {
        animate: false,
      });
      return;
    }

    leafletMapRef.current.setView(nextPosition);
  }, [center, radiusKm]);

  useEffect(() => {
    const map = leafletMapRef.current;

    if (!map) {
      return;
    }

    leafletHeatLayerRef.current?.remove();
    leafletHeatLayerRef.current = null;

    const shaded = intersectingAdminAreas.filter((area) => (volumeByAdminAreaId.get(area.id) ?? 0) > 0);

    if (shaded.length === 0) {
      return;
    }

    const sortedVolumes = shaded.map((area) => volumeByAdminAreaId.get(area.id) ?? 0).sort((a, b) => a - b);
    let isCanceled = false;

    void import("leaflet").then((leaflet) => {
      if (isCanceled || !leafletMapRef.current) {
        return;
      }

      const layer = leaflet.geoJSON(
        { type: "FeatureCollection", features: shaded.map((area) => area.feature) } as never,
        {
          style: (feature) => {
            const id = textValue(feature?.properties?.id);
            const volume = volumeByAdminAreaId.get(id) ?? 0;

            return {
              color: "#ffffff",
              weight: 1,
              fillColor: heatColorFor(volume, sortedVolumes),
              fillOpacity: 0.55,
            };
          },
          onEachFeature: (feature, featureLayer) => {
            const id = textValue(feature?.properties?.id);
            const name = textValue(feature?.properties?.original_name);
            const volume = volumeByAdminAreaId.get(id) ?? 0;

            featureLayer.bindTooltip(`${name} ${volume.toLocaleString("ko-KR")}회`, { sticky: true });
          },
        },
      );

      // 반경 원과 마커가 색면에 가리지 않도록 맨 아래에 깐다.
      layer.addTo(leafletMapRef.current).bringToBack();
      leafletHeatLayerRef.current = layer;
    });

    return () => {
      isCanceled = true;
    };
  }, [intersectingAdminAreas, volumeByAdminAreaId]);

  async function searchOpenStreetMapAddress(trimmedAddress: string) {
    setSearchStatus("OpenStreetMap에서 주소를 검색하는 중입니다.");

    try {
      const params = new URLSearchParams({
        format: "json",
        limit: "1",
        countrycodes: "kr",
        "accept-language": "ko",
        q: trimmedAddress,
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error("주소 검색 요청에 실패했습니다.");
      }

      const results = (await response.json()) as OpenStreetMapSearchResult[];
      const firstResult = results[0];

      if (!firstResult) {
        setSearchStatus("주소를 찾지 못했습니다. 도로명 또는 지번 주소로 다시 검색해 주세요.");
        return;
      }

      const nextCenter = {
        lat: Number(firstResult.lat),
        lng: Number(firstResult.lon),
      };

      shouldFitRadiusRef.current = true;
      setCenter(nextCenter);
      setSearchStatus(`검색 위치를 중심으로 설정했습니다: ${firstResult.display_name ?? trimmedAddress}`);
    } catch (error) {
      setSearchStatus(error instanceof Error ? error.message : "주소를 검색하지 못했습니다.");
    }
  }

  async function handleAddressSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedAddress = address.trim();

    if (!trimmedAddress) {
      setSearchStatus("검색할 주소를 입력해 주세요.");
      return;
    }

    if (shouldUseLeaflet) {
      await searchOpenStreetMapAddress(trimmedAddress);
      return;
    }

    if (!geocoderRef.current || !window.kakao?.maps) {
      setSearchStatus("카카오맵이 아직 준비되지 않았습니다.");
      return;
    }

    geocoderRef.current.addressSearch(trimmedAddress, (result, status) => {
      if (status !== window.kakao?.maps.services.Status.OK || !result[0]) {
        setSearchStatus("주소를 찾지 못했습니다. 도로명 또는 지번 주소로 다시 검색해 주세요.");
        return;
      }

      const nextCenter = {
        lat: Number(result[0].y),
        lng: Number(result[0].x),
      };

      mapRef.current?.setLevel(5);
      setCenter(nextCenter);
      setSearchStatus(`검색 위치를 중심으로 설정했습니다: ${result[0].address_name}`);
    });
  }

  async function runLookupAndShowPlan() {
    setActiveTab("pagePlan");
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    await fetchKeywordVolumes(displayedGeneratedKeywords, "조회할 키워드가 없습니다.");
  }

  async function copyTextToClipboard(text: string, successMessage: string) {
    if (!text) {
      setCopyStatus("복사할 내용이 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(successMessage);
    } catch {
      setCopyStatus("브라우저 클립보드 권한 때문에 복사하지 못했습니다.");
    }
  }

  async function copyKeywords(rows: GeneratedKeyword[], successMessage: string) {
    await copyTextToClipboard(rows.map((row) => row.keyword).join("\n"), successMessage);
  }

  function toggleKeywordSelection(rowId: string) {
    setSelectedKeywordIds((currentIds) =>
      currentIds.includes(rowId) ? currentIds.filter((id) => id !== rowId) : [...currentIds, rowId],
    );
  }

  function toggleAllVisibleKeywords() {
    const visibleIds = displayedGeneratedKeywords.map((keyword) => keyword.rowId);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedKeywordIds.includes(id));

    setSelectedKeywordIds((currentIds) => {
      if (allVisibleSelected) {
        return currentIds.filter((id) => !visibleIds.includes(id));
      }

      return Array.from(new Set([...currentIds, ...visibleIds]));
    });
  }

  function selectAllVisibleKeywords() {
    const visibleIds = displayedGeneratedKeywords.map((keyword) => keyword.rowId);

    if (visibleIds.length === 0) {
      setCopyStatus("선택할 키워드가 없습니다.");
      return;
    }

    setSelectedKeywordIds((currentIds) => Array.from(new Set([...currentIds, ...visibleIds])));
    setCopyStatus("표시된 키워드를 모두 선택했습니다.");
  }

  function clearKeywordSelection() {
    setSelectedKeywordIds([]);
    setCopyStatus("키워드 선택을 해제했습니다.");
  }

  async function fetchKeywordVolumes(rows: GeneratedKeyword[], emptyMessage: string) {
    const keywords = Array.from(new Set(rows.map((row) => row.keyword).filter(Boolean)));

    if (keywords.length === 0) {
      setKeywordVolumeStatus(emptyMessage);
      return;
    }

    setIsKeywordVolumeLoading(true);
    setKeywordVolumeStatus(
      `네이버 검색량을 조회하는 중입니다. 총 ${keywords.length.toLocaleString("ko-KR")}개 키워드를 ${KEYWORD_VOLUME_BATCH_SIZE}개씩 천천히 조회합니다.`,
    );

    try {
      const allItems: KeywordVolumeItem[] = [];
      const foundKeywordSet = new Set<string>();
      const noResultKeywordSet = new Set<string>();
      let requestFailedKeywords = keywords;

      for (let passIndex = 0; passIndex < KEYWORD_VOLUME_MAX_PASSES && requestFailedKeywords.length > 0; passIndex += 1) {
        const passKeywords = requestFailedKeywords;
        const batches = chunkArray(passKeywords, KEYWORD_VOLUME_BATCH_SIZE);
        const nextRequestFailedKeywords: string[] = [];

        for (let index = 0; index < batches.length; index += 1) {
          setKeywordVolumeStatus(
            `네이버 검색량 조회 중입니다. ${passIndex + 1}/${KEYWORD_VOLUME_MAX_PASSES}차, ${index + 1}/${batches.length} 묶음 처리 중...`,
          );

          const response = await fetch("/api/naver-keyword-volume", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ keywords: batches[index] }),
          });
          const data = (await response.json()) as KeywordVolumeResponse | KeywordVolumeErrorResponse;

          if (!response.ok) {
            const errorData = data as KeywordVolumeErrorResponse;

            setKeywordVolumeStatus(errorData.message || "네이버 검색량 조회에 실패했습니다.");
            return;
          }

          const result = data as KeywordVolumeResponse;

          for (const item of result.items) {
            if (!foundKeywordSet.has(item.keyword)) {
              allItems.push(item);
              foundKeywordSet.add(item.keyword);
            }
          }

          for (const failedItem of result.summary.failedItems ?? []) {
            if (failedItem.reason === "NO_RESULT") {
              noResultKeywordSet.add(failedItem.keyword);
            } else if (!foundKeywordSet.has(failedItem.keyword) && !noResultKeywordSet.has(failedItem.keyword)) {
              nextRequestFailedKeywords.push(failedItem.keyword);
            }
          }

          await delay(KEYWORD_VOLUME_PASS_DELAY_MS);
        }

        requestFailedKeywords = Array.from(new Set(nextRequestFailedKeywords));
      }

      const nextKeywordVolumes = allItems.reduce<Record<string, KeywordVolumeItem>>((accumulator, item) => {
        accumulator[item.keyword] = item;
        return accumulator;
      }, {});

      setKeywordVolumeByKeyword((current) => ({
        ...current,
        ...nextKeywordVolumes,
      }));
      setKeywordVolumeFailedKeywords((current) =>
        Array.from(new Set([...current, ...Array.from(noResultKeywordSet), ...requestFailedKeywords])),
      );
      setKeywordVolumeStatus(
        noResultKeywordSet.size + requestFailedKeywords.length > 0
          ? `${allItems.length.toLocaleString("ko-KR")}개 조회 완료, 검색 데이터 없음 ${noResultKeywordSet.size.toLocaleString("ko-KR")}개, 끝까지 재시도했지만 API 요청 실패 ${requestFailedKeywords.length.toLocaleString("ko-KR")}개입니다.`
          : `${allItems.length.toLocaleString("ko-KR")}개 키워드 검색량을 조회했습니다.`,
      );
    } catch {
      setKeywordVolumeStatus("네이버 검색량 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setIsKeywordVolumeLoading(false);
    }
  }

  async function copyPagePlan() {
    const lines = pagePlans.map((plan, index) => {
      const head = `## ${index + 1}. ${plan.locationName} 페이지 (${plan.targetType})`;
      const volume = `- 합산 검색량: 월 ${plan.totalVolume.toLocaleString("ko-KR")}회`;
      const score = plan.bestScore === undefined ? null : `- 최고 기회 지수: ${plan.bestScore.toLocaleString("ko-KR")}`;
      const main = `- 대표 키워드: ${plan.keywords[0]?.keyword ?? "-"}`;
      const rest = `- 함께 노릴 키워드: ${plan.keywords.map((item) => item.keyword).join(", ")}`;

      return [head, volume, score, main, rest].filter(Boolean).join("\n");
    });

    await copyTextToClipboard(
      [`# 만들 페이지 ${pagePlans.length}개`, "", ...lines].join("\n\n"),
      `${pagePlans.length.toLocaleString("ko-KR")}개 페이지 계획을 복사했습니다.`,
    );
  }

  function downloadKeywordVolumeExcel() {
    const headers = [
      "검색키워드",
      "기본키워드",
      "전체검색",
      "PC검색",
      "모바일검색",
      "모바일비중",
      "경쟁업체",
      "노출광고",
      "기회지수",
      "경쟁도",
      "추천용도",
    ];
    const rows = displayedGeneratedKeywords.map((generatedKeyword) => {
      const keywordVolume = keywordVolumeByKeyword[generatedKeyword.keyword];
      const keywordVolumeMissing = keywordVolumeFailedSet.has(generatedKeyword.keyword);
      const keywordVolumeEmptyLabel = keywordVolumeMissing ? "데이터 없음" : "미조회";

      return [
        generatedKeyword.keyword,
        generatedKeyword.baseKeyword,
        keywordVolume ? keywordVolume.totalCount.toLocaleString("ko-KR") : keywordVolumeEmptyLabel,
        keywordVolume?.monthlyPcQcCntDisplay || keywordVolumeEmptyLabel,
        keywordVolume?.monthlyMobileQcCntDisplay || keywordVolumeEmptyLabel,
        keywordVolume ? `${keywordVolume.mobileRatio.toFixed(1)}%` : "-",
        keywordVolume?.placeCount === undefined ? "-" : keywordVolume.placeCount.toLocaleString("ko-KR"),
        keywordVolume ? keywordVolume.adDepth.toLocaleString("ko-KR") : "-",
        keywordVolume?.opportunityScore === undefined ? "-" : keywordVolume.opportunityScore.toLocaleString("ko-KR"),
        keywordVolume?.compIdx || "-",
        keywordVolume?.recommendUse.join(", ") || "-",
      ];
    });
    const tableRows = [headers, ...rows]
      .map(
        (row, rowIndex) =>
          `<tr>${row
            .map((cell) => (rowIndex === 0 ? `<th>${excelEscape(cell)}</th>` : `<td>${excelEscape(cell)}</td>`))
            .join("")}</tr>`,
      )
      .join("");
    const workbookHtml = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table>${tableRows}</table></body></html>`;
    const blob = new Blob(["\uFEFF", workbookHtml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "keyword_volume_results.xls";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="grid min-h-[680px] overflow-hidden rounded-lg border border-rule bg-surface shadow-sm lg:grid-cols-[340px_1fr]">
      <aside className="flex flex-col gap-7 border-b border-rule p-5 lg:border-b-0 lg:border-r">
        <form className="space-y-2" onSubmit={handleAddressSearch}>
          <label className="eyebrow block" htmlFor="address-search">
            중심 지점
          </label>
          <div className="flex gap-2">
            <input
              id="address-search"
              className="min-w-0 flex-1 rounded-md border border-rule bg-field px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-tide focus:bg-surface"
              placeholder="예: 서울특별시 중구 세종대로 110"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button
              className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-tide-deep"
              type="submit"
            >
              검색
            </button>
          </div>
          <p className="min-h-5 text-xs leading-5 text-ink-soft">
            {searchStatus || "지도를 직접 클릭해 지점을 잡아도 됩니다."}
          </p>
        </form>

        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">반경</span>
            <strong className="tabular text-lg font-semibold text-tide">{radiusKm}km</strong>
          </div>
          <div className="scale-bar" role="group" aria-label="반경 선택">
            {radiusOptions.map((option) => (
              <button
                aria-pressed={radiusKm === option}
                className="scale-tick"
                data-major={option % 5 === 0}
                key={option}
                type="button"
                onClick={() => setRadiusKm(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <input
            aria-label="반경 슬라이더"
            className="w-full accent-tide"
            max={radiusOptions.length - 1}
            min={0}
            step={1}
            type="range"
            value={radiusSliderIndex}
            onChange={(event) => setRadiusKm(radiusOptions[Number(event.target.value)] ?? DEFAULT_RADIUS_KM)}
          />
        </div>

        <div className="space-y-2">
          <label className="eyebrow block" htmlFor="base-keywords">
            기본 키워드
          </label>
          <textarea
            id="base-keywords"
            className="min-h-28 w-full resize-y rounded-md border border-rule bg-field px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-tide focus:bg-surface"
            placeholder={"치과, 임플란트\n소아치과"}
            value={baseKeywordInput}
            onChange={(event) => setBaseKeywordInput(event.target.value)}
          />
          <p className="text-xs leading-5 text-ink-soft">
            쉼표나 줄바꿈으로 여러 개를 넣습니다. 치과추천, 치과야간진료처럼 수식어까지 붙이면 그대로 조합합니다.
          </p>
          {/* 키워드를 넣어도 이 자리에서는 아무 일도 없어 보인다. 결과까지 한 번에 데려간다.
              개수와 활성 여부는 실제 조회 대상인 필터 적용 후 목록을 따라야 어긋나지 않는다. */}
          <button
            className="w-full rounded-md bg-tide px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-tide-deep disabled:cursor-not-allowed disabled:opacity-50"
            disabled={displayedGeneratedKeywords.length === 0 || isKeywordVolumeLoading}
            type="button"
            onClick={runLookupAndShowPlan}
          >
            {isKeywordVolumeLoading
              ? "검색량 조회 중..."
              : displayedGeneratedKeywords.length === 0
                ? "조회할 키워드가 없습니다"
                : `키워드 ${displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개 검색량 조회`}
          </button>
        </div>

        {/* 좁은 화면에서는 지도 위 카드가 지도를 다 덮으므로 여기에 같은 숫자를 둔다. */}
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-rule bg-rule md:hidden">
          {radiusStats.map((stat) => (
            <div className="bg-surface px-3 py-2" key={stat.label}>
              <dt className="eyebrow">{stat.label}</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold text-ink">{stat.value.toLocaleString("ko-KR")}</dd>
            </div>
          ))}
        </dl>

        <dl className="mt-auto space-y-2 border-t border-rule-soft pt-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">선택 좌표</dt>
            <dd className="tabular text-xs text-ink">{selectedLabel}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">검색 대상 반경</dt>
            <dd className="tabular text-ink">{(radiusKm * 1000).toLocaleString("ko-KR")}m</dd>
          </div>
        </dl>
      </aside>

      <div className="relative min-h-[420px] bg-canvas">
        <div className="magic-map-leaflet h-full min-h-[680px] w-full" ref={mapContainerRef} />
        {/* 통계는 지도 옆이 아니라 지도 위에 둔다. 반경을 바꾸는 손과 숫자가 같은 곳에 있어야 한다. */}
        <dl className="pointer-events-none absolute left-4 top-4 z-[400] hidden w-max grid-cols-3 gap-px overflow-hidden rounded-md border border-rule bg-rule shadow-sm md:grid">
          {radiusStats.map((stat) => (
            <div className="bg-surface/95 px-4 py-2.5 backdrop-blur-sm" key={stat.label}>
              <dt className="eyebrow">{stat.label}</dt>
              <dd className="tabular mt-0.5 text-xl font-semibold text-ink">
                {stat.value.toLocaleString("ko-KR")}
              </dd>
            </div>
          ))}
        </dl>
        {(!isMapReady || activeMapLoadError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/80 p-6 text-center backdrop-blur-sm">
            <div className="rounded-lg border border-rule bg-surface p-5 shadow-sm">
              <p className="font-semibold text-ink">{mapOverlayMessage}</p>
              <p className="mt-2 text-sm text-ink-soft">{mapOverlayDescription}</p>
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-rule px-5 lg:col-span-2" ref={resultsRef}>
        <div className="flex flex-wrap gap-6" role="tablist">
          {resultTabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.id}
              className={`-mb-px border-b-2 py-3 text-sm font-semibold transition ${
                activeTab === tab.id
                  ? "border-tide text-tide"
                  : "border-transparent text-ink-soft hover:text-ink"
              }`}
              key={tab.id}
              role="tab"
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className={activeTab === "summary" ? "border-t border-rule p-5 lg:col-span-2" : "hidden"}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-rule p-4">
            <p className="text-sm font-medium text-ink-soft">전철역</p>
            <strong className="mt-2 block text-3xl font-semibold text-ink">
              {nearbyStations.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-ink-soft">{stationLoadStatus}</p>
          </div>
          <div className="rounded-lg border border-rule p-4">
            <p className="text-sm font-medium text-ink-soft">동/읍/면</p>
            <strong className="mt-2 block text-3xl font-semibold text-ink">
              {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-ink-soft">{adminLoadStatus}</p>
          </div>
          <div className="rounded-lg border border-rule p-4">
            <p className="text-sm font-medium text-ink-soft">기본 키워드</p>
            <strong className="mt-2 block text-3xl font-semibold text-ink">
              {baseKeywords.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-ink-soft">쉼표와 줄바꿈 기준</p>
          </div>
          <div className="rounded-lg border border-rule p-4">
            <p className="text-sm font-medium text-ink-soft">생성 키워드</p>
            <strong className="mt-2 block text-3xl font-semibold text-ink">
              {displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-ink-soft">현재 필터 적용 결과</p>
          </div>
        </div>
      </div>
      <div className={activeTab === "stations" ? "border-t border-rule p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-ink">반경 내 전철역</h3>
            <p className="text-sm text-ink-soft">{stationLoadStatus}</p>
          </div>
          <p className="text-sm font-medium text-tide">
            {radiusKm}km 안 {nearbyStations.length.toLocaleString("ko-KR")}개 역
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="min-w-[860px] w-full border-collapse text-left text-sm">
            <thead className="bg-field text-xs font-semibold uppercase text-ink-soft">
              <tr>
                <th className="px-4 py-3">역명</th>
                <th className="px-4 py-3">노선</th>
                <th className="px-4 py-3">거리</th>
                <th className="px-4 py-3">위도</th>
                <th className="px-4 py-3">경도</th>
                <th className="px-4 py-3">출처</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-soft bg-surface">
              {nearbyStations.length > 0 ? (
                nearbyStations.map((station, index) => (
                  <tr
                    className="hover:bg-field"
                    key={`${station.id}-${station.stationName}-${station.lineName}-${station.lat}-${station.lng}-${index}`}
                  >
                    <td className="px-4 py-3 font-semibold text-ink">{station.stationName}</td>
                    <td className="px-4 py-3 text-ink-soft">{station.lineName}</td>
                    <td className="px-4 py-3 font-mono text-ink">{formatDistance(station.distanceKm)}</td>
                    <td className="px-4 py-3 font-mono text-ink-soft">{formatCoordinate(station.lat)}</td>
                    <td className="px-4 py-3 font-mono text-ink-soft">{formatCoordinate(station.lng)}</td>
                    <td className="px-4 py-3 text-ink-soft">{station.source}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-ink-soft" colSpan={6}>
                    현재 중심점과 반경 안에 표시할 역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className={activeTab === "adminAreas" ? "border-t border-rule p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-ink">반경 교차 행정구역</h3>
            <p className="text-sm text-ink-soft">{adminLoadStatus}</p>
            <p className="mt-1 text-sm font-medium text-amber-700">
              행정구역은 경계 교차 기준, 거리는 중심점 참고값입니다.
            </p>
          </div>
          <p className="text-sm font-medium text-tide">
            {radiusKm}km 원과 교차 {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="min-w-[960px] w-full border-collapse text-left text-sm">
            <thead className="bg-field text-xs font-semibold uppercase text-ink-soft">
              <tr>
                <th className="px-4 py-3">원본명</th>
                <th className="px-4 py-3">유형</th>
                <th className="px-4 py-3">시도</th>
                <th className="px-4 py-3">시군구</th>
                <th className="px-4 py-3">거리</th>
                <th className="px-4 py-3">포함 기준</th>
                <th className="px-4 py-3">출처</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-soft bg-surface">
              {intersectingAdminAreas.length > 0 ? (
                intersectingAdminAreas.map((area, index) => (
                  <tr
                    className="hover:bg-field"
                    key={`${area.id}-${area.originalName}-${area.sido}-${area.sigungu}-${index}`}
                  >
                    <td className="px-4 py-3 font-semibold text-ink">{area.originalName}</td>
                    <td className="px-4 py-3 text-ink-soft">{area.type}</td>
                    <td className="px-4 py-3 text-ink-soft">{area.sido}</td>
                    <td className="px-4 py-3 text-ink-soft">{area.sigungu}</td>
                    <td className="px-4 py-3 font-mono text-ink">{formatDistance(area.distanceKm)}</td>
                    <td className="px-4 py-3 font-mono text-ink-soft">{area.includeRule}</td>
                    <td className="px-4 py-3 text-ink-soft">{area.source}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-ink-soft" colSpan={7}>
                    현재 반경 원과 경계가 교차하는 행정구역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className={activeTab === "pagePlan" ? "border-t border-rule p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-ink">만들 페이지</h3>
            <p className="mt-1 text-sm text-ink-soft">
              같은 지명을 노리는 키워드는 페이지 하나가 함께 먹습니다. 지명으로 묶어 검색량이 큰 순서대로 세웠습니다.
            </p>
            {pagePlanPriority.firstBatchCount > 0 ? (
              <p className="mt-2 text-sm font-medium text-ink">
                이 <strong className="tabular text-signal">{pagePlanPriority.firstBatchCount}개</strong>부터 만드세요. 이
                반경 검색량의 <strong className="tabular">{pagePlanPriority.coverageRatio}%</strong>(월{" "}
                {pagePlanPriority.coveredVolume.toLocaleString("ko-KR")}회)를 덮습니다.
              </p>
            ) : null}
          </div>
          <button
            className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-tide-deep disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pagePlans.length === 0}
            type="button"
            onClick={copyPagePlan}
          >
            작업 목록 복사
          </button>
        </div>
        {pagePlans.length === 0 ? (
          <p className="rounded-md border border-rule bg-field px-4 py-10 text-center text-sm text-ink-soft">
            기본 키워드를 입력하면 만들 페이지가 정리됩니다.
          </p>
        ) : (
          <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(showAllPagePlans ? pagePlans : pagePlans.slice(0, pagePlanPriority.firstBatchCount)).map((plan, index) => (
              <li
                className={`rounded-md border bg-surface p-4 ${
                  index < pagePlanPriority.firstBatchCount ? "border-tide" : "border-rule opacity-70"
                }`}
                key={plan.locationName}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="font-semibold text-ink">
                    <span className="tabular mr-2 text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
                    {plan.locationName}
                  </h4>
                  <span className="eyebrow">{plan.targetType}</span>
                </div>
                <dl className="mt-3 flex gap-5 text-sm">
                  <div>
                    <dt className="eyebrow">합산 검색량</dt>
                    <dd className="tabular mt-0.5 text-lg font-semibold text-ink">
                      {plan.totalVolume > 0 ? plan.totalVolume.toLocaleString("ko-KR") : "미조회"}
                    </dd>
                  </div>
                  <div>
                    <dt className="eyebrow">최고 기회</dt>
                    <dd className="tabular mt-0.5 text-lg font-semibold text-signal">
                      {plan.bestScore === undefined ? "-" : plan.bestScore.toLocaleString("ko-KR")}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs leading-5 text-ink-soft">
                  {plan.keywords.map((item) => item.keyword).join(", ")}
                </p>
              </li>
            ))}
          </ol>
        )}
        {pagePlans.length > pagePlanPriority.firstBatchCount ? (
          <button
            className="mt-3 rounded-md border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink-soft transition hover:border-ink-faint"
            type="button"
            onClick={() => setShowAllPagePlans((current) => !current)}
          >
            {showAllPagePlans
              ? "우선순위 5개만 보기"
              : `나머지 ${(pagePlans.length - pagePlanPriority.firstBatchCount).toLocaleString("ko-KR")}개도 보기`}
          </button>
        ) : null}
      </div>
      <div className={activeTab === "keywords" ? "border-t border-rule p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-ink">지역 SEO 키워드</h3>
            <p className="text-sm text-ink-soft">
              suffix 포함 결과와 suffix 제거 결과를 모두 생성하고, 네이버 검색량은 현재 테이블에서 바로 조회합니다.
            </p>
          </div>
          <p className="text-sm font-medium text-tide">
            기본 키워드 {baseKeywords.length.toLocaleString("ko-KR")}개 / 전체{" "}
            {generatedKeywords.length.toLocaleString("ko-KR")}개 / 표시{" "}
            {displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개 / 선택{" "}
            {selectedKeywordRows.length.toLocaleString("ko-KR")}개 / 검색량{" "}
            {keywordVolumeResultCount.toLocaleString("ko-KR")}개
          </p>
        </div>

        <div className="mb-4 grid gap-3 rounded-lg border border-rule bg-field p-4 xl:grid-cols-[1fr_1fr_1fr_2fr]">
          <label className="flex items-center gap-2 text-sm font-medium text-ink">
            <input
              checked={mergeDuplicates}
              className="h-4 w-4 accent-tide"
              type="checkbox"
              onChange={(event) => {
                setMergeDuplicates(event.target.checked);
                setSelectedKeywordIds([]);
              }}
            />
            중복 병합 {mergeDuplicates ? "ON" : "OFF"}
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            suffix 필터
            <select
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm"
              value={suffixFilter}
              onChange={(event) => {
                setSuffixFilter(event.target.value as SuffixFilter);
                setSelectedKeywordIds([]);
              }}
            >
              <option value="all">전체</option>
              <option value="suffix_included">suffix 포함</option>
              <option value="suffix_removed">suffix 제거</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            대상 필터
            <select
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm"
              value={targetTypeFilter}
              onChange={(event) => {
                setTargetTypeFilter(event.target.value as TargetTypeFilter);
                setSelectedKeywordIds([]);
              }}
            >
              <option value="all">전체</option>
              <option value="전철역">전철역</option>
              <option value="시군구">시군구</option>
              <option value="동">동</option>
              <option value="읍">읍</option>
              <option value="면">면</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            정렬
            <select
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm"
              value={keywordSort}
              onChange={(event) => setKeywordSort(event.target.value as KeywordSort)}
            >
              <option value="volume">검색량순</option>
              <option value="opportunity">기회 지수순</option>
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <button
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm font-semibold text-ink transition hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
              disabled={displayedGeneratedKeywords.length === 0}
              type="button"
              onClick={selectAllVisibleKeywords}
            >
              전체 선택
            </button>
            <button
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm font-semibold text-ink transition hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0}
              type="button"
              onClick={clearKeywordSelection}
            >
              선택 해제
            </button>
            <button
              className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-tide-deep"
              disabled={generatedKeywords.length === 0}
              type="button"
              onClick={() => void copyKeywords(generatedKeywords, "키워드 전체를 복사했습니다.")}
            >
              키워드 전체 복사
            </button>
            <button
              className="rounded-md border border-rule bg-surface px-3 py-2 text-sm font-semibold text-ink transition hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0}
              type="button"
              onClick={() => void copyKeywords(selectedKeywordRows, "선택 키워드를 복사했습니다.")}
            >
              선택 키워드 복사
            </button>
            <button
              className="rounded-md bg-tide px-3 py-2 text-sm font-semibold text-white transition hover:bg-tide-deep disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0 || isKeywordVolumeLoading}
              type="button"
              onClick={() =>
                void fetchKeywordVolumes(selectedKeywordRows, "검색량을 조회할 선택 키워드가 없습니다.")
              }
            >
              {isKeywordVolumeLoading ? "조회 중..." : "선택 키워드 검색량 조회"}
            </button>
            <button
              className="rounded-md border border-tide bg-surface px-3 py-2 text-sm font-semibold text-tide transition hover:border-tide-deep hover:bg-tide-wash disabled:cursor-not-allowed disabled:opacity-50"
              disabled={generatedKeywords.length === 0 || isKeywordVolumeLoading}
              type="button"
              onClick={() =>
                void fetchKeywordVolumes(generatedKeywords, "검색량을 조회할 전체 키워드가 없습니다.")
              }
            >
              {isKeywordVolumeLoading ? "조회 중..." : "전체 키워드 검색량 조회"}
            </button>
            <button
              className="rounded-md border border-emerald-300 bg-surface px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:border-emerald-500 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={displayedGeneratedKeywords.length === 0}
              type="button"
              onClick={downloadKeywordVolumeExcel}
            >
              검색량 엑셀 저장
            </button>
          </div>
        </div>

        {copyStatus && <p className="mb-3 text-sm font-medium text-tide">{copyStatus}</p>}
        {keywordVolumeStatus && <p className="mb-3 text-sm font-medium text-tide">{keywordVolumeStatus}</p>}

        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="min-w-[1280px] w-full border-collapse text-left text-sm">
            <thead className="bg-field text-xs font-semibold uppercase text-ink-soft">
              <tr>
                <th className="px-4 py-3">
                  <button className="font-semibold text-ink-soft" type="button" onClick={toggleAllVisibleKeywords}>
                    선택
                  </button>
                </th>
                <th className="px-4 py-3">생성 키워드</th>
                <th className="px-4 py-3">기본 키워드</th>
                <th className="px-4 py-3 text-right">전체검색</th>
                <th className="px-4 py-3 text-right">PC검색</th>
                <th className="px-4 py-3 text-right">모바일검색</th>
                <th className="px-4 py-3 text-right">모바일 비중</th>
                <th className="px-4 py-3 text-right">경쟁 업체</th>
                <th className="px-4 py-3 text-right">노출 광고</th>
                <th className="px-4 py-3 text-right">기회 지수</th>
                <th className="px-4 py-3">경쟁도</th>
                <th className="px-4 py-3">추천 용도</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-soft bg-surface">
              {renderedGeneratedKeywords.length > 0 ? (
                renderedGeneratedKeywords.map((generatedKeyword) => {
                  const keywordVolume = keywordVolumeByKeyword[generatedKeyword.keyword];
                  const keywordVolumeMissing = keywordVolumeFailedSet.has(generatedKeyword.keyword);
                  const keywordVolumeEmptyLabel = keywordVolumeMissing ? "데이터 없음" : "미조회";

                  return (
                    <tr className="align-top hover:bg-field" key={generatedKeyword.rowId}>
                      <td className="px-4 py-3">
                        <input
                          checked={selectedKeywordIds.includes(generatedKeyword.rowId)}
                          className="h-4 w-4 accent-tide"
                          type="checkbox"
                          onChange={() => toggleKeywordSelection(generatedKeyword.rowId)}
                        />
                      </td>
                      <td className="px-4 py-3 font-semibold text-ink">{generatedKeyword.keyword}</td>
                      <td className="px-4 py-3 text-ink-soft">{generatedKeyword.baseKeyword}</td>
                      {/* 전체검색은 이 표에서 유일하게 "노릴지 말지"를 가르는 숫자다. 1,000회 이상만 신호색. */}
                      <td
                        className={`tabular px-4 py-3 text-right ${
                          keywordVolume && keywordVolume.totalCount >= 1000
                            ? "font-semibold text-signal"
                            : "text-ink"
                        }`}
                      >
                        {keywordVolume ? keywordVolume.totalCount.toLocaleString("ko-KR") : keywordVolumeEmptyLabel}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink-soft">
                        {keywordVolume?.monthlyPcQcCntDisplay || keywordVolumeEmptyLabel}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink-soft">
                        {keywordVolume?.monthlyMobileQcCntDisplay || keywordVolumeEmptyLabel}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink-soft">
                        {keywordVolume ? `${keywordVolume.mobileRatio.toFixed(1)}%` : "-"}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink-soft">
                        {keywordVolume?.placeCount === undefined
                          ? "-"
                          : keywordVolume.placeCount.toLocaleString("ko-KR")}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-ink-soft">
                        {keywordVolume ? keywordVolume.adDepth.toLocaleString("ko-KR") : "-"}
                      </td>
                      {/* 검색량 ÷ 경쟁 업체 수. 여기가 이 표에서 노릴 순서를 정하는 숫자다. */}
                      <td
                        className={`tabular px-4 py-3 text-right ${
                          keywordVolume?.opportunityScore !== undefined && keywordVolume.opportunityScore >= 50
                            ? "font-semibold text-signal"
                            : "text-ink"
                        }`}
                      >
                        {keywordVolume?.opportunityScore === undefined ? (
                          "-"
                        ) : (
                          <>
                            {keywordVolume.opportunityScore.toLocaleString("ko-KR")}
                            <span className="ml-1 text-xs font-normal text-ink-faint">
                              {keywordVolume.opportunityBasis === "place" ? "업체" : "광고"}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {keywordVolume?.compIdx ? (
                          <span
                            className={`inline-block rounded px-2 py-1 text-xs font-medium ${
                              keywordVolume.compIdx === "낮음"
                                ? "bg-tide-wash text-tide-deep"
                                : keywordVolume.compIdx === "높음"
                                  ? "bg-signal-wash text-signal"
                                  : "bg-field text-ink-soft"
                            }`}
                          >
                            {keywordVolume.compIdx}
                          </span>
                        ) : (
                          <span className="text-ink-faint">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {keywordVolume ? (
                          <div className="flex flex-wrap gap-1">
                            {keywordVolume.recommendUse.map((recommendation) => (
                              <span
                                className="rounded bg-tide-wash px-2 py-1 text-xs font-medium text-tide"
                                key={`${generatedKeyword.rowId}-${recommendation}`}
                              >
                                {recommendation}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-ink-faint">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-ink-soft" colSpan={12}>
                    기본 키워드를 입력하면 반경 안 전철역과 동·읍·면 조합 키워드가 생성됩니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {hiddenKeywordRowCount > 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-rule px-4 py-4">
            <p className="text-sm text-ink-soft">
              {renderedGeneratedKeywords.length.toLocaleString("ko-KR")}개 표시 중 · 나머지{" "}
              {hiddenKeywordRowCount.toLocaleString("ko-KR")}개는 숨겨져 있습니다. 복사와 엑셀 저장은 숨겨진 키워드까지
              모두 포함합니다.
            </p>
            <button
              className="h-10 rounded-md border border-rule bg-surface px-4 text-sm font-medium text-ink-soft transition hover:border-ink-faint"
              type="button"
              onClick={() => setVisibleKeywordRowCount((current) => current + KEYWORD_ROW_RENDER_STEP)}
            >
              {Math.min(KEYWORD_ROW_RENDER_STEP, hiddenKeywordRowCount).toLocaleString("ko-KR")}개 더 보기
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
