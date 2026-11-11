import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low", "negligible", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SeverityCountsSchema = z.object({
  critical: z.number().int(),
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
  negligible: z.number().int(),
  unknown: z.number().int(),
});
export type SeverityCounts = z.infer<typeof SeverityCountsSchema>;

export const VulnerabilitySchema = z.object({
  /** Scanner id, e.g. GHSA-35jh-r3h4-6jhm or CVE-2021-23337. */
  id: z.string(),
  /** Related ids (usually the CVE for a GHSA advisory). */
  aliases: z.array(z.string()),
  severity: z.enum(SEVERITIES),
  package: z.string(),
  /** Ecosystem as reported by the scanner: npm, python, go-module, java-archive, deb ... */
  type: z.string(),
  version: z.string(),
  fixedIn: z.array(z.string()),
  url: z.string().nullable(),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

export const ComponentSchema = z.object({
  name: z.string(),
  type: z.string(),
  version: z.string(),
  purl: z.string().nullable(),
  licenses: z.array(z.string()),
});
export type Component = z.infer<typeof ComponentSchema>;

/** Short summary stored inside release.json (and the GitHub Release tagore.json asset). */
export const SecuritySummarySchema = z.object({
  /** Known vulnerabilities in this version. */
  open: SeverityCountsSchema,
  /** Present in this version but not in the previous one. */
  introduced: SeverityCountsSchema,
  /** Present in the previous version but not in this one. */
  fixed: SeverityCountsSchema,
  components: z.object({
    total: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
});
export type SecuritySummary = z.infer<typeof SecuritySummarySchema>;

/** Full report written as security.json. */
export const SecurityReportSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  previousVersion: z.string().nullable(),
  scannedAt: z.string(),
  tools: z.object({
    syft: z.string().nullable(),
    grype: z.string().nullable(),
  }),
  summary: SecuritySummarySchema,
  introduced: z.array(VulnerabilitySchema),
  fixed: z.array(VulnerabilitySchema),
  open: z.array(VulnerabilitySchema),
  components: z.object({
    added: z.array(ComponentSchema),
    removed: z.array(ComponentSchema),
    changed: z.array(z.object({ name: z.string(), type: z.string(), from: z.string(), to: z.string() })),
  }),
  /** Licenses that appear in this version's dependencies but not in the previous version's. */
  newLicenses: z.array(z.string()),
  /** What was scanned. */
  sources: z
    .object({ repository: z.boolean(), image: z.string().nullable(), previousImage: z.string().nullable() })
    .default({ repository: true, image: null, previousImage: null }),
  /** Limits of this report the reader should know about (e.g. previous image missing). */
  warnings: z.array(z.string()).default([]),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

export const FAIL_ON = ["none", "critical", "high", "medium", "low"] as const;
export type FailOn = (typeof FAIL_ON)[number];
