import { useState } from "react";
import { Backups } from "./Backups.js";
import { ConnectionManager } from "./ConnectionManager.js";
import { Overview } from "./Overview.js";
import { Reports } from "./Reports.js";
import { SchemaBuilder } from "./SchemaBuilder.js";
import { SyncSchedules } from "./SyncSchedules.js";

type Page = "overview" | "connections" | "schema" | "sync" | "reports" | "backups";
const navigation: { id: Page; icon: string; label: string }[] = [
  { id: "overview", icon: "⌂", label: "Overview" },
  { id: "connections", icon: "↔", label: "Connections" },
  { id: "schema", icon: "▦", label: "Schema builder" },
  { id: "sync", icon: "◴", label: "Sync schedules" },
  { id: "reports", icon: "≡", label: "Single-line reports" },
  { id: "backups", icon: "↓", label: "Backups" }
];

export function App() {
  const [page, setPage] = useState<Page>("connections");
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = (target: Page) => { setPage(target); setMobileOpen(false); window.scrollTo({ top: 0 }); };
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
      <div className="brand"><span className="brand-mark">D2</span><div><strong>Interoperability</strong><small>DHIS2 data hub</small></div></div>
      <nav aria-label="Primary navigation">{navigation.map((item) => <button type="button" className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)} key={item.id}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-foot"><span className="environment-dot" /> Development environment<small>API v1 · PostgreSQL</small></div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <div className="workspace"><div className="topbar"><button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>☰</button><div className="topbar-status"><span /> Platform operational</div><button className="user-menu"><span>SA</span><div><strong>System Admin</strong><small>Administrator</small></div></button></div>
      {page === "overview" && <Overview navigate={(target) => navigate(target as Page)} />}
      {page === "connections" && <ConnectionManager />}
      {page === "schema" && <SchemaBuilder />}
      {page === "sync" && <SyncSchedules />}
      {page === "reports" && <Reports />}
      {page === "backups" && <Backups navigate={(target) => navigate(target as Page)} />}
    </div>
  </div>;
}
