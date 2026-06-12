import * as adk from "admdongkor";
import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";

const rootDir = process.cwd();
const stationWorkbookPath = path.join(rootDir, "tmp", "kric_stations.xlsx");
const stationsOutputPath = path.join(rootDir, "public", "data", "stations.csv");
const adminOutputPath = path.join(rootDir, "public", "data", "eupmyeondong.geojson");
const kricDownloadUrl = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=32&operation=1";

function csvEscape(value) {
  const text = sanitizeText(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stationGroupKey(row) {
  const address = sanitizeText(row["역사도로명주소"]);

  if (address) {
    return `${sanitizeText(row["역사명"])}::${address}`;
  }

  return `${sanitizeText(row["역사명"])}::${Number(row["역위도"]).toFixed(4)}::${Number(row["역경도"]).toFixed(4)}`;
}

function normalizeStationName(name) {
  return sanitizeText(name).replace(/역$/, "");
}

async function buildStationsCsv() {
  try {
    await fs.access(stationWorkbookPath);
  } catch {
    const response = await fetch(kricDownloadUrl);

    if (!response.ok) {
      throw new Error(`KRIC station workbook download failed: ${response.status}`);
    }

    await fs.mkdir(path.dirname(stationWorkbookPath), { recursive: true });
    await fs.writeFile(stationWorkbookPath, Buffer.from(await response.arrayBuffer()));
  }

  const workbook = XLSX.readFile(stationWorkbookPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const grouped = new Map();

  for (const row of rows) {
    const stationName = normalizeStationName(row["역사명"]);
    const lat = Number(row["역위도"]);
    const lng = Number(row["역경도"]);

    if (!stationName || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    const key = stationGroupKey({ ...row, 역사명: stationName });
    const lineName = sanitizeText(row["노선명"]);
    const stationId = sanitizeText(row["역번호"]);
    const current = grouped.get(key);

    if (current) {
      if (lineName && !current.lineNames.includes(lineName)) {
        current.lineNames.push(lineName);
      }

      if (stationId && !current.stationIds.includes(stationId)) {
        current.stationIds.push(stationId);
      }

      continue;
    }

    grouped.set(key, {
      id: stationId || `KRIC-${grouped.size + 1}`,
      stationIds: stationId ? [stationId] : [],
      stationName,
      lineNames: lineName ? [lineName] : [],
      lat,
      lng,
      source: "KRIC_전체_도시철도역사정보_20260228",
    });
  }

  const headers = ["id", "station_name", "line_name", "station_type", "lat", "lng", "source"];
  const records = Array.from(grouped.values())
    .sort((left, right) => left.stationName.localeCompare(right.stationName, "ko-KR"))
    .map((station, index) => [
      station.stationIds.length > 0 ? station.stationIds.join("|") : `KRIC-${index + 1}`,
      station.stationName,
      station.lineNames.join("·") || "도시철도",
      "urban_rail",
      station.lat,
      station.lng,
      station.source,
    ]);

  await fs.writeFile(
    stationsOutputPath,
    [headers, ...records].map((row) => row.map(csvEscape).join(",")).join("\r\n"),
    "utf8",
  );

  return records.length;
}

function adminType(name) {
  const suffix = ["읍", "면", "동"].find((candidate) => name.endsWith(candidate));

  return suffix ?? "동";
}

async function buildAdminGeoJson() {
  const latestVersion = adk.versions().at(-1);
  const collection = await adk.get(latestVersion, "emd");
  const features = collection.features.map((feature) => {
    const props = feature.properties ?? {};
    const originalName = sanitizeText(props.emdnm);

    return {
      type: "Feature",
      properties: {
        id: sanitizeText(props.emdcd ?? props.emd8 ?? props.emd7 ?? ""),
        original_name: originalName,
        type: adminType(originalName),
        sido: sanitizeText(props.sidonm),
        sigungu: sanitizeText(props.sggnm),
        source: `admdongkor_${latestVersion}`,
      },
      geometry: feature.geometry,
    };
  });

  await fs.writeFile(
    adminOutputPath,
    JSON.stringify(
      {
        type: "FeatureCollection",
        features,
      },
      null,
      0,
    ),
    "utf8",
  );

  return { count: features.length, latestVersion };
}

const stationCount = await buildStationsCsv();
const adminResult = await buildAdminGeoJson();

console.log(`stations.csv: ${stationCount} stations`);
console.log(`eupmyeondong.geojson: ${adminResult.count} admin areas (${adminResult.latestVersion})`);
