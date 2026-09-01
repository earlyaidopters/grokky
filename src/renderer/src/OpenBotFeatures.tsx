import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  ClockCounterClockwise,
  FolderOpen,
  Key,
  Play,
  PlugsConnected,
  Plus,
  SlidersHorizontal,
  Sparkle,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AppSnapshot, Conversation, GeneratedArtifact, Routine, RoutineSchedule } from "../../shared/contracts";

export type FeatureCenterView = "routines" | "attention" | "setup";

function formatDate(value?: number): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === "interval") return `Every ${schedule.minutes} minutes`;
  const days = schedule.weekdays.length === 7
    ? "every day"
    : schedule.weekdays.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  return `${schedule.time} · ${days}`;
}

function ArtifactBody({ artifact }: { artifact: GeneratedArtifact }) {
  if (artifact.kind === "table") {
    return (
      <div className="generated-artifact-table-wrap">
        <table>
          <thead><tr>{artifact.columns?.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{artifact.rows?.map((row, rowIndex) => <tr key={`${artifact.id}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${artifact.id}-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return (
    <div className={`generated-artifact-items kind-${artifact.kind}`}>
      {artifact.items?.map((item, index) => (
        <div className={`generated-artifact-item ${item.status ?? ""}`} key={`${artifact.id}-${index}`}>
          {artifact.kind === "checklist" && <span className="artifact-check">{item.status === "complete" ? "✓" : item.status === "blocked" ? "!" : ""}</span>}
          {artifact.kind === "timeline" && <span className="artifact-node" />}
          <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
          {item.value !== undefined && <em>{item.value}</em>}
        </div>
      ))}
    </div>
  );
}

export function GeneratedArtifacts({ artifacts }: { artifacts?: GeneratedArtifact[] }) {
  if (!artifacts?.length) return null;
  return (
    <div className="generated-artifacts" aria-label="Generated workspace views">
      {artifacts.map((artifact) => (
        <section className={`generated-artifact kind-${artifact.kind}`} key={artifact.id}>
          <header><span>{artifact.kind}</span><h3>{artifact.title}</h3>{artifact.description && <p>{artifact.description}</p>}</header>
          <ArtifactBody artifact={artifact} />
        </section>
      ))}
    </div>
  );
}

function RoutineRow({ routine, snapshot, busy, onBusy, onError }: {
  routine: Routine;
  snapshot: AppSnapshot;
  busy: string;
  onBusy(value: string): void;
  onError(error: string): void;
}) {
  const latestRun = snapshot.routineRuns.find((run) => run.routineId === routine.id);
  const act = async (key: string, action: () => Promise<void>) => {
    onBusy(key);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : "The routine could not be updated");
    } finally {
      onBusy("");
    }
  };
  return (
    <article className={`routine-row ${routine.enabled ? "enabled" : "disabled"}`}>
      <div className="routine-signal"><i /></div>
      <div className="routine-copy">
        <span>{scheduleLabel(routine.schedule)}</span>
        <h3>{routine.name}</h3>
        <p>{routine.instruction}</p>
        <small>{routine.enabled ? `Next ${formatDate(routine.nextRunAt)}` : "Paused"}{latestRun ? ` · Last ${latestRun.status}` : ""}{routine.consecutiveFailures ? ` · ${routine.consecutiveFailures} consecutive failures` : ""}</small>
      </div>
      <div className="routine-actions">
        <button type="button" disabled={Boolean(busy)} title="Run now" onClick={() => void act(`run:${routine.id}`, () => window.grokky.runRoutine(routine.id))}><Play size={14} weight="fill" />Run</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void act(`toggle:${routine.id}`, () => window.grokky.updateRoutine(routine.id, { enabled: !routine.enabled }))}>{routine.enabled ? "Pause" : "Enable"}</button>
        <button className="danger" type="button" disabled={Boolean(busy)} title="Delete routine" aria-label={`Delete ${routine.name}`} onClick={() => {
          if (window.confirm(`Delete “${routine.name}”? Its run history and related attention items will also be removed.`)) void act(`delete:${routine.id}`, () => window.grokky.deleteRoutine(routine.id));
        }}><Trash size={14} /></button>
      </div>
    </article>
  );
}

export function FeatureCenter({ snapshot, conversation, initialView, onClose, onError }: {
  snapshot: AppSnapshot;
  conversation: Conversation;
  initialView: FeatureCenterView;
  onClose(): void;
  onError(error: string): void;
}) {
  const [view, setView] = useState<FeatureCenterView>(initialView);
  const [busy, setBusy] = useState("");
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [scheduleKind, setScheduleKind] = useState<RoutineSchedule["kind"]>("interval");
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const openAttention = snapshot.attention.filter((item) => item.status === "open");
  const routines = useMemo(() => snapshot.routines.slice().sort((left, right) => left.nextRunAt - right.nextRunAt), [snapshot.routines]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Grokky could not complete that action");
    } finally {
      setBusy("");
    }
  };

  const createRoutine = async () => {
    const schedule: RoutineSchedule = scheduleKind === "interval"
      ? { kind: "interval", minutes }
      : { kind: "daily", time, weekdays };
    await runAction("create", async () => {
      await window.grokky.createRoutine({ conversationId: conversation.id, name, instruction, schedule, enabled: true });
      setName("");
      setInstruction("");
    });
  };

  const finishSetup = () => runAction("setup", () => window.grokky.updateSettings({ onboardingComplete: true }));
  const readyProviders = snapshot.providerStatuses.filter((provider) => provider.ready);
  const providerReady = readyProviders.length > 0;

  return (
    <div className="feature-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="feature-center" role="dialog" aria-modal="true" aria-label="Grokky control center">
        <nav className="feature-nav">
          <div className="feature-nav-title"><Sparkle size={18} weight="duotone" /><span><strong>Work control</strong><small>Durable jobs and decisions</small></span></div>
          <button type="button" className={view === "routines" ? "active" : ""} onClick={() => setView("routines")}><ClockCounterClockwise size={17} /><span>Routines</span><em>{snapshot.routines.length}</em></button>
          <button type="button" className={view === "attention" ? "active" : ""} onClick={() => setView("attention")}><WarningCircle size={17} /><span>Attention</span>{openAttention.length > 0 && <em className="warning">{openAttention.length}</em>}</button>
          <button type="button" className={view === "setup" ? "active" : ""} onClick={() => setView("setup")}><SlidersHorizontal size={17} /><span>Quick setup</span>{snapshot.settings.onboardingComplete ? <CheckCircle size={14} /> : <em>!</em>}</button>
        </nav>

        <div className="feature-main">
          <header className="feature-header">
            <div><span>{view === "routines" ? "Persistent work" : view === "attention" ? "Human decisions" : "First-run setup"}</span><h2>{view === "routines" ? "Routines" : view === "attention" ? "Needs attention" : "Ready Grokky for work"}</h2></div>
            <button type="button" title="Close" aria-label="Close work control" onClick={onClose}><X size={18} /></button>
          </header>

          {view === "routines" && (
            <div className="feature-content routines-view">
              <div className="feature-notice"><ClockCounterClockwise size={17} /><span><strong>Runs while Grokky is open</strong><small>Missed windows are logged and skipped, so Grokky never floods you with catch-up work.</small></span></div>
              <section className="routine-builder">
                <div className="routine-builder-heading"><span>New routine</span><strong>Schedule this conversation</strong><small>The routine runs with this chat’s provider, model, workspace, and permanent permissions.</small></div>
                <label><span>Name</span><input value={name} maxLength={80} placeholder="Morning market brief" onChange={(event) => setName(event.target.value)} /></label>
                <label className="routine-instruction"><span>Instruction</span><textarea value={instruction} maxLength={8_000} rows={3} placeholder="Check the sources, summarize what changed, and flag anything requiring my decision." onChange={(event) => setInstruction(event.target.value)} /></label>
                <div className="routine-schedule-controls">
                  <label><span>Cadence</span><select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as RoutineSchedule["kind"])}><option value="interval">Interval</option><option value="daily">Time of day</option></select></label>
                  {scheduleKind === "interval" ? (
                    <label><span>Every (minutes)</span><input type="number" min={15} max={43_200} value={minutes} onChange={(event) => setMinutes(Math.min(43_200, Math.max(15, Number(event.target.value) || 15)))} /></label>
                  ) : (
                    <label><span>Local time</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
                  )}
                </div>
                {scheduleKind === "daily" && <div className="weekday-picker" aria-label="Run on weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((label, day) => <button type="button" aria-pressed={weekdays.includes(day)} className={weekdays.includes(day) ? "selected" : ""} key={`${label}-${day}`} onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort())}>{label}</button>)}</div>}
                <button className="routine-create" type="button" disabled={Boolean(busy) || !name.trim() || !instruction.trim() || (scheduleKind === "daily" && !weekdays.length)} onClick={() => void createRoutine()}><Plus size={15} />{busy === "create" ? "Creating…" : "Create routine"}</button>
              </section>
              <section className="routine-list">
                <header><strong>Your routines</strong><small>{snapshot.scheduler.active ? `Scheduler online${snapshot.scheduler.nextWakeAt ? ` · next wake ${formatDate(snapshot.scheduler.nextWakeAt)}` : ""}` : "Scheduler offline"}</small></header>
                {routines.map((routine) => <RoutineRow key={routine.id} routine={routine} snapshot={snapshot} busy={busy} onBusy={setBusy} onError={onError} />)}
                {!routines.length && <div className="feature-empty"><ClockCounterClockwise size={22} /><strong>No routines yet</strong><small>Turn a repeated prompt into durable work above.</small></div>}
              </section>
            </div>
          )}

          {view === "attention" && (
            <div className="feature-content attention-view">
              <div className="feature-notice"><WarningCircle size={17} /><span><strong>Grokky stops at the trust boundary</strong><small>Unattended work cannot borrow a temporary approval. Questions and failures wait here.</small></span></div>
              <div className="attention-list">
                {openAttention.map((item) => (
                  <article className={`attention-row severity-${item.severity}`} key={item.id}>
                    <WarningCircle size={18} weight={item.severity === "critical" ? "fill" : "regular"} />
                    <span><em>{item.kind.replaceAll("-", " ")} · {formatDate(item.createdAt)}</em><strong>{item.title}</strong><p>{item.detail}</p></span>
                    <div className="attention-actions">
                      {item.conversationId && item.conversationId !== conversation.id && <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`open:${item.id}`, async () => { await window.grokky.setActiveConversation(item.conversationId!); onClose(); })}>Open chat</button>}
                      <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`resolve:${item.id}`, () => window.grokky.resolveAttention(item.id))}><CheckCircle size={15} />Resolve</button>
                    </div>
                  </article>
                ))}
                {!openAttention.length && <div className="feature-empty"><CheckCircle size={24} /><strong>Nothing needs you</strong><small>Routine blockers, human questions, and repeated failures appear here.</small></div>}
              </div>
            </div>
          )}

          {view === "setup" && (
            <div className="feature-content setup-view">
              <div className="setup-hero"><Sparkle size={28} weight="duotone" /><span><em>Three-minute setup</em><h3>Connect the brain, choose its room, set the boundary.</h3><p>You can revisit every choice later. External tools stay off until you explicitly enable them.</p></span></div>
              <div className="setup-checklist">
                <article className={providerReady ? "complete" : ""}><span>{providerReady ? <CheckCircle size={19} /> : <Key size={19} />}</span><div><strong>Model provider</strong><small>{providerReady ? `${readyProviders.map((provider) => provider.label).join(" and ")} ready` : "Sign in to Codex or choose an OpenRouter env file."}</small></div>{!providerReady && <button type="button" onClick={() => void runAction("credential", async () => { await window.grokky.chooseOpenRouterCredential(); await window.grokky.refreshProviderStatuses(); })}>OpenRouter</button>}</article>
                <article className={conversation.projectMode === "project" ? "complete" : ""}><span>{conversation.projectMode === "project" ? <CheckCircle size={19} /> : <FolderOpen size={19} />}</span><div><strong>Working directory</strong><small>{conversation.projectMode === "project" ? conversation.workingDirectory : "Optional: choose the folder this conversation owns."}</small></div><button type="button" onClick={() => void runAction("directory", async () => { await window.grokky.chooseWorkingDirectory(conversation.id); })}>{conversation.projectMode === "project" ? "Change" : "Choose"}</button></article>
                <article className={snapshot.settings.generatedArtifactsEnabled !== false ? "complete" : ""}><span><Sparkle size={19} /></span><div><strong>Structured views</strong><small>Render requested tables, scorecards, checklists, and timelines as native workspace cards.</small></div><button type="button" onClick={() => void runAction("artifacts", () => window.grokky.updateSettings({ generatedArtifactsEnabled: snapshot.settings.generatedArtifactsEnabled === false }))}>{snapshot.settings.generatedArtifactsEnabled === false ? "Enable" : "On"}</button></article>
                <article className={snapshot.settings.openRouterExternalTools ? "complete" : ""}><span><PlugsConnected size={19} /></span><div><strong>OpenRouter MCP tools</strong><small>Expose enabled MCP servers through bounded selection and the External tools permission.</small></div><button type="button" onClick={() => void runAction("external", () => window.grokky.updateSettings({ openRouterExternalTools: !snapshot.settings.openRouterExternalTools }))}>{snapshot.settings.openRouterExternalTools ? "On" : "Enable"}</button></article>
              </div>
              <footer className="setup-footer"><span><strong>{snapshot.settings.onboardingComplete ? "Setup complete" : "Finish when the essentials look right"}</strong><small>Provider access is the only requirement. A project and external tools are optional.</small></span><button className="primary" type="button" disabled={Boolean(busy) || !providerReady} onClick={() => void finishSetup()}><CheckCircle size={15} />{snapshot.settings.onboardingComplete ? "Save setup" : "Finish setup"}</button></footer>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
