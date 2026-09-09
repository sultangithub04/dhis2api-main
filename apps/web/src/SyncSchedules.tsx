import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ConnectionSummary, SchemaBlueprintSummary, SyncDefinitionSummary } from "@dhis-sync/contracts";
import { connectionApi, schemaApi, syncApi } from "./api.js";

function displayRunError(message: string): string {
  const unauthorized = message.match(/Current user is not authorized to read data from selected program:\s*([A-Za-z0-9]+)/i);
  if (unauthorized) {
    return `DHIS2 permission denied for Program ${unauthorized[1]}. Grant Program sharing and organisation-unit data-view access, then run the sync again.`;
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

export function SyncSchedules() {
  const [definitions, setDefinitions] = useState<SyncDefinitionSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [blueprints, setBlueprints] = useState<SchemaBlueprintSummary[]>([]);
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [blueprintId, setBlueprintId] = useState("");
  const [batchSize, setBatchSize] = useState(250);
  const [conflictPolicy, setConflictPolicy] = useState<"source_wins" | "destination_wins" | "newest_wins" | "manual">("source_wins");
  const [editing, setEditing] = useState<SyncDefinitionSummary | null>(null);
  const [syncActive, setSyncActive] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [executionLimit, setExecutionLimit] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<SyncDefinitionSummary | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const deletedDefinitionIds = useRef(new Set<string>());

  function excludeDeleted(items: SyncDefinitionSummary[]) {
    return items.filter((item) => !deletedDefinitionIds.current.has(item.id));
  }

  async function load() {
    try {
      const [runs, endpoints, schemas] = await Promise.all([syncApi.list(), connectionApi.list(), schemaApi.list()]);
      setDefinitions(excludeDeleted(runs)); setConnections(endpoints.filter((item) => item.lastTestStatus === "healthy"));
      setBlueprints(schemas.filter((item) => item.status === "applied")); setError(null);
      if (!connectionId && endpoints[0]) setConnectionId(endpoints[0].id);
      if (!blueprintId && schemas.find((item) => item.status === "applied")) setBlueprintId(schemas.find((item) => item.status === "applied")!.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load synchronization settings"); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void syncApi.list().then((items) => setDefinitions(excludeDeleted(items))).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, []);
  const selectedBlueprint = useMemo(() => blueprints.find((item) => item.id === blueprintId), [blueprints, blueprintId]);
  const runningDefinition = definitions.find((item) => busy === `run-${item.id}` || item.latestRun?.status === "running");

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy("create"); setError(null); setNotice(null);
    try {
      const saved = editing
        ? await syncApi.update(editing.id, { name, sourceConnectionId: connectionId, blueprintId, batchSize, conflictPolicy, isActive: syncActive })
        : await syncApi.create({ name, sourceConnectionId: connectionId, blueprintId, batchSize, conflictPolicy, filters: {} });
      setDefinitions((current) => editing ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      if (editing?.schedule) {
        const scheduled = await syncApi.schedule(saved.id, { intervalMinutes, executionLimit: executionLimit ? Number(executionLimit) : null, isActive: editing.schedule.isActive, timezone: editing.schedule.timezone });
        setDefinitions((current) => current.map((item) => item.id === scheduled.id ? scheduled : item));
      }
      setName(""); setEditing(null); setConflictPolicy("source_wins");
      setNotice(editing ? `Sync "${saved.name}" was updated.` : `Sync "${saved.name}" is ready. Run it manually or add a schedule.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create sync"); }
    finally { setBusy(""); }
  }

  function startEdit(item: SyncDefinitionSummary) {
    setEditing(item); setName(item.name); setConnectionId(item.sourceConnectionId); setBlueprintId(item.blueprintId);
    setBatchSize(item.batchSize); setConflictPolicy(item.conflictPolicy as typeof conflictPolicy);
    setSyncActive(item.isActive);
    setIntervalMinutes(item.schedule?.intervalMinutes ?? 60); setExecutionLimit(item.schedule?.executionLimit?.toString() ?? "");
    setError(null); setNotice(null); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditing(null); setName(""); setBatchSize(250); setConflictPolicy("source_wins"); setSyncActive(true);
  }

  async function run(item: SyncDefinitionSummary) {
    setBusy(`run-${item.id}`); setError(null); setNotice(null);
    try {
      const updated = await syncApi.run(item.id);
      setDefinitions((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      const outcome = updated.latestRun;
      if (outcome?.status === "failed") setError(outcome.errorSummary ?? "Synchronization failed");
      else setNotice(`${updated.name}: read ${outcome?.recordsRead ?? 0}, wrote ${outcome?.recordsWritten ?? 0} records.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Synchronization failed"); }
    finally { setBusy(""); }
  }

  async function schedule(item: SyncDefinitionSummary, active = true) {
    setBusy(`schedule-${item.id}`); setError(null);
    try {
      const updated = await syncApi.schedule(item.id, { intervalMinutes, executionLimit: executionLimit ? Number(executionLimit) : null, isActive: active, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
      setDefinitions((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      setNotice(active ? `Schedule activated. The first run is queued now, then every ${intervalMinutes} minute(s).` : "Schedule paused.");
      if (active) window.setTimeout(() => void syncApi.list().then((items) => setDefinitions(excludeDeleted(items))), 1_500);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save schedule"); }
    finally { setBusy(""); }
  }

  async function deleteSchedule(item: SyncDefinitionSummary) {
    if (!window.confirm(`Delete the schedule for "${item.name}"? The sync definition and run history will remain.`)) return;
    setBusy(`delete-schedule-${item.id}`); setError(null); setNotice(null);
    try {
      await syncApi.deleteSchedule(item.id);
      setDefinitions((current) => current.map((entry) => entry.id === item.id ? { ...entry, schedule: null } : entry));
      setNotice(`Schedule for "${item.name}" was deleted.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete schedule"); }
    finally { setBusy(""); }
  }

  async function clearRuns(item: SyncDefinitionSummary) {
    if (!window.confirm(`Delete all run history for "${item.name}"?`)) return;
    setBusy(`clear-runs-${item.id}`); setError(null); setNotice(null);
    try {
      const result = await syncApi.clearRuns(item.id);
      setDefinitions((current) => current.map((entry) => entry.id === item.id ? { ...entry, latestRun: null } : entry));
      setNotice(`Deleted ${result.deleted} run history record(s).`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clear run history"); }
    finally { setBusy(""); }
  }

  async function deleteSync(item: SyncDefinitionSummary) {
    if (deleteConfirmation.trim() !== item.name) return;
    setBusy(`delete-${item.id}`); setError(null); setNotice(null);
    try {
      await syncApi.delete(item.id, item.name);
      deletedDefinitionIds.current.add(item.id);
      setDefinitions((current) => current.filter((entry) => entry.id !== item.id));
      setDeleteCandidate(null); setDeleteConfirmation("");
      setNotice(`Sync "${item.name}" was deleted.`);
    } catch (cause) {
      // A proxy or browser can lose the response after the API has committed the delete.
      // Reconcile once so retrying does not leave a successfully deleted row on screen.
      try {
        const latest = await syncApi.list();
        if (!latest.some((entry) => entry.id === item.id)) {
          deletedDefinitionIds.current.add(item.id);
          setDefinitions((current) => current.filter((entry) => entry.id !== item.id));
          setDeleteCandidate(null); setDeleteConfirmation("");
          setNotice(`Sync "${item.name}" was deleted.`);
          return;
        }
        setDefinitions(excludeDeleted(latest));
      } catch {
        // Preserve the original delete error because it is the most relevant failure.
      }
      setDeleteCandidate(null); setDeleteConfirmation("");
      setError(cause instanceof Error ? cause.message : "Could not delete sync");
    }
    finally { setBusy(""); }
  }

  return <main className="content" id="main-content">
    <header className="page-header"><div><p className="eyebrow">Automation</p><h1>Synchronization engine</h1><p className="lede">Pull DHIS2 tracker or aggregate data into the generated relational tables. Run on demand or configure a controlled recurring interval.</p></div></header>
    {error && <div className="alert alert--error"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
    {notice && <div className="alert alert--success"><strong>Synchronization updated.</strong><span>{notice}</span></div>}
    <section className="summary-grid"><article className="metric"><span>Sync definitions</span><strong>{definitions.length}</strong><small>Configured data flows</small></article><article className="metric"><span>Active schedules</span><strong>{definitions.filter((item) => item.schedule?.isActive).length}</strong><small>Scheduler checks every 5 seconds</small></article><article className="metric"><span>Successful latest runs</span><strong>{definitions.filter((item) => item.latestRun?.status === "succeeded").length}</strong><small>Most recent outcome</small></article></section>
    <section className="panel"><div className="panel-heading"><div><p className="step">{editing ? "Edit data flow" : "New data flow"}</p><h2>{editing ? `Edit ${editing.name}` : "Create synchronization"}</h2></div><span className="secure-note">Full refresh with audit history</span></div>
      <form className="builder-form" onSubmit={create}><div className="form-grid"><label><span>Sync name</span><input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="Kala-azar tracker import" /></label><label><span>Source connection</span><select required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>{connections.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>Applied table</span><select required value={blueprintId} onChange={(event) => setBlueprintId(event.target.value)}>{blueprints.map((item) => <option value={item.id} key={item.id}>{item.resourceName} · {item.tableName}</option>)}</select><small>{selectedBlueprint ? `${selectedBlueprint.columns.length} mapped columns` : "Apply a schema first."}</small></label><label><span>Batch size</span><input type="number" min={1} max={1000} value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} /></label><label><span>Conflict policy</span><select value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as typeof conflictPolicy)}><option value="source_wins">Source wins</option><option value="newest_wins">Newest wins</option><option value="destination_wins">Destination wins</option><option value="manual">Manual review</option></select></label>{editing?.schedule && <><label><span>Schedule interval (minutes)</span><input type="number" min={1} max={525600} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label><label><span>Schedule execution limit</span><input type="number" min={1} value={executionLimit} onChange={(event) => setExecutionLimit(event.target.value)} placeholder="No limit" /></label></>}{editing && <label className="checkbox-label span-2"><input type="checkbox" checked={syncActive} onChange={(event) => setSyncActive(event.target.checked)} /><span>Sync definition is active</span></label>}</div><div className="form-actions">{editing && <button type="button" className="button button--quiet" onClick={cancelEdit}>Cancel</button>}<button className="button button--primary" disabled={!blueprintId || busy === "create"}>{busy === "create" ? "Saving…" : editing ? "Save changes" : "Create sync"}</button></div></form>
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="step">Cron manager</p><h2>Sync command list</h2></div><button className="text-button" onClick={() => void load()}>Refresh</button></div>
      <div className="schedule-controls"><label>Default interval <input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /> minutes</label><label>Execution limit <input type="number" min={1} value={executionLimit} onChange={(event) => setExecutionLimit(event.target.value)} placeholder="No limit" /></label></div>
      {runningDefinition && <div className="sync-running" role="status" aria-live="polite"><div><strong>Running {runningDefinition.name}</strong><span>Reading DHIS2 data and writing the reporting table. You can leave this page open while it completes.</span></div><progress aria-label={`${runningDefinition.name} synchronization in progress`} /></div>}
      {definitions.length === 0 ? <div className="empty"><div className="empty-icon">◴</div><h3>No synchronization commands</h3><p>Create a data flow above after applying a schema.</p></div> : <div className="table-wrap"><table className="sync-table"><colgroup><col className="sync-col-name" /><col className="sync-col-run" /><col className="sync-col-source" /><col className="sync-col-table" /><col className="sync-col-schedule" /><col className="sync-col-status" /><col className="sync-col-progress" /><col className="sync-col-manage" /></colgroup><thead><tr><th>Name</th><th>Run</th><th>Source</th><th>Table</th><th>Schedule</th><th>Status / next run</th><th>Progress</th><th>Manage</th></tr></thead><tbody>{definitions.map((item) => {
        const itemRunning = busy === `run-${item.id}` || item.latestRun?.status === "running";
        const latestStatus = itemRunning ? "running" : item.latestRun?.status ?? "not started";
        return <tr key={item.id}>
          <td><strong>{item.name}</strong><small>{item.resourceName}</small></td>
          <td><button className="button button--primary sync-run-button" disabled={Boolean(busy) || itemRunning} onClick={() => void run(item)}>{itemRunning ? "Running…" : "Run schedule now"}</button></td>
          <td>{item.sourceConnectionName}</td><td><code>{item.tableName}</code></td>
          <td>{item.schedule ? <><strong>{item.schedule.intervalMinutes} min</strong><small>{item.schedule.executionCount}/{item.schedule.executionLimit ?? "∞"} executions</small></> : <><strong>Manual only</strong><small>Add a schedule to automate</small></>}</td>
          <td><span className={`status status--${item.schedule?.isActive ? "healthy" : "untested"}`}><span />{item.schedule ? item.schedule.isActive ? "Active" : "Paused" : "Manual"}</span><small>{item.schedule?.nextRunAt ? `Next: ${new Date(item.schedule.nextRunAt).toLocaleString()}` : item.schedule ? "No next run" : "No schedule"}</small></td>
          <td><div className="sync-progress-cell">{itemRunning ? <progress className="sync-progress" aria-label={`${item.name} synchronization in progress`} /> : <progress className={`sync-progress sync-progress--${item.latestRun?.status ?? "idle"}`} aria-label={`${item.name} latest synchronization ${latestStatus}`} value={item.latestRun ? 100 : 0} max={100} />}<strong>{latestStatus}</strong><small>{item.latestRun ? `${item.latestRun.recordsWritten} written / ${item.latestRun.recordsRead} read` : "Waiting for first run"}</small>{item.latestRun?.finishedAt && <small>{new Date(item.latestRun.finishedAt).toLocaleString()}</small>}{item.latestRun?.errorSummary && <small className="run-error" title={item.latestRun.errorSummary}>{displayRunError(item.latestRun.errorSummary)}</small>}</div></td>
          <td><div className="row-actions row-actions--wrap"><button className="text-button" disabled={Boolean(busy) || itemRunning} onClick={() => startEdit(item)}>Edit</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void schedule(item, !(item.schedule?.isActive))}>{item.schedule?.isActive ? "Pause schedule" : item.schedule ? "Activate schedule" : "Add schedule"}</button>{item.schedule && <button className="text-button text-button--danger" disabled={Boolean(busy)} onClick={() => void deleteSchedule(item)}>Delete schedule</button>}{item.latestRun && <button className="text-button text-button--danger" disabled={Boolean(busy)} onClick={() => void clearRuns(item)}>Clear history</button>}<button className="text-button text-button--danger" disabled={Boolean(busy)} onClick={() => { setDeleteCandidate(item); setDeleteConfirmation(""); setError(null); setNotice(null); }}>Delete sync</button></div></td>
        </tr>;
      })}</tbody></table></div>}
    </section>
    {deleteCandidate && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setDeleteCandidate(null); setDeleteConfirmation(""); } }}>
      <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-sync-title">
        <p className="step">Permanent deletion</p>
        <h2 id="delete-sync-title">Delete sync “{deleteCandidate.name}”?</h2>
        <p>This removes the sync definition, its schedule, and all run history. The applied data table is not removed.</p>
        <label><span>Type <strong>{deleteCandidate.name}</strong> to confirm</span><input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label>
        <div className="form-actions">
          <button className="button button--quiet" disabled={Boolean(busy)} onClick={() => { setDeleteCandidate(null); setDeleteConfirmation(""); }}>Cancel</button>
          <button className="button button--danger" disabled={deleteConfirmation.trim() !== deleteCandidate.name || Boolean(busy)} onClick={() => void deleteSync(deleteCandidate)}>{busy === `delete-${deleteCandidate.id}` ? "Deleting…" : "Delete sync"}</button>
        </div>
      </section>
    </div>}
  </main>;
}
