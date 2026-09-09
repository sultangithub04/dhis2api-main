import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ReportDefinitionSummary, ReportPage, SchemaColumnPreview } from "@dhis-sync/contracts";
import { reportApi } from "./api.js";

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function Reports() {
  const [reports, setReports] = useState<ReportDefinitionSummary[]>([]);
  const [reportId, setReportId] = useState("");
  const [data, setData] = useState<ReportPage | null>(null);
  const [search, setSearch] = useState("");
  const [facility, setFacility] = useState("");
  const [patientId, setPatientId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { reportApi.list().then((items) => { setReports(items); if (items[0]) setReportId(items[0].blueprintId); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load reports")); }, []);
  useEffect(() => {
    if (!reportId) return;
    try { setHiddenColumns(new Set(JSON.parse(localStorage.getItem(`report-columns:${reportId}`) ?? "[]") as string[])); }
    catch { setHiddenColumns(new Set()); }
    setEditingColumns(false);
  }, [reportId]);

  function toggleColumn(columnName: string) {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(columnName)) next.delete(columnName); else next.add(columnName);
      localStorage.setItem(`report-columns:${reportId}`, JSON.stringify([...next]));
      return next;
    });
  }

  function parameters(targetPage = page) {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
    if (search) params.set("search", search); if (facility) params.set("facility", facility);
    if (patientId) params.set("patientId", patientId); if (dateFrom) params.set("dateFrom", dateFrom); if (dateTo) params.set("dateTo", dateTo);
    return params;
  }

  async function load(targetPage = 1) {
    if (!reportId) return;
    setLoading(true); setError(null);
    try { setData(await reportApi.data(reportId, parameters(targetPage))); setPage(targetPage); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load report data"); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (reportId) void load(1); }, [reportId, pageSize]);
  function submit(event: FormEvent) { event.preventDefault(); void load(1); }

  const visibleColumns = useMemo(() => {
    const backendOnly = new Set([
      "record_id", "raw_payload", "sync_run_id", "org_unit_uid",
      "category_option_combo_uid", "attribute_option_combo_uid"
    ]);
    const columns = (data?.columns ?? []).filter((column) =>
      !backendOnly.has(column.columnName) && typeof column.mapping.displayColumnName !== "string" && !hiddenColumns.has(column.columnName)
    );
    if (showAllColumns) return columns;
    const contextNames = new Set(["org_unit_name", "period", "enrollment_date", "incident_date", "source_last_updated_at"]);
    const preferred = columns.filter((column) => contextNames.has(column.columnName) || column.sourceKind !== "system");
    return (preferred.length ? preferred : columns).slice(0, 16);
  }, [data, showAllColumns, hiddenColumns]);
  const configurableColumns = useMemo(() => (data?.columns ?? []).filter((column) => {
    const backendOnly = new Set(["record_id", "raw_payload", "sync_run_id", "org_unit_uid", "category_option_combo_uid", "attribute_option_combo_uid"]);
    return !backendOnly.has(column.columnName) && typeof column.mapping.displayColumnName !== "string";
  }), [data]);
  const selected = reports.find((item) => item.blueprintId === reportId);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return <main className="content content--wide" id="main-content">
    <header className="page-header"><div><p className="eyebrow">Operational reporting</p><h1>Single-line listing reports</h1><p className="lede">One row per tracked entity, with Program attributes and multi-stage events flattened according to the applied schema policy.</p></div><a className="button button--primary button-link" href={reportId ? reportApi.csvUrl(reportId, parameters(1)) : "#"}>Download CSV</a></header>
    {error && <div className="alert alert--error"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
    <section className="panel filter-panel"><div className="panel-heading"><div><p className="step">Advanced search</p><h2>{selected?.resourceName ?? "Select a report"}</h2></div><span className="role">{data?.total ?? selected?.rowCount ?? 0} rows</span></div>
      <form className="report-filters" onSubmit={submit}><label><span>Report</span><select value={reportId} onChange={(event) => setReportId(event.target.value)}>{reports.map((item) => <option value={item.blueprintId} key={item.blueprintId}>{item.resourceName}</option>)}</select></label><label><span>Facility</span><input value={facility} onChange={(event) => setFacility(event.target.value)} placeholder="Name or UID" /></label><label><span>Patient ID</span><input value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="Patient identifier" /></label><label><span>From date</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label><span>To date</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label><label><span>Search all text</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, phone, value…" /></label><div className="filter-actions"><button className="button button--primary" disabled={!reportId || loading}>{loading ? "Loading…" : "View list"}</button><button type="button" className="button button--quiet" onClick={() => { setSearch(""); setFacility(""); setPatientId(""); setDateFrom(""); setDateTo(""); }}>Clear</button></div></form>
    </section>
    <section className="panel report-table"><div className="table-toolbar"><div className="row-actions"><button className="button button--quiet" onClick={() => setShowAllColumns((value) => !value)}>{showAllColumns ? "Show key fields" : "Show all named fields"}</button><button className="button button--quiet" onClick={() => setEditingColumns((value) => !value)}>{editingColumns ? "Done editing" : "Edit columns"}</button></div><label>Rows <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option>20</option><option>50</option><option>100</option><option>250</option></select></label></div>
      {editingColumns && <div className="column-chooser" role="group" aria-label="Report column visibility">{configurableColumns.map((column) => <label key={column.columnName}><input type="checkbox" checked={!hiddenColumns.has(column.columnName)} onChange={() => toggleColumn(column.columnName)} /> <span>{column.label}</span></label>)}<button className="text-button" onClick={() => { setHiddenColumns(new Set()); localStorage.removeItem(`report-columns:${reportId}`); }}>Show every column</button></div>}
      {loading ? <div className="empty">Loading report…</div> : !data?.rows.length ? <div className="empty"><div className="empty-icon">≡</div><h3>No matching records</h3><p>Run the synchronization first, or change the filters.</p></div> : <div className="table-wrap"><table><thead><tr>{visibleColumns.map((column: SchemaColumnPreview) => <th key={column.columnName}>{column.label}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={valueText(row.record_id) || index}>{visibleColumns.map((column) => <td key={column.columnName}>{valueText(row[column.columnName])}</td>)}</tr>)}</tbody></table></div>}
      <div className="pagination"><span>Page {page} of {pages} · {data?.total ?? 0} records</span><div><button className="button button--quiet" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>Previous</button><button className="button button--quiet" disabled={page >= pages || loading} onClick={() => void load(page + 1)}>Next</button></div></div>
    </section>
  </main>;
}
