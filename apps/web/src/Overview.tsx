import { useEffect, useState } from "react";
import type { ConnectionSummary, ReportDefinitionSummary, SyncDefinitionSummary } from "@dhis-sync/contracts";
import { connectionApi, reportApi, syncApi } from "./api.js";

export function Overview({ navigate }: { navigate: (page: string) => void }) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [syncs, setSyncs] = useState<SyncDefinitionSummary[]>([]);
  const [reports, setReports] = useState<ReportDefinitionSummary[]>([]);
  useEffect(() => { void Promise.all([connectionApi.list(), syncApi.list(), reportApi.list()]).then(([a,b,c]) => { setConnections(a); setSyncs(b); setReports(c); }); }, []);
  const totalRows = reports.reduce((sum, report) => sum + report.rowCount, 0);
  return <main className="content" id="main-content"><header className="page-header"><div><p className="eyebrow">System overview</p><h1>DHIS2 interoperability hub</h1><p className="lede">A local control plane for secure connections, metadata-driven tables, scheduled synchronization, and single-line tracker reporting.</p></div></header><section className="summary-grid"><article className="metric"><span>Healthy endpoints</span><strong>{connections.filter((item) => item.lastTestStatus === "healthy").length}</strong><small>of {connections.length} configured</small></article><article className="metric"><span>Data flows</span><strong>{syncs.length}</strong><small>{syncs.filter((item) => item.schedule?.isActive).length} scheduled</small></article><article className="metric"><span>Local report rows</span><strong>{totalRows.toLocaleString()}</strong><small>across {reports.length} tables</small></article></section><section className="workflow-grid"><button onClick={() => navigate("connections")}><span>1</span><strong>Connect DHIS2</strong><small>Verify source and destination APIs</small></button><button onClick={() => navigate("schema")}><span>2</span><strong>Build schema</strong><small>Discover metadata and apply tables</small></button><button onClick={() => navigate("sync")}><span>3</span><strong>Run synchronization</strong><small>Manual and interval-based jobs</small></button><button onClick={() => navigate("reports")}><span>4</span><strong>View reports</strong><small>Filter and export flattened records</small></button></section></main>;
}
