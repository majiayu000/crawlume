import type { ContentValidation, ExtractedPage } from "./types.js";

const shortContentCharacters = 500;

export function validateContent(extracted: ExtractedPage): ContentValidation {
  const warnings: ContentValidation["warnings"] = [];

  if (extracted.contentCharacters < shortContentCharacters) {
    warnings.push({
      code: "SHORT_CONTENT",
      message: "The extracted content is complete enough to return but unusually short.",
    });
  }

  if (extracted.extractionMethod === "document") {
    warnings.push({
      code: "FALLBACK_EXTRACTION",
      message: "Readability was insufficient, so cleaned document extraction was used.",
    });
  }

  return {
    status: warnings.length === 0 ? "usable" : "uncertain",
    warnings,
  };
}
