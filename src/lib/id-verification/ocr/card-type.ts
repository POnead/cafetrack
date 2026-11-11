import type { IdDocType } from "../types";

export type CardTypeDetection = {
  type: IdDocType | null;
  confidence: "none" | "low" | "high";
  evidence: string[];
};

const MARKERS: Array<{ type: IdDocType; markers: RegExp[] }> = [
  {
    type: "philsys",
    markers: [
      /\bPHILSYS\b/i,
      /\bPAMBANSANG\s+(?:PAGKAKAKILANLAN|ID)\b/i,
      /\bPHILIPPINE\s+(?:IDENTIFICATION|IDENTITY)\s+SYSTEM\b/i,
      /\bPAMBANSANG\s+PAGKAKAKILANLAN\b/i,
      /\bPSN\s*:?\s*\d{4}/i,
    ],
  },
  {
    type: "lto_license",
    markers: [
      /\bLAND\s+TRANSPORTATION\s+OFFICE\b/i,
      /\bDRIVER(?:['’]S)?\s*(?:S)?\s*LICENSE\b/i,
      /\bLTO\s+(?:LICENSE|DL)\b/i,
    ],
  },
  {
    type: "passport",
    markers: [
      /\bPASSPORT\b/i,
      /\bP<PHL\b/i,
      /\bDEPARTMENT\s+OF\s+FOREIGN\s+AFFAIRS\b/i,
    ],
  },
  {
    type: "sss",
    markers: [
      /\bSOCIAL\s+SECURITY\s+SYSTEM\b/i,
      /\bSSS\s+(?:ID|NUMBER)\b/i,
    ],
  },
  {
    type: "umid",
    markers: [
      /\bUNIFIED\s+MULTI[- ]PURPOSE\s+ID\b/i,
      /\bUMID\b/i,
    ],
  },
  {
    type: "philhealth",
    markers: [
      /\bPHILHEALTH\b/i,
      /\bPHILIPPINE\s+HEALTH\s+INSURANCE\b/i,
    ],
  },
  {
    type: "voters",
    markers: [
      /\bVOTER(?:S|['’]S)?\s+(?:IDENTIFICATION|ID|CERTIFICATE)\b/i,
      /\bCOMMISSION\s+ON\s+ELECTIONS\b/i,
    ],
  },
];

const DISTINCTIVE_MARKERS: Partial<Record<IdDocType, RegExp[]>> = {
  philsys: [
    /\bPHILSYS\b/i,
    /\bPHILIPPINE\s+(?:IDENTIFICATION|IDENTITY)\s+SYSTEM\b/i,
    /\bPAMBANSANG\s+PAGKAKAKILANLAN\b/i,
  ],
  lto_license: [
    /\bLAND\s+TRANSPORTATION\s+OFFICE\b/i,
    /\bDRIVER(?:['’]S)?\s+LICENSE\b/i,
  ],
  passport: [/\bPASSPORT\b/i],
  sss: [/\bSOCIAL\s+SECURITY\s+SYSTEM\b/i, /\bSSS\s+ID\b/i],
  umid: [/\bUNIFIED\s+MULTI[- ]PURPOSE\s+ID\b/i, /\bUMID\b/i],
  philhealth: [/\bPHILHEALTH\b/i],
  voters: [
    /\bVOTER(?:S|['’]S)?\s+(?:IDENTIFICATION|ID|CERTIFICATE)\b/i,
    /\bCOMMISSION\s+ON\s+ELECTIONS\b/i,
  ],
};

export function detectCardType(text: string): CardTypeDetection {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (!normalised) return { type: null, confidence: "none", evidence: [] };

  const hits = MARKERS.map((candidate) => ({
    type: candidate.type,
    evidence: candidate.markers
      .filter((marker) => marker.test(normalised))
      .map((marker) => marker.source),
  })).filter((candidate) => candidate.evidence.length > 0);

  hits.sort((a, b) => b.evidence.length - a.evidence.length);
  const best = hits[0];
  if (!best) return { type: null, confidence: "none", evidence: [] };
  if (hits.length > 1 && hits[1].evidence.length >= best.evidence.length) {
    return { type: null, confidence: "none", evidence: [] };
  }

  return {
    type: best.type,
    confidence:
      best.evidence.length >= 2 ||
      DISTINCTIVE_MARKERS[best.type]?.some((marker) => marker.test(normalised))
        ? "high"
        : "low",
    evidence: best.evidence,
  };
}
