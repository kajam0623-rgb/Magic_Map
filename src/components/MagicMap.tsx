"use client";

import booleanIntersects from "@turf/boolean-intersects";
import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import distance from "@turf/distance";
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
  targetType: "전철역" | "동" | "읍" | "면";
  generationRule: "suffix_included" | "suffix_removed";
  source: string;
};

type GeneratedKeyword = {
  rowId: string;
  keyword: string;
  baseKeyword: string;
  sourceItems: KeywordSourceItem[];
};

type ResultTab = "summary" | "stations" | "adminAreas" | "keywords" | "downloads";
type SuffixFilter = "all" | KeywordSourceItem["generationRule"];
type TargetTypeFilter = "all" | KeywordSourceItem["targetType"];

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
const KEYWORD_VOLUME_BATCH_SIZE = 10;
const KEYWORD_VOLUME_MAX_PASSES = 4;
const KEYWORD_VOLUME_PASS_DELAY_MS = 700;
const radiusOptions = [...Array.from({ length: 10 }, (_, index) => index + 1), 20, 30];
const adminSuffixes = ["동", "읍", "면"];
const resultTabs: { id: ResultTab; label: string }[] = [
  { id: "summary", label: "전체 요약" },
  { id: "stations", label: "전철역" },
  { id: "adminAreas", label: "동/읍/면" },
  { id: "keywords", label: "생성 키워드" },
  { id: "downloads", label: "CSV 다운로드" },
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

function removeTrailingSuffix(name: string, suffixes: string[]) {
  const matchedSuffix = suffixes.find((suffix) => name.endsWith(suffix));

  if (!matchedSuffix || name.length <= matchedSuffix.length) {
    return name;
  }

  return name.slice(0, -matchedSuffix.length);
}

function keywordLocationVariants(nameWithSuffix: string, suffixes: string[]) {
  return Array.from(
    new Set([
      { name: nameWithSuffix, rule: "suffix_included" as const },
      { name: removeTrailingSuffix(nameWithSuffix, suffixes), rule: "suffix_removed" as const },
    ].map((variant) => `${variant.name}\t${variant.rule}`)),
  ).map((serialized) => {
    const [name, rule] = serialized.split("\t") as [string, KeywordSourceItem["generationRule"]];

    return { name, rule };
  });
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

  for (const baseKeyword of baseKeywords) {
    for (const station of stations) {
      const stationNameWithSuffix = withStationSuffix(station.stationName);
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

    for (const area of adminAreas.filter(isTargetAdminArea)) {
      const variants = keywordLocationVariants(area.originalName, adminSuffixes);

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

function csvEscape(value: string | number) {
  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildCsv(headers: string[], rows: (string | number)[][]) {
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
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

function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob(["\uFEFF", csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
    };
  });
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
  const leafletMarkerRef = useRef<Leaflet.Marker | null>(null);
  const leafletCircleRef = useRef<Leaflet.Circle | null>(null);

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

    return adminAreas
      .filter((area) => booleanIntersects(radiusPolygon, area.feature))
      .map((area) => {
        const areaCentroid = centroid(area.feature);
        const distanceKm = distance(centerPoint, areaCentroid, { units: "kilometers" });

        return {
          ...area,
          distanceKm,
          includeRule: "polygon_intersects" as const,
        };
      })
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
  }, [filteredGeneratedKeywords, keywordVolumeByKeyword]);
  const selectedKeywordRows = useMemo(
    () => displayedGeneratedKeywords.filter((keyword) => selectedKeywordIds.includes(keyword.rowId)),
    [displayedGeneratedKeywords, selectedKeywordIds],
  );
  const keywordVolumeResultCount = Object.keys(keywordVolumeByKeyword).length;
  const keywordVolumeFailedSet = useMemo(() => new Set(keywordVolumeFailedKeywords), [keywordVolumeFailedKeywords]);
  const radiusSliderIndex = Math.max(0, radiusOptions.indexOf(radiusKm));

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
          zoomControl: true,
        });
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
            color: "#2563eb",
            fillColor: "#38bdf8",
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
      strokeColor: "#2563eb",
      strokeOpacity: 0.9,
      strokeStyle: "solid",
      fillColor: "#38bdf8",
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
    leafletMapRef.current.setView(nextPosition);
    leafletMarkerRef.current.setLatLng(nextPosition);
    leafletCircleRef.current.setLatLng(nextPosition);
    leafletCircleRef.current.setRadius(radiusKm * 1000);
  }, [center, radiusKm]);

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

      leafletMapRef.current?.setZoom(15);
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

  async function copyKeywords(rows: GeneratedKeyword[], successMessage: string) {
    const text = rows.map((row) => row.keyword).join("\n");

    if (!text) {
      setCopyStatus("복사할 키워드가 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(successMessage);
    } catch {
      setCopyStatus("브라우저 클립보드 권한 때문에 복사하지 못했습니다.");
    }
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

  function downloadStationsCsv() {
    downloadCsv(
      "stations_result.csv",
      buildCsv(
        ["id", "station_name", "line_name", "station_type", "distance_km", "lat", "lng", "source"],
        nearbyStations.map((station) => [
          station.id,
          station.stationName,
          station.lineName,
          station.stationType,
          station.distanceKm.toFixed(4),
          formatCoordinate(station.lat),
          formatCoordinate(station.lng),
          station.source,
        ]),
      ),
    );
  }

  function downloadAdminAreasCsv() {
    downloadCsv(
      "admin_areas_result.csv",
      buildCsv(
        ["id", "original_name", "type", "sido", "sigungu", "distance_km", "include_rule", "source"],
        intersectingAdminAreas.map((area) => [
          area.id,
          area.originalName,
          area.type,
          area.sido,
          area.sigungu,
          area.distanceKm.toFixed(4),
          area.includeRule,
          area.source,
        ]),
      ),
    );
  }

  function downloadKeywordResultsCsv() {
    downloadCsv(
      "keyword_results.csv",
      buildCsv(
        [
          "keyword",
          "base_keyword",
          "source_count",
          "source_items",
          "merge_duplicates",
          "suffix_filter",
          "target_type_filter",
        ],
        displayedGeneratedKeywords.map((keyword) => [
          keyword.keyword,
          keyword.baseKeyword,
          keyword.sourceItems.length,
          keyword.sourceItems
            .map(
              (item) =>
                `${item.originalName}|${item.keywordLocationName}|${item.targetType}|${item.generationRule}|${item.source}`,
            )
            .join("; "),
          mergeDuplicates ? "ON" : "OFF",
          suffixFilter,
          targetTypeFilter,
        ]),
      ),
    );
  }

  return (
    <section className="grid min-h-[680px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:grid-cols-[360px_1fr]">
      <aside className="flex flex-col gap-6 border-b border-slate-200 p-5 lg:border-b-0 lg:border-r">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase text-blue-700">Step 5</p>
          <h2 className="text-2xl font-semibold text-slate-950">반경 기반 SEO 키워드 생성</h2>
          <p className="text-sm leading-6 text-slate-600">
            주소를 검색하거나 지도 위 원하는 지점을 클릭하면 반경 안 역과 동·읍·면을 키워드와 조합합니다.
          </p>
        </div>

        <form className="space-y-3" onSubmit={handleAddressSearch}>
          <label className="text-sm font-medium text-slate-800" htmlFor="address-search">
            주소 검색
          </label>
          <div className="flex gap-2">
            <input
              id="address-search"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
              placeholder="예: 서울특별시 중구 세종대로 110"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button
              className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              type="submit"
            >
              검색
            </button>
          </div>
          <p className="min-h-5 text-xs leading-5 text-slate-500">{searchStatus}</p>
        </form>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-slate-800" htmlFor="radius">
              반경
            </label>
            <strong className="text-lg font-semibold text-blue-700">{radiusKm}km</strong>
          </div>
          <input
            id="radius"
            className="w-full accent-blue-700"
            max={radiusOptions.length - 1}
            min={0}
            step={1}
            type="range"
            value={radiusSliderIndex}
            onChange={(event) => setRadiusKm(radiusOptions[Number(event.target.value)] ?? DEFAULT_RADIUS_KM)}
          />
          <div className="grid grid-cols-5 gap-2">
            {radiusOptions.map((option) => (
              <button
                className={`h-9 rounded-md border text-sm font-medium transition ${
                  radiusKm === option
                    ? "border-blue-700 bg-blue-700 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                }`}
                key={option}
                type="button"
                onClick={() => setRadiusKm(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-sm font-medium text-slate-800" htmlFor="base-keywords">
            기본 키워드
          </label>
          <textarea
            id="base-keywords"
            className="min-h-28 w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
            placeholder={"치과, 임플란트\n소아치과"}
            value={baseKeywordInput}
            onChange={(event) => setBaseKeywordInput(event.target.value)}
          />
          <p className="text-xs leading-5 text-slate-500">
            쉼표 또는 줄바꿈으로 여러 키워드를 입력할 수 있습니다.
          </p>
        </div>

        <dl className="mt-auto grid gap-3 rounded-lg bg-slate-50 p-4 text-sm">
          <div>
            <dt className="font-medium text-slate-500">선택 좌표</dt>
            <dd className="mt-1 font-mono text-slate-950">{selectedLabel}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">검색 대상 반경</dt>
            <dd className="mt-1 font-semibold text-slate-950">{radiusKm * 1000}m</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">반경 내 역</dt>
            <dd className="mt-1 font-semibold text-slate-950">{nearbyStations.length.toLocaleString("ko-KR")}개</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">교차 행정구역</dt>
            <dd className="mt-1 font-semibold text-slate-950">
              {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">생성 키워드</dt>
            <dd className="mt-1 font-semibold text-slate-950">{generatedKeywords.length.toLocaleString("ko-KR")}개</dd>
          </div>
        </dl>
      </aside>

      <div className="relative min-h-[420px] bg-slate-100">
        <div className="magic-map-leaflet h-full min-h-[680px] w-full" ref={mapContainerRef} />
        {(!isMapReady || activeMapLoadError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 p-6 text-center backdrop-blur-sm">
            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <p className="font-semibold text-slate-950">{mapOverlayMessage}</p>
              <p className="mt-2 text-sm text-slate-500">{mapOverlayDescription}</p>
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 p-5 lg:col-span-2">
        <div className="flex flex-wrap gap-2">
          {resultTabs.map((tab) => (
            <button
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition ${
                activeTab === tab.id
                  ? "border-blue-700 bg-blue-700 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className={activeTab === "summary" ? "border-t border-slate-200 p-5 lg:col-span-2" : "hidden"}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-500">전철역</p>
            <strong className="mt-2 block text-3xl font-semibold text-slate-950">
              {nearbyStations.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-slate-500">{stationLoadStatus}</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-500">동/읍/면</p>
            <strong className="mt-2 block text-3xl font-semibold text-slate-950">
              {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-slate-500">{adminLoadStatus}</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-500">기본 키워드</p>
            <strong className="mt-2 block text-3xl font-semibold text-slate-950">
              {baseKeywords.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-slate-500">쉼표와 줄바꿈 기준</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-500">생성 키워드</p>
            <strong className="mt-2 block text-3xl font-semibold text-slate-950">
              {displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개
            </strong>
            <p className="mt-2 text-sm text-slate-500">현재 필터 적용 결과</p>
          </div>
        </div>
      </div>
      <div className={activeTab === "stations" ? "border-t border-slate-200 p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-slate-950">반경 내 전철역</h3>
            <p className="text-sm text-slate-500">{stationLoadStatus}</p>
          </div>
          <p className="text-sm font-medium text-blue-700">
            {radiusKm}km 안 {nearbyStations.length.toLocaleString("ko-KR")}개 역
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-[860px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">역명</th>
                <th className="px-4 py-3">노선</th>
                <th className="px-4 py-3">거리</th>
                <th className="px-4 py-3">위도</th>
                <th className="px-4 py-3">경도</th>
                <th className="px-4 py-3">출처</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {nearbyStations.length > 0 ? (
                nearbyStations.map((station, index) => (
                  <tr
                    className="hover:bg-slate-50"
                    key={`${station.id}-${station.stationName}-${station.lineName}-${station.lat}-${station.lng}-${index}`}
                  >
                    <td className="px-4 py-3 font-semibold text-slate-950">{station.stationName}</td>
                    <td className="px-4 py-3 text-slate-700">{station.lineName}</td>
                    <td className="px-4 py-3 font-mono text-slate-950">{formatDistance(station.distanceKm)}</td>
                    <td className="px-4 py-3 font-mono text-slate-600">{formatCoordinate(station.lat)}</td>
                    <td className="px-4 py-3 font-mono text-slate-600">{formatCoordinate(station.lng)}</td>
                    <td className="px-4 py-3 text-slate-600">{station.source}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-slate-500" colSpan={6}>
                    현재 중심점과 반경 안에 표시할 역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className={activeTab === "adminAreas" ? "border-t border-slate-200 p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-slate-950">반경 교차 행정구역</h3>
            <p className="text-sm text-slate-500">{adminLoadStatus}</p>
            <p className="mt-1 text-sm font-medium text-amber-700">
              행정구역은 경계 교차 기준, 거리는 중심점 참고값입니다.
            </p>
          </div>
          <p className="text-sm font-medium text-blue-700">
            {radiusKm}km 원과 교차 {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-[960px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
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
            <tbody className="divide-y divide-slate-200 bg-white">
              {intersectingAdminAreas.length > 0 ? (
                intersectingAdminAreas.map((area, index) => (
                  <tr
                    className="hover:bg-slate-50"
                    key={`${area.id}-${area.originalName}-${area.sido}-${area.sigungu}-${index}`}
                  >
                    <td className="px-4 py-3 font-semibold text-slate-950">{area.originalName}</td>
                    <td className="px-4 py-3 text-slate-700">{area.type}</td>
                    <td className="px-4 py-3 text-slate-700">{area.sido}</td>
                    <td className="px-4 py-3 text-slate-700">{area.sigungu}</td>
                    <td className="px-4 py-3 font-mono text-slate-950">{formatDistance(area.distanceKm)}</td>
                    <td className="px-4 py-3 font-mono text-slate-700">{area.includeRule}</td>
                    <td className="px-4 py-3 text-slate-600">{area.source}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-slate-500" colSpan={7}>
                    현재 반경 원과 경계가 교차하는 행정구역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className={activeTab === "keywords" ? "border-t border-slate-200 p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-slate-950">지역 SEO 키워드</h3>
            <p className="text-sm text-slate-500">
              suffix 포함 결과와 suffix 제거 결과를 모두 생성하고, 네이버 검색량은 현재 테이블에서 바로 조회합니다.
            </p>
          </div>
          <p className="text-sm font-medium text-blue-700">
            기본 키워드 {baseKeywords.length.toLocaleString("ko-KR")}개 / 전체{" "}
            {generatedKeywords.length.toLocaleString("ko-KR")}개 / 표시{" "}
            {displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개 / 선택{" "}
            {selectedKeywordRows.length.toLocaleString("ko-KR")}개 / 검색량{" "}
            {keywordVolumeResultCount.toLocaleString("ko-KR")}개
          </p>
        </div>

        <div className="mb-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 xl:grid-cols-[1fr_1fr_1fr_2fr]">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              checked={mergeDuplicates}
              className="h-4 w-4 accent-blue-700"
              type="checkbox"
              onChange={(event) => {
                setMergeDuplicates(event.target.checked);
                setSelectedKeywordIds([]);
              }}
            />
            중복 병합 {mergeDuplicates ? "ON" : "OFF"}
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-800">
            suffix 필터
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
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
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-800">
            대상 필터
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={targetTypeFilter}
              onChange={(event) => {
                setTargetTypeFilter(event.target.value as TargetTypeFilter);
                setSelectedKeywordIds([]);
              }}
            >
              <option value="all">전체</option>
              <option value="전철역">전철역</option>
              <option value="동">동</option>
              <option value="읍">읍</option>
              <option value="면">면</option>
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={displayedGeneratedKeywords.length === 0}
              type="button"
              onClick={selectAllVisibleKeywords}
            >
              전체 선택
            </button>
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0}
              type="button"
              onClick={clearKeywordSelection}
            >
              선택 해제
            </button>
            <button
              className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              disabled={generatedKeywords.length === 0}
              type="button"
              onClick={() => void copyKeywords(generatedKeywords, "키워드 전체를 복사했습니다.")}
            >
              키워드 전체 복사
            </button>
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0}
              type="button"
              onClick={() => void copyKeywords(selectedKeywordRows, "선택 키워드를 복사했습니다.")}
            >
              선택 키워드 복사
            </button>
            <button
              className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeywordRows.length === 0 || isKeywordVolumeLoading}
              type="button"
              onClick={() =>
                void fetchKeywordVolumes(selectedKeywordRows, "검색량을 조회할 선택 키워드가 없습니다.")
              }
            >
              {isKeywordVolumeLoading ? "조회 중..." : "선택 키워드 검색량 조회"}
            </button>
            <button
              className="rounded-md border border-blue-300 bg-white px-3 py-2 text-sm font-semibold text-blue-700 transition hover:border-blue-500 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={generatedKeywords.length === 0 || isKeywordVolumeLoading}
              type="button"
              onClick={() =>
                void fetchKeywordVolumes(generatedKeywords, "검색량을 조회할 전체 키워드가 없습니다.")
              }
            >
              {isKeywordVolumeLoading ? "조회 중..." : "전체 키워드 검색량 조회"}
            </button>
          </div>
        </div>

        {copyStatus && <p className="mb-3 text-sm font-medium text-blue-700">{copyStatus}</p>}
        {keywordVolumeStatus && <p className="mb-3 text-sm font-medium text-blue-700">{keywordVolumeStatus}</p>}

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-[1280px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">
                  <button className="font-semibold text-slate-600" type="button" onClick={toggleAllVisibleKeywords}>
                    선택
                  </button>
                </th>
                <th className="px-4 py-3">생성 키워드</th>
                <th className="px-4 py-3">기본 키워드</th>
                <th className="px-4 py-3">전체검색</th>
                <th className="px-4 py-3">PC검색</th>
                <th className="px-4 py-3">모바일검색</th>
                <th className="px-4 py-3">모바일 비중</th>
                <th className="px-4 py-3">경쟁도</th>
                <th className="px-4 py-3">추천 용도</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {displayedGeneratedKeywords.length > 0 ? (
                displayedGeneratedKeywords.map((generatedKeyword) => {
                  const keywordVolume = keywordVolumeByKeyword[generatedKeyword.keyword];
                  const keywordVolumeMissing = keywordVolumeFailedSet.has(generatedKeyword.keyword);
                  const keywordVolumeEmptyLabel = keywordVolumeMissing ? "데이터 없음" : "미조회";

                  return (
                    <tr className="align-top hover:bg-slate-50" key={generatedKeyword.rowId}>
                      <td className="px-4 py-3">
                        <input
                          checked={selectedKeywordIds.includes(generatedKeyword.rowId)}
                          className="h-4 w-4 accent-blue-700"
                          type="checkbox"
                          onChange={() => toggleKeywordSelection(generatedKeyword.rowId)}
                        />
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{generatedKeyword.keyword}</td>
                      <td className="px-4 py-3 text-slate-700">{generatedKeyword.baseKeyword}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {keywordVolume ? keywordVolume.totalCount.toLocaleString("ko-KR") : keywordVolumeEmptyLabel}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {keywordVolume?.monthlyPcQcCntDisplay || keywordVolumeEmptyLabel}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {keywordVolume?.monthlyMobileQcCntDisplay || keywordVolumeEmptyLabel}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {keywordVolume ? `${keywordVolume.mobileRatio.toFixed(1)}%` : "-"}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{keywordVolume?.compIdx || "-"}</td>
                      <td className="px-4 py-3">
                        {keywordVolume ? (
                          <div className="flex flex-wrap gap-1">
                            {keywordVolume.recommendUse.map((recommendation) => (
                              <span
                                className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700"
                                key={`${generatedKeyword.rowId}-${recommendation}`}
                              >
                                {recommendation}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="px-4 py-10 text-center text-slate-500" colSpan={8}>
                    기본 키워드를 입력하면 반경 안 전철역과 동·읍·면 조합 키워드가 생성됩니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className={activeTab === "downloads" ? "border-t border-slate-200 p-5 lg:col-span-2" : "hidden"}>
        <div className="mb-4">
          <h3 className="text-xl font-semibold text-slate-950">CSV 다운로드</h3>
          <p className="mt-1 text-sm text-slate-500">
            모든 CSV는 UTF-8 BOM을 포함해 엑셀에서 한글이 깨지지 않도록 저장됩니다.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <button
            className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50"
            type="button"
            onClick={downloadStationsCsv}
          >
            <strong className="block text-slate-950">stations_result.csv 다운로드</strong>
            <span className="mt-2 block text-sm text-slate-500">
              현재 반경 안 전철역 {nearbyStations.length.toLocaleString("ko-KR")}개
            </span>
          </button>
          <button
            className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50"
            type="button"
            onClick={downloadAdminAreasCsv}
          >
            <strong className="block text-slate-950">admin_areas_result.csv 다운로드</strong>
            <span className="mt-2 block text-sm text-slate-500">
              경계 교차 행정구역 {intersectingAdminAreas.length.toLocaleString("ko-KR")}개
            </span>
          </button>
          <button
            className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50"
            type="button"
            onClick={downloadKeywordResultsCsv}
          >
            <strong className="block text-slate-950">keyword_results.csv 다운로드</strong>
            <span className="mt-2 block text-sm text-slate-500">
              현재 필터 키워드 {displayedGeneratedKeywords.length.toLocaleString("ko-KR")}개
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
