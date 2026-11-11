import { SEVERITIES, type Component, type Severity, type Vulnerability } from "./types.js";

/* Parsers for Syft's CycloneDX JSON and Grype's JSON output. Both are tolerant: unknown fields are ignored. */

interface CdxLicense {
  license?: { id?: string; name?: string };
  expression?: string;
}
interface CdxComponent {
  type?: string;
  name?: string;
  version?: string;
  purl?: string;
  licenses?: CdxLicense[];
  components?: CdxComponent[];
}

const OS_TYPES = new Set(["deb", "apk", "rpm", "alpm", "alpine", "debian"]);

/** "pkg:npm/%40scope/name@1.2.3?x=y" -> { type: "npm", key: "npm:@scope/name" } */
export function purlKey(purl: string | undefined | null): { type: string; key: string; name: string } | null {
  if (!purl?.startsWith("pkg:")) return null;
  const body = purl.slice(4).split(/[?#]/)[0] ?? "";
  const at = body.lastIndexOf("@");
  const noVersion = at > body.indexOf("/") ? body.slice(0, at) : body;
  const slash = noVersion.indexOf("/");
  if (slash < 0) return null;
  const type = noVersion.slice(0, slash);
  let name = noVersion.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep raw
  }
  // For OS packages the namespace is the distro (debian/openssl): keep it in the identity, not in the label.
  const label = OS_TYPES.has(type) ? (name.split("/").pop() ?? name) : name;
  return { type, key: `${type}:${name}`, name: label };
}

function licensesOf(c: CdxComponent): string[] {
  const out = new Set<string>();
  for (const l of c.licenses ?? []) {
    const v = l.license?.id ?? l.license?.name ?? l.expression;
    if (v) out.add(v.trim());
  }
  return [...out].sort();
}

/**
 * Flattens a CycloneDX document into library components, grouped by package identity
 * (ecosystem + namespaced name from the purl). Every distinct installed version is kept,
 * because lockfiles commonly hold several versions of the same package.
 */
export function parseCycloneDx(doc: unknown): Map<string, Component[]> {
  const out = new Map<string, Component[]>();
  const walk = (list: CdxComponent[] | undefined) => {
    for (const c of list ?? []) {
      if (c.name && c.type !== "file" && c.type !== "operating-system") {
        const p = purlKey(c.purl);
        const type = p?.type ?? c.type ?? "unknown";
        const key = p?.key ?? `${type}:${c.name}`;
        const version = c.version ?? "";
        const group = out.get(key) ?? [];
        const same = group.find((g) => g.version === version);
        if (same) same.licenses = [...new Set([...same.licenses, ...licensesOf(c)])].sort();
        else group.push({ name: p?.name ?? c.name, type, version, purl: c.purl ?? null, licenses: licensesOf(c) });
        out.set(key, group);
      }
      walk(c.components);
    }
  };
  walk((doc as { components?: CdxComponent[] })?.components);
  return out;
}

interface GrypeMatch {
  vulnerability?: {
    id?: string;
    severity?: string;
    dataSource?: string;
    urls?: string[];
    fix?: { versions?: string[]; state?: string };
  };
  relatedVulnerabilities?: { id?: string }[];
  artifact?: { name?: string; version?: string; type?: string; purl?: string };
}

export function normalizeSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "unknown";
}

/** Identity of a finding across versions: the same advisory on the same package (version ignored). */
export function vulnKey(v: Pick<Vulnerability, "id" | "type" | "package">): string {
  return `${v.id}|${v.type}|${v.package}`;
}

/** Parses Grype JSON into unique findings. */
export function parseGrype(doc: unknown): Map<string, Vulnerability> {
  const out = new Map<string, Vulnerability>();
  for (const m of ((doc as { matches?: GrypeMatch[] })?.matches ?? [])) {
    const id = m.vulnerability?.id;
    const pkg = m.artifact?.name;
    if (!id || !pkg) continue;
    const p = purlKey(m.artifact?.purl);
    const url = [m.vulnerability?.dataSource, ...(m.vulnerability?.urls ?? [])].find((u) => typeof u === "string" && u.startsWith("https://")) ?? null;
    const v: Vulnerability = {
      id,
      aliases: [...new Set((m.relatedVulnerabilities ?? []).map((r) => r.id).filter((x): x is string => !!x && x !== id))].sort(),
      severity: normalizeSeverity(m.vulnerability?.severity),
      // Namespaced name from the purl (e.g. com.acme/core for Maven), so different groups never collide.
      package: p?.name ?? pkg,
      type: p?.type ?? m.artifact?.type ?? "unknown",
      version: m.artifact?.version ?? "",
      fixedIn: m.vulnerability?.fix?.state === "fixed" ? (m.vulnerability.fix.versions ?? []) : [],
      url,
    };
    if (!out.has(vulnKey(v))) out.set(vulnKey(v), v);
  }
  return out;
}
