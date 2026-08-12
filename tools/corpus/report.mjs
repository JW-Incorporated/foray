/* Coverage + dead-links reports, generated from the DB (never hand-written). */

/** Latest-fetch status per source, with area rollups. */
export function coverageData(db) {
  const rows = db.prepare(`
    SELECT s.id, s.area, s.area_name, s.title, s.url, s.source_type, s.read_first,
           d.http_status, d.fetch_notes, d.token_count, d.fetched_at,
           (SELECT COUNT(*) FROM chunks c JOIN documents d2 ON c.document_id = d2.id
             WHERE d2.source_id = s.id) AS chunk_count
    FROM sources s
    LEFT JOIN documents d ON d.id = (
      SELECT id FROM documents WHERE source_id = s.id
      ORDER BY fetched_at DESC, id DESC LIMIT 1
    )
    ORDER BY s.area, s.id
  `).all();

  const areas = new Map();
  for (const r of rows) {
    const a = areas.get(r.area) ?? { area: r.area, name: r.area_name, total: 0, ok: 0, failed: 0, unfetched: 0, chunks: 0, tokens: 0 };
    a.total++;
    if (r.http_status === null) a.unfetched++;
    else if (r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0) a.ok++;
    else a.failed++;
    a.chunks += r.chunk_count ?? 0;
    a.tokens += r.token_count ?? 0;
    areas.set(r.area, a);
  }
  return { rows, areas: [...areas.values()].sort((x, y) => x.area - y.area) };
}

export function coverageMarkdown(db, generatedAt = new Date().toISOString()) {
  const { rows, areas } = coverageData(db);
  const ok = rows.filter((r) => r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0);
  const lines = [
    `# Research corpus — coverage report`,
    ``,
    `Generated ${generatedAt} by \`corpus report\` — do not hand-edit.`,
    ``,
    `**${ok.length}/${rows.length} sources ingested** · ${rows.reduce((n, r) => n + (r.chunk_count ?? 0), 0)} chunks · ~${Math.round(rows.reduce((n, r) => n + (r.token_count ?? 0), 0) / 1000)}k estimated tokens.`,
    ``,
    `| Area | Sources | Ingested | Failed | Unfetched | Chunks | ~Tokens |`,
    `|------|---------|----------|--------|-----------|--------|---------|`,
  ];
  for (const a of areas) {
    lines.push(`| ${a.area}. ${a.name} | ${a.total} | ${a.ok} | ${a.failed} | ${a.unfetched} | ${a.chunks} | ${(a.tokens / 1000).toFixed(1)}k |`);
  }
  lines.push(``, `## Per-source status`, ``);
  for (const a of areas) {
    lines.push(`### ${a.area}. ${a.name}`, ``);
    for (const r of rows.filter((x) => x.area === a.area)) {
      const status =
        r.http_status === null ? "UNFETCHED"
        : r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0 ? `ok (${r.chunk_count} chunks)`
        : r.http_status === -1 ? "robots-blocked"
        : `FAILED (${r.http_status})`;
      lines.push(`- [${status}] ${r.read_first ? "★ " : ""}${r.title} — ${r.url}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

export function deadLinksMarkdown(db, generatedAt = new Date().toISOString()) {
  const { rows } = coverageData(db);
  const dead = rows.filter(
    (r) => r.http_status !== null && !(r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0)
  );
  const lines = [
    `# Research corpus — dead / degraded links`,
    ``,
    `Generated ${generatedAt} by \`corpus report\` — do not hand-edit.`,
    `Policy (PLAN.md): failures are recorded and reported, not worked around.`,
    ``,
  ];
  if (!dead.length) {
    lines.push(`None. Every fetched source produced an indexed document.`);
    return lines.join("\n");
  }
  lines.push(
    `${dead.length} source${dead.length === 1 ? "" : "s"} need${dead.length === 1 ? "s" : ""} attention:`,
    ``
  );
  for (const r of dead) {
    const why =
      r.http_status === -1 ? "blocked by robots.txt"
      : r.http_status === 0 ? "network failure"
      : r.chunk_count === 0 && r.http_status < 300 ? `fetched but produced no chunks`
      : `HTTP ${r.http_status}`;
    lines.push(`- **${r.title}** (area ${r.area})`);
    lines.push(`  - ${r.url}`);
    lines.push(`  - ${why}${r.fetch_notes ? ` — ${r.fetch_notes}` : ""}`);
  }
  return lines.join("\n");
}
