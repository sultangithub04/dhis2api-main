import { useEffect, useState } from "react";
import type { BackupAvailability, ReportDefinitionSummary } from "@dhis-sync/contracts";
import { API_URL, backupApi, reportApi, schemaApi } from "./api.js";

export function Backups({ navigate }: { navigate: (page: string) => void }) {
  const [reports, setReports] = useState<ReportDefinitionSummary[]>([]);
  const [availability, setAvailability] = useState<Record<string, BackupAvailability>>({});
  const [selectedYears, setSelectedYears] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const items = await reportApi.list();
      setReports(items);
      const available = await Promise.all(items.map((item) => backupApi.years(item.blueprintId)));
      setAvailability(Object.fromEntries(available.map((item) => [item.blueprintId, item])));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load backup sources");
    }
  }

  useEffect(() => { void load(); }, []);

  async function download(item: ReportDefinitionSummary, format: "json" | "csv") {
    setBusy(`download-${item.blueprintId}-${format}`);
    setError(null);
    setNotice(null);
    try {
      const filename = await backupApi.download(item.blueprintId, format, selectedYears[item.blueprintId] ?? "all");
      setNotice(`Downloaded ${filename}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not download tracker data");
    } finally {
      setBusy("");
    }
  }

  async function drop(item: ReportDefinitionSummary) {
    const confirmation = window.prompt(
      `Permanent local table removal. This also deletes every sync definition, schedule, and run history using this table. Type ${item.tableName} to continue.`
    );
    if (confirmation !== item.tableName) return;
    setBusy(`drop-${item.blueprintId}`);
    setError(null);
    setNotice(null);
    try {
      const result = await schemaApi.drop(item.blueprintId, item.tableName, true);
      await load();
      setNotice(
        result.deletedSyncDefinitions
          ? `Table dropped. ${result.deletedSyncDefinitions} dependent sync definition(s) and their history were also deleted.`
          : "Table dropped successfully."
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not drop table");
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  return <main className="content" id="main-content">
    <header className="page-header">
      <div>
        <p className="eyebrow">Data management</p>
        <h1>Backups and table lifecycle</h1>
        <p className="lede">Download tracker or aggregate data by available year, export safe configuration, or retire a generated table. Credentials are never included.</p>
      </div>
      <a className="button button--primary button-link" href={`${API_URL}/backups/configuration.json`}>Download configuration</a>
    </header>
    {error && <div className="alert alert--error"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
    {notice && <div className="alert alert--success"><strong>Data management updated.</strong><span>{notice}</span></div>}
    <section className="panel">
      <div className="panel-heading">
        <div><p className="step">Available exports</p><h2>Relational data tables</h2></div>
        <span className="secure-note">Raw source codes and display names are preserved</span>
      </div>
      {reports.length === 0
        ? <div className="empty"><div className="empty-icon">↓</div><h3>No applied data tables</h3><p>Generate and apply a schema to enable backups.</p></div>
        : <div className="table-wrap"><table>
          <thead><tr><th>Resource</th><th>Table</th><th>Type</th><th>Rows</th><th>Data year</th><th>Actions</th></tr></thead>
          <tbody>{reports.map((item) => {
            const itemBusy = busy.includes(item.blueprintId);
            const years = availability[item.blueprintId]?.years ?? [];
            return <tr key={item.blueprintId}>
              <td><strong>{item.resourceName}</strong></td>
              <td><code>{item.schemaName}.{item.tableName}</code></td>
              <td><span className="role">{item.resourceType === "program" ? "Tracker" : "Data set"}</span></td>
              <td>{item.rowCount.toLocaleString()}</td>
              <td><select
                aria-label={`Backup year for ${item.resourceName}`}
                value={selectedYears[item.blueprintId] ?? "all"}
                onChange={(event) => setSelectedYears((current) => ({ ...current, [item.blueprintId]: event.target.value }))}
              >
                <option value="all">All years</option>
                {years.map((year) => <option value={year} key={year}>{year}</option>)}
              </select></td>
              <td><div className="row-actions row-actions--wrap">
                <button className="text-button" disabled={itemBusy} onClick={() => navigate("schema")}>Edit schema</button>
                <button className="text-button" disabled={itemBusy} onClick={() => void download(item, "json")}>{busy === `download-${item.blueprintId}-json` ? "Downloading…" : "Download JSON"}</button>
                <button className="text-button" disabled={itemBusy} onClick={() => void download(item, "csv")}>{busy === `download-${item.blueprintId}-csv` ? "Downloading…" : "Download CSV"}</button>
                <button className="text-button text-button--danger" disabled={itemBusy} onClick={() => void drop(item)}>{busy === `drop-${item.blueprintId}` ? "Dropping…" : "Drop table"}</button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>
    <section className="panel info-panel"><h2>Reconfigure endpoints dynamically</h2><p>Connections are independent of schemas and sync definitions. Add another source or destination in Connections, verify it, then select it when creating a new blueprint or synchronization flow. Existing snapshots remain reproducible.</p></section>
  </main>;
}
