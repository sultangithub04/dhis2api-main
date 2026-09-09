import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ConnectionSummary, Dhis2ResourceSummary, FlattenStrategy, ResourceType, SchemaBlueprintSummary } from "@dhis-sync/contracts";
import { connectionApi, schemaApi } from "./api.js";

export function SchemaBuilder() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [blueprints, setBlueprints] = useState<SchemaBlueprintSummary[]>([]);
  const [resources, setResources] = useState<Dhis2ResourceSummary[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [resourceType, setResourceType] = useState<ResourceType>("program");
  const [resourceUid, setResourceUid] = useState("");
  const [strategy, setStrategy] = useState<FlattenStrategy>("flattened_latest");
  const [selected, setSelected] = useState<SchemaBlueprintSummary | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [columnEdits, setColumnEdits] = useState<Record<string, { label: string; isFilterable: boolean }>>({});

  async function load() {
    try {
      const [items, schemas] = await Promise.all([connectionApi.list(), schemaApi.list()]);
      setConnections(items.filter((item) => item.lastTestStatus === "healthy"));
      setBlueprints(schemas);
      if (!connectionId && items[0]) setConnectionId(items[0].id);
      setSelected((current) => schemas.find((item) => item.id === current?.id) ?? schemas[0] ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load schema builder"); }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!connectionId) return;
    setBusy("resources"); setResourceUid("");
    schemaApi.resources(connectionId, resourceType)
      .then((items) => { setResources(items); setError(null); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load DHIS2 metadata"))
      .finally(() => setBusy(""));
  }, [connectionId, resourceType]);

  async function generate(event: FormEvent) {
    event.preventDefault(); setBusy("generate"); setError(null); setNotice(null);
    try {
      const created = await schemaApi.generate({ connectionId, resourceType, resourceUid, strategy });
      setBlueprints((current) => [created, ...current]); setSelected(created);
      setNotice(`Generated ${created.columns.length} columns from ${created.resourceName}. Review the preview, then apply it.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Schema generation failed"); }
    finally { setBusy(""); }
  }

  async function applySchema(item: SchemaBlueprintSummary) {
    setBusy(item.id); setError(null);
    try {
      const updated = await schemaApi.apply(item.id);
      setBlueprints((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      setSelected(updated); setNotice(`Created ${updated.schemaName}.${updated.tableName}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not apply schema"); }
    finally { setBusy(""); }
  }

  async function dropSchema(item: SchemaBlueprintSummary) {
    const confirmation = window.prompt(`This removes the local data table and every sync definition, schedule, and run history using it. Type ${item.tableName} to confirm.`);
    if (confirmation !== item.tableName) return;
    setBusy(item.id); setError(null);
    try {
      const result = await schemaApi.drop(item.id, item.tableName, true);
      await load();
      setNotice(`Dropped ${item.schemaName}.${item.tableName}. ${result.deletedSyncDefinitions} dependent sync definition(s) were deleted; metadata snapshots were preserved.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not drop table"); }
    finally { setBusy(""); }
  }

  async function deleteBlueprint(item: SchemaBlueprintSummary) {
    const confirmation = window.prompt(`Delete this blueprint and its metadata snapshot? Type ${item.tableName} to confirm.`);
    if (confirmation !== item.tableName) return;
    setBusy(item.id); setError(null); setNotice(null);
    try {
      await schemaApi.deleteBlueprint(item.id, item.tableName);
      const remaining = blueprints.filter((entry) => entry.id !== item.id);
      setBlueprints(remaining); setSelected(remaining[0] ?? null);
      setNotice(`Blueprint ${item.tableName} was deleted.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete blueprint"); }
    finally { setBusy(""); }
  }

  function startEdit(item: SchemaBlueprintSummary) {
    setColumnEdits(Object.fromEntries(item.columns.map((column) => [column.columnName, { label: column.label, isFilterable: column.isFilterable }])));
    setEditing(true); setError(null); setNotice(null);
  }

  async function saveEdits(item: SchemaBlueprintSummary) {
    setBusy(`edit-${item.id}`); setError(null); setNotice(null);
    try {
      const updated = await schemaApi.update(item.id, {
        columns: item.columns.map((column) => ({ columnName: column.columnName, ...(columnEdits[column.columnName] ?? { label: column.label, isFilterable: column.isFilterable }) }))
      });
      setBlueprints((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setSelected(updated); setEditing(false); setNotice(`Display labels and filters for ${updated.resourceName} were updated.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update schema"); }
    finally { setBusy(""); }
  }

  const selectedResource = useMemo(() => resources.find((item) => item.id === resourceUid), [resources, resourceUid]);

  return <main className="content" id="main-content">
    <header className="page-header"><div><p className="eyebrow">Data modelling</p><h1>Dynamic schema builder</h1><p className="lede">Discover a DHIS2 Program or Data Set and generate an auditable PostgreSQL table. Tracker stages can be flattened into one patient row.</p></div></header>
    {error && <div className="alert alert--error"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
    {notice && <div className="alert alert--success"><strong>Schema updated.</strong><span>{notice}</span></div>}
    <section className="panel"><div className="panel-heading"><div><p className="step">Metadata discovery</p><h2>Generate a table blueprint</h2></div><span className="secure-note">Snapshots are versioned</span></div>
      <form className="builder-form" onSubmit={generate}><div className="form-grid">
        <label><span>Healthy source connection</span><select required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Select connection</option>{connections.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.dhis2Version}</option>)}</select></label>
        <label><span>DHIS2 resource</span><select value={resourceType} onChange={(event) => setResourceType(event.target.value as ResourceType)}><option value="program">Tracker Program</option><option value="dataset">Aggregate Data Set</option></select></label>
        <label className="span-2"><span>Program or Data Set</span><select required value={resourceUid} disabled={busy === "resources"} onChange={(event) => setResourceUid(event.target.value)}><option value="">{busy === "resources" ? "Loading from DHIS2…" : "Select a resource"}</option>{resources.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><small>{selectedResource ? `${selectedResource.stageCount ?? selectedResource.dataElementCount ?? 0} ${resourceType === "program" ? "stages" : "elements"}` : "Pulled live from the selected DHIS2 instance."}</small></label>
        {resourceType === "program" && <label className="span-2"><span>Repeated-stage policy</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as FlattenStrategy)}><option value="flattened_latest">Latest event per stage</option><option value="flattened_first">First event per stage</option><option value="flattened_aggregate">Flattened aggregate representation</option><option value="normalized">Normalized reference model</option></select></label>}
      </div><div className="form-actions"><button className="button button--primary" disabled={!resourceUid || Boolean(busy)}>{busy === "generate" ? "Discovering and generating…" : "Generate blueprint"}</button></div></form>
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="step">Blueprint registry</p><h2>Generated schemas</h2></div><button className="text-button" onClick={() => void load()}>Refresh</button></div>
      {blueprints.length === 0 ? <div className="empty"><div className="empty-icon">▦</div><h3>No schemas generated</h3><p>Select a DHIS2 resource above to start.</p></div> : <div className="split-view"><div className="schema-list">{blueprints.map((item) => <button className={selected?.id === item.id ? "schema-item selected" : "schema-item"} onClick={() => { setSelected(item); setEditing(false); }} key={item.id}><span><strong>{item.resourceName}</strong><small>{item.schemaName}.{item.tableName}</small></span><span className={`pill pill--${item.status}`}>{item.status}</span></button>)}</div>
      {selected && <div className="schema-preview"><div className="preview-head"><div><h3>{selected.resourceName}</h3><p>{selected.columns.length} columns · v{selected.version} · {selected.strategy.replaceAll("_", " ")}</p></div><div className="row-actions">{editing ? <><button className="button button--quiet" disabled={Boolean(busy)} onClick={() => setEditing(false)}>Cancel</button><button className="button button--primary" disabled={Boolean(busy)} onClick={() => void saveEdits(selected)}>{busy === `edit-${selected.id}` ? "Saving…" : "Save labels"}</button></> : <button className="button button--quiet" disabled={Boolean(busy)} onClick={() => startEdit(selected)}>Edit</button>}{!editing && selected.status === "draft" && <button className="button button--primary" disabled={busy === selected.id} onClick={() => void applySchema(selected)}>Apply table</button>}{!editing && selected.status === "applied" && <button className="button button--danger" disabled={busy === selected.id} onClick={() => void dropSchema(selected)}>Drop table</button>}{!editing && selected.status !== "applied" && <button className="button button--danger" disabled={busy === selected.id} onClick={() => void deleteBlueprint(selected)}>Delete blueprint</button>}</div></div>
        <div className="column-list"><table><thead><tr><th>#</th><th>DHIS2 field name</th><th>Type</th><th>Filter</th></tr></thead><tbody>{selected.columns.filter((column) => typeof column.mapping.displayColumnName !== "string").map((column) => <tr key={column.columnName}><td>{column.ordinal}</td><td>{editing ? <input aria-label={`Label for ${column.columnName}`} value={columnEdits[column.columnName]?.label ?? column.label} onChange={(event) => setColumnEdits((current) => ({ ...current, [column.columnName]: { ...(current[column.columnName] ?? { label: column.label, isFilterable: column.isFilterable }), label: event.target.value } }))} /> : column.label}<small><code>{column.columnName}</code></small></td><td><span className="role">{column.sqlType}</span></td><td>{editing ? <input className="compact-checkbox" type="checkbox" aria-label={`Filterable ${column.label}`} checked={columnEdits[column.columnName]?.isFilterable ?? column.isFilterable} onChange={(event) => setColumnEdits((current) => ({ ...current, [column.columnName]: { ...(current[column.columnName] ?? { label: column.label, isFilterable: column.isFilterable }), isFilterable: event.target.checked } }))} /> : column.isFilterable ? "Yes" : ""}</td></tr>)}</tbody></table></div>
        <details className="sql-preview"><summary>SQL preview</summary><pre>{selected.sqlPreview}</pre></details>
      </div>}</div>}
    </section>
  </main>;
}
