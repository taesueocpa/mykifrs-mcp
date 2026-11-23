const KASB_VIEWER = "https://db.kasb.or.kr";

export function standardUrl(stdNum: number, sectionId: string | null | undefined): string {
  return sectionId ? `${KASB_VIEWER}/s/${stdNum}/${sectionId}` : `${KASB_VIEWER}/s/${stdNum}`;
}

export function qnaUrl(source: string, docNumber: string | null | undefined): string | null {
  return source === "v2" && docNumber ? `${KASB_VIEWER}/qnas/${encodeURIComponent(docNumber)}` : null;
}
