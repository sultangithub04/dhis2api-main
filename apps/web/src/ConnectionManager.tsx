import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AuthType,
  ConnectionRole,
  ConnectionSummary,
  ConnectionTestResult,
  CreateConnectionInput,
  Dhis2Capabilities
} from "@dhis-sync/contracts";
import { connectionApi } from "./api.js";

const emptyForm: CreateConnectionInput = {
  name: "",
  role: "source",
  baseUrl: "",
  authType: "pat",
  apiToken: "",
  username: "",
  password: "",
  testBeforeSave: true
};

function StatusBadge({ status }: { status: ConnectionSummary["lastTestStatus"] }) {
  return <span className={`status status--${status}`}><span />{status}</span>;
}

function CapabilityList({ capabilities }: { capabilities: Dhis2Capabilities | Record<string, never> }) {
  const labels: Record<keyof Dhis2Capabilities, string> = {
    metadataApi: "Metadata",
    dataValueSetsApi: "Data values",
    modernTrackerApi: "Tracker",
    legacyTrackerApi: "Legacy tracker",
    enrollmentAnalyticsApi: "Enrollment analytics",
    pushAnalyticsApi: "Push analytics"
  };
  const entries = Object.entries(capabilities) as [Extract<keyof Dhis2Capabilities, string>, Dhis2Capabilities[keyof Dhis2Capabilities]][];
  if (!entries.length) return <span className="muted">Test to detect capabilities</span>;
  return (
    <div className="capabilities">
      {entries.filter(([, value]) => value.available).map(([key, value]) => (
        <span className="capability" title={`${value.confidence}: ${value.reason}`} key={key}>{labels[key]}</span>
      ))}
    </div>
  );
}

export function ConnectionManager() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [form, setForm] = useState<CreateConnectionInput>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [editing, setEditing] = useState<ConnectionSummary | null>(null);
  const [connectionActive, setConnectionActive] = useState(true);

  const healthyCount = useMemo(
    () => connections.filter((item) => item.lastTestStatus === "healthy").length,
    [connections]
  );

  async function load() {
    try {
      setLoading(true);
      setConnections(await connectionApi.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load connections");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function update<K extends keyof CreateConnectionInput>(key: K, value: CreateConnectionInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setTestResult(null);
  }

  async function runTest() {
    setBusy("test");
    setError(null);
    try {
      setTestResult(await connectionApi.test(form));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection test failed");
    } finally {
      setBusy(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const duplicate = connections.find(
      (connection) => connection.id !== editing?.id && connection.name.trim().toLowerCase() === form.name.trim().toLowerCase()
    );
    if (duplicate) {
      setNotice(null);
      setError(`A connection named "${duplicate.name}" is already saved. Close this form and use Retest on the existing connection, or choose a different name.`);
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = editing
        ? await connectionApi.update(editing.id, { ...form, isActive: connectionActive, testAfterSave: true })
        : await connectionApi.create(form);
      setConnections((current) => editing
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...current]);
      setForm(emptyForm);
      setTestResult(null);
      setShowForm(false);
      setEditing(null);
      setNotice(`Connection "${saved.name}" was ${editing ? "updated" : "saved"} successfully.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save connection");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(connection: ConnectionSummary) {
    setEditing(connection);
    setConnectionActive(connection.isActive);
    setForm({
      name: connection.name, role: connection.role, baseUrl: connection.baseUrl,
      authType: connection.authType, apiToken: "", username: "", password: "", testBeforeSave: true
    });
    setTestResult(null); setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeForm() {
    setEditing(null); setConnectionActive(true); setForm(emptyForm); setTestResult(null); setShowForm(false);
  }

  async function retest(id: string) {
    setBusy(id);
    setError(null);
    try {
      const updated = await connectionApi.testSaved(id);
      setConnections((current) => current.map((item) => item.id === id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection test failed");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteConnection(connection: ConnectionSummary) {
    const confirmation = window.prompt(`Delete connection "${connection.name}"? Type ${connection.name} to confirm.`);
    if (confirmation !== connection.name) return;
    setBusy(connection.id); setError(null); setNotice(null);
    try {
      await connectionApi.delete(connection.id, connection.name);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setNotice(`Connection "${connection.name}" was deleted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete connection");
    } finally { setBusy(null); }
  }

  return (
    <main className="content" id="main-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>DHIS2 connections</h1>
          <p className="lede">Securely connect source and destination instances, then verify their API capabilities.</p>
        </div>
        <button className="button button--primary" onClick={() => showForm ? closeForm() : setShowForm(true)}>
          <span aria-hidden="true">＋</span> {showForm ? "Close form" : "New connection"}
        </button>
      </header>

      <section className="summary-grid" aria-label="Connection summary">
        <article className="metric"><span>Total connections</span><strong>{connections.length}</strong><small>Configured endpoints</small></article>
        <article className="metric"><span>Healthy</span><strong>{healthyCount}</strong><small>Credentials verified</small></article>
        <article className="metric"><span>Needs attention</span><strong>{connections.filter((item) => item.lastTestStatus === "failed").length}</strong><small>Failed latest test</small></article>
      </section>

      {error && <div className="alert alert--error" role="alert"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
      {notice && <div className="alert alert--success" role="status"><strong>Connection saved.</strong><span>{notice}</span></div>}

      {showForm && (
        <section className="panel form-panel">
          <div className="panel-heading"><div><p className="step">Endpoint details</p><h2>{editing ? `Edit ${editing.name}` : "Add a DHIS2 instance"}</h2></div><span className="secure-note">Credentials are encrypted at rest</span></div>
          <form onSubmit={save}>
            <div className="form-grid">
              <label><span>Connection name</span><input required minLength={2} value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="National HMIS production" /></label>
              <label><span>Connection role</span><select value={form.role} onChange={(e) => update("role", e.target.value as ConnectionRole)}><option value="source">Source</option><option value="destination">Destination</option><option value="bidirectional">Bidirectional</option></select></label>
              <label className="span-2"><span>DHIS2 server URL</span><input required type="url" value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://play.dhis2.org/40.2.0" /><small>You may paste an instance URL or a URL ending in /api or /api/40.</small></label>
              <label><span>Authentication</span><select value={form.authType} onChange={(e) => update("authType", e.target.value as AuthType)}><option value="pat">Personal access token</option><option value="basic">Username and password</option></select></label>
              {form.authType === "pat" ? (
                <label><span>API token</span><input required={!editing} type="password" autoComplete="off" value={form.apiToken ?? ""} onChange={(e) => update("apiToken", e.target.value)} placeholder={editing ? "Leave blank to keep current token" : "Paste token"} /></label>
              ) : (
                <><label><span>Username</span><input required={!editing} autoComplete="username" value={form.username ?? ""} onChange={(e) => update("username", e.target.value)} placeholder={editing ? "Leave both blank to keep credentials" : ""} /></label><label><span>Password</span><input required={!editing} type="password" autoComplete="current-password" value={form.password ?? ""} onChange={(e) => update("password", e.target.value)} placeholder={editing ? "Leave both blank to keep credentials" : ""} /></label></>
              )}
              {editing && <label className="checkbox-label span-2"><input type="checkbox" checked={connectionActive} onChange={(event) => setConnectionActive(event.target.checked)} /><span>Connection is active</span></label>}
            </div>
            {testResult && (
              <div className="test-result" aria-live="polite">
                <div><span className="result-icon">✓</span><div><strong>{testResult.systemName ?? "DHIS2 instance"}</strong><p>Version {testResult.dhis2Version ?? "not reported"} · Signed in as {testResult.currentUser?.displayName ?? testResult.currentUser?.username ?? "verified user"}</p></div></div>
                <CapabilityList capabilities={testResult.capabilities} />
              </div>
            )}
            <div className="form-actions">{editing && <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={closeForm}>Cancel</button>}<button className="button button--quiet" type="button" disabled={Boolean(busy) || Boolean(editing && !form.apiToken && !form.password)} onClick={() => void runTest()}>{busy === "test" ? "Testing…" : editing && !form.apiToken && !form.password ? "Enter credentials to test" : "Test connection"}</button><button className="button button--primary" disabled={Boolean(busy)} type="submit">{busy === "save" ? "Saving…" : editing ? "Save changes" : "Save connection"}</button></div>
          </form>
        </section>
      )}

      <section className="panel connections-panel">
        <div className="panel-heading"><div><p className="step">Endpoint registry</p><h2>Configured instances</h2></div><button className="text-button" onClick={() => void load()}>Refresh</button></div>
        {loading ? <div className="empty">Loading connections…</div> : connections.length === 0 ? (
          <div className="empty"><div className="empty-icon">↔</div><h3>No endpoints configured</h3><p>Add the source DHIS2 instance to begin metadata discovery.</p><button className="button button--primary" onClick={() => setShowForm(true)}>Add first connection</button></div>
        ) : (
          <div className="table-wrap"><table><thead><tr><th>Instance</th><th>Role</th><th>Version</th><th>Capabilities</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{connections.map((connection) => (
            <tr key={connection.id}><td><strong>{connection.name}</strong><small>{connection.baseUrl}</small></td><td><span className="role">{connection.role}</span></td><td>{connection.dhis2Version ?? "Unknown"}</td><td><CapabilityList capabilities={connection.capabilities} /></td><td><StatusBadge status={connection.lastTestStatus} /><small>{connection.lastTestedAt ? new Date(connection.lastTestedAt).toLocaleString() : "Not tested"}</small></td><td><div className="row-actions"><button className="text-button" disabled={busy === connection.id} onClick={() => startEdit(connection)}>Edit</button><button className="text-button" disabled={busy === connection.id} onClick={() => void retest(connection.id)}>{busy === connection.id ? "Working…" : "Retest"}</button><button className="text-button text-button--danger" disabled={busy === connection.id} onClick={() => void deleteConnection(connection)}>Delete</button></div></td></tr>
          ))}</tbody></table></div>
        )}
      </section>
    </main>
  );
}
