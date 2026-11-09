import type { ToolSpec } from "./spec.js";
import { searchStandards } from "./search-standards.js";
import { searchQnas } from "./search-qnas.js";
import { getParagraph } from "./get-paragraph.js";
import { getQna } from "./get-qna.js";
import { listStandards } from "./list-standards.js";
import { searchMaterials } from "./search-materials.js";
import { getMaterial } from "./get-material.js";

// 배열 순서가 tools/list 순서다. 새 도구는 끝에 붙인다
export const TOOLS: ReadonlyArray<ToolSpec<any>> = [
  searchStandards,
  searchQnas,
  getParagraph,
  getQna,
  listStandards,
  searchMaterials,
  getMaterial,
];
