export function buildKeywordVolumeRecommendations(totalCount: number, mobileRatio: number, compIdx: string) {
  const recommendations: string[] = [];
  const normalizedCompetition = compIdx.trim().toUpperCase();

  if (mobileRatio >= 80) {
    recommendations.push("플레이스/모바일");
  }

  if (totalCount >= 1000) {
    recommendations.push("메인 SEO");
  } else if (totalCount >= 100) {
    recommendations.push("서브 SEO");
  } else {
    recommendations.push("롱테일");
  }

  if (compIdx === "높음" || normalizedCompetition === "HIGH") {
    recommendations.push("광고 경쟁 높음");
  } else if (compIdx === "중간" || normalizedCompetition === "MID") {
    recommendations.push("광고 경쟁 보통");
  } else if (compIdx === "낮음" || normalizedCompetition === "LOW") {
    recommendations.push("광고 경쟁 낮음");
  }

  return recommendations;
}
