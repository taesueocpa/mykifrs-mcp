import type { ToolSpec } from "./spec.js";
import { searchStandards } from "./search-standards.js";
import { searchQnas } from "./search-qnas.js";
import { getParagraph } from "./get-paragraph.js";
import { getQna } from "./get-qna.js";
import { listStandards } from "./list-standards.js";
import { searchMaterials } from "./search-materials.js";
import { getMaterial } from "./get-material.js";

export const TOOLS: ReadonlyArray<ToolSpec<any>> = [
  searchStandards,
  searchQnas,
  getParagraph,
  getQna,
  listStandards,
  searchMaterials,
  getMaterial,
];
