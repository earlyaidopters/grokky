import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Brain,
  CaretDown,
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  CursorClick,
  DesktopTower,
  Eye,
  FileText,
  FolderOpen,
  GearSix,
  GlobeHemisphereWest,
  ImageSquare,
  FloppyDisk,
  MagnifyingGlass,
  Lightning,
  Monitor,
  PaperPlaneRight,
  PlugsConnected,
  Plus,
  PuzzlePiece,
  Quotes,
  Robot,
  ShieldCheck,
  Sparkle,
  SlidersHorizontal,
  Stop,
  TerminalWindow,
  Trash,
  UserPlus,
  UsersThree,
  WarningCircle,
  WifiHigh,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type {
  AccentPalette,
  ActivityItem,
  AgentDefinition,
  AgentDraft,
  AgentIcon,
  AgentRun,
  AppSnapshot,
  CapabilitiesSnapshot,
  ChatMessage,
  ComputerAccessLevel,
  ComputerApprovalDecision,
  ComputerApprovalRequest,
  ComputerCapabilityId,
  Conversation,
  CrewCommunication,
  ImageAttachment,
  ImageInput,
  ImageMimeType,
  MessagePriority,
  ProviderId,
  ReasoningEffort,
  RunOutcome,
  SandboxMode,
  SkillCapability,
} from "../../shared/contracts";
import { CODEX_MODELS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES } from "../../shared/contracts";
import { requiresDevelopmentCommands, requiresProjectDirectory } from "../../shared/run-preflight";
import { botVariantAt, botVariantForIdentity, type BotVariant } from "./bot-identity";
import { ModelCombobox, SelectMenu, type SelectChoice } from "./Controls";
import { activitiesForDisplay, type DisplayActivity } from "./activity-display";
import { crewRunsForDisplay, crewRunStage, groupCrewCommunications } from "./crew-display";

const OPENROUTER_SUGGESTIONS = [
  "openai/gpt-5.2",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "minimax/minimax-m2",
];

const CODEX_MODEL_CHOICES: Array<SelectChoice<string>> = CODEX_MODELS.map((model) => ({ value: model, label: model }));
const REASONING_CHOICES: Array<SelectChoice<ReasoningEffort>> = [
  { value: "low", label: "Low", detail: "Fast and economical" },
  { value: "medium", label: "Medium", detail: "Balanced for everyday work" },
  { value: "high", label: "High", detail: "Deeper analysis" },
  { value: "xhigh", label: "X-high", detail: "Maximum deliberation" },
];
const OPTIONAL_REASONING_CHOICES: Array<SelectChoice<ReasoningEffort | "">> = [
  { value: "", label: "Inherit from chat" },
  ...REASONING_CHOICES,
];
const SANDBOX_CHOICES: Array<SelectChoice<SandboxMode>> = [
  { value: "workspace-write", label: "Read and write", detail: "Changes stay inside this workspace" },
  { value: "read-only", label: "Read-only", detail: "Inspect without changing files" },
];
const OPTIONAL_MODEL_CHOICES: Array<SelectChoice<string>> = [
  { value: "", label: "Inherit from chat", detail: "Follow the active conversation" },
  ...CODEX_MODEL_CHOICES,
];
const OPTIONAL_SANDBOX_CHOICES: Array<SelectChoice<SandboxMode | "">> = [
  { value: "", label: "Inherit from chat", detail: "Follow the active conversation" },
  ...SANDBOX_CHOICES,
];
const AGENT_SCOPE_CHOICES: Array<SelectChoice<AgentDraft["scope"]>> = [
  { value: "personal", label: "Personal", detail: "Available across your workspaces" },
  { value: "project", label: "This project", detail: "Stored with this workspace" },
];
const COMPUTER_ACCESS_CHOICES: Array<SelectChoice<ComputerAccessLevel>> = [
  { value: "blocked", label: "Blocked", detail: "Never allow this capability" },
  { value: "ask", label: "Ask each time", detail: "Pause for your approval" },
  { value: "allow", label: "Always allow", detail: "Allow within the configured boundary" },
];
const MAX_AGENT_CHOICES: Array<SelectChoice<number>> = Array.from({ length: 8 }, (_, index) => ({
  value: index + 1,
  label: `${index + 1} ${index === 0 ? "worker" : "workers"}`,
}));
const THEME_CHOICES: Array<SelectChoice<AppSnapshot["settings"]["theme"]>> = [
  { value: "system", label: "Follow system", detail: "Match your operating system automatically" },
  { value: "dark", label: "Dark", detail: "Grokky's cinematic workspace" },
  { value: "light", label: "Light", detail: "Bright, high-contrast workspace" },
];
const SIGNAL_PALETTES: Array<{ id: AccentPalette; label: string; detail: string }> = [
  { id: "lime", label: "Acid lime", detail: "Original Grokky signal" },
  { id: "electric-blue", label: "Electric blue", detail: "Blue current on black" },
  { id: "ultraviolet", label: "Ultraviolet", detail: "Cool violet instrument light" },
  { id: "solar-amber", label: "Solar amber", detail: "Warm high-visibility glow" },
  { id: "ice", label: "Ice", detail: "Clean cyan-white signal" },
];

type BotMood = "idle" | "thinking" | "working" | "success" | "error";
type BotSize = "micro" | "xs" | "sm" | "md" | "lg" | "hero";
type SettingsTab = "session" | "computer" | "skills" | "agents" | "mcp" | "connectors";

const BOT_ASSETS: Record<BotVariant, string> = {
  lime: "./mascots/grokky-hero.png",
  cyan: "./mascots/grokky-thinking.png",
  coral: "./mascots/grokky-working.png",
  violet: "./mascots/grokky-thinking.png",
  amber: "./mascots/grokky-working.png",
  mint: "./mascots/grokky-hero.png",
};

const STARTERS: Array<{ prompt: string; title: string; mood: BotMood }> = [
  { prompt: "Map this repository and explain the architecture.", title: "Map this workspace", mood: "thinking" },
  { prompt: "Find the highest-risk technical debt in this workspace.", title: "Find the risky parts", mood: "idle" },
  { prompt: "Build the next useful feature and verify it.", title: "Build the next feature", mood: "working" },
];

const AGENT_TEMPLATES: Array<AgentDraft & { label: string }> = [
  {
    label: "Explorer",
    name: "code_explorer",
    description: "Read-only explorer for tracing code paths and gathering evidence before changes.",
    developerInstructions: "Stay in exploration mode. Trace real execution paths, cite files and symbols, and return concise evidence. Do not edit files.",
    scope: "personal",
    icon: "cyan",
    model: "gpt-5.6-luna",
    reasoning: "medium",
    sandboxMode: "read-only",
  },
  {
    label: "Reviewer",
    name: "reviewer",
    description: "Reviewer focused on correctness, security, regressions, and missing tests.",
    developerInstructions: "Review like an owner. Lead with concrete findings, prioritize real behavior and security risks, and include reproduction steps when possible.",
    scope: "personal",
    icon: "violet",
    model: "gpt-5.6-terra",
    reasoning: "high",
    sandboxMode: "read-only",
  },
  {
    label: "Builder",
    name: "builder",
    description: "Implementation-focused agent for bounded features, fixes, and validation.",
    developerInstructions: "Own the bounded implementation. Keep unrelated files untouched, make defensible changes, run proportionate verification, and report the result.",
    scope: "personal",
    icon: "amber",
    reasoning: "medium",
    sandboxMode: "workspace-write",
  },
  {
    label: "Tester",
    name: "tester",
    description: "Quality agent for reproducing failures, testing edge cases, and collecting evidence.",
    developerInstructions: "Reproduce the behavior before judging it. Exercise normal, empty, error, cancellation, and recovery paths. Report exact steps and observed evidence.",
    scope: "personal",
    icon: "mint",
    model: "gpt-5.6-terra",
    reasoning: "high",
    sandboxMode: "read-only",
  },
];

const AGENT_ICONS: Array<{ id: AgentIcon; label: string }> = [
  { id: "lime", label: "Lime" },
  { id: "cyan", label: "Cyan" },
  { id: "coral", label: "Coral" },
  { id: "violet", label: "Violet" },
  { id: "amber", label: "Amber" },
  { id: "mint", label: "Mint" },
];

function BrandMark({ size = "md", label = "Grokky" }: { size?: "sm" | "md"; label?: string }) {
  return (
    <span className={`brand-mark brand-mark-${size}`} role="img" aria-label={label}>
      <img src="./mascots/grokky-hero.png" alt="" draggable={false} />
    </span>
  );
}

function defaultVariantForMood(mood: BotMood): BotVariant {
  if (mood === "thinking") return "cyan";
  if (mood === "working" || mood === "error") return "coral";
  return "lime";
}

function BotMascot({ mood = "idle", size = "sm", label, className = "", identity, variant }: {
  mood?: BotMood;
  size?: BotSize;
  label?: string;
  className?: string;
  identity?: string;
  variant?: BotVariant;
}) {
  const resolvedVariant = variant ?? (identity ? botVariantForIdentity(identity) : defaultVariantForMood(mood));
  return (
    <span
      className={`bot-mascot bot-${mood} bot-${size} bot-variant-${resolvedVariant} ${className}`.trim()}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <span className="bot-ground" />
      <img src={BOT_ASSETS[resolvedVariant]} alt="" draggable={false} />
    </span>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children, ...props }) => <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function StoredImage({ attachment }: { attachment: ImageAttachment }) {
  const targetRef = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "480px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || source || error) return;
    let active = true;
    void window.grokky.getImageAttachmentData(attachment.id)
      .then((value) => {
        if (active) setSource(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [attachment.id, error, source, visible]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  return (
    <>
      <button
        ref={targetRef}
        className={`message-image ${error ? "is-error" : ""}`}
        type="button"
        title={source ? `Open ${attachment.name}` : attachment.name}
        disabled={!source}
        onClick={() => setExpanded(true)}
      >
        {source ? <img src={source} alt={attachment.name} draggable={false} /> : <span><ImageSquare size={20} />{error ? "Unavailable" : "Loading"}</span>}
        <small>{attachment.name}</small>
      </button>
      {expanded && source && createPortal(
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={() => setExpanded(false)}>
          <button type="button" title="Close image" aria-label="Close image"><X size={18} /></button>
          <img src={source} alt={attachment.name} onClick={(event) => event.stopPropagation()} />
          <span>{attachment.name}</span>
        </div>,
        document.body,
      )}
    </>
  );
}

function MessageImages({ attachments }: { attachments: ImageAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className={`message-images count-${Math.min(attachments.length, 4)}`} aria-label={`${attachments.length} attached ${attachments.length === 1 ? "image" : "images"}`}>
      {attachments.map((attachment) => <StoredImage key={attachment.id} attachment={attachment} />)}
    </div>
  );
}

function messageTextWithImages(content: string, attachments: ImageAttachment[]): string {
  const imageLines = attachments.map((attachment) => `[Image: ${attachment.name}]`).join("\n");
  return [content.trim(), imageLines].filter(Boolean).join("\n\n");
}

function MessageActions({ content, role, attachments = [] }: { content: string; role: ChatMessage["role"]; attachments?: ImageAttachment[] }) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    await navigator.clipboard.writeText(messageTextWithImages(content, attachments));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  function quoteMessage() {
    const quotable = messageTextWithImages(content, attachments);
    const excerpt = quotable.replace(/\s+/g, " ").trim().slice(0, 360);
    window.dispatchEvent(new CustomEvent("grokky:quote", { detail: `> ${excerpt}${quotable.length > excerpt.length ? "…" : ""}\n\n` }));
  }

  return (
    <div className="message-actions" aria-label={`${role === "assistant" ? "Grokky" : "Your"} message actions`}>
      <button type="button" title="Copy message" onClick={() => void copyMessage()}><Copy size={13} />{copied ? "Copied" : "Copy"}</button>
      <button type="button" title="Quote in a follow-up" onClick={quoteMessage}><Quotes size={13} />Reply</button>
    </div>
  );
}

function visibleActivities(activities: ActivityItem[]): ActivityItem[] {
  return activitiesForDisplay(activities);
}

function conversationMood(conversation: Conversation): BotMood {
  if (conversation.error) return "error";
  if (conversation.status === "running") {
    const current = visibleActivities(conversation.activities).at(-1);
    return current?.kind === "reasoning" || !current ? "thinking" : "working";
  }
  return conversation.messages.at(-1)?.role === "assistant" ? "success" : "idle";
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function compactPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length <= 3) return pathname;
  return `…/${parts.slice(-3).join("/")}`;
}

function providerName(provider: ProviderId): string {
  return provider === "codex" ? "Codex" : "OpenRouter";
}

function InlineLoader({ label = "Working", quiet = false }: { label?: string; quiet?: boolean }) {
  return (
    <span className={`inline-loader ${quiet ? "quiet" : ""}`} role="status" aria-label={label}>
      <i /><i /><i />
    </span>
  );
}

function activityIcon(activity: ActivityItem) {
  const props = { size: 15, weight: "regular" as const };
  if (activity.status === "failed") return <WarningCircle {...props} />;
  if (activity.status === "running") return <InlineLoader label={`${activity.label} in progress`} quiet />;
  if (activity.kind === "reasoning") return <Brain {...props} />;
  if (activity.kind === "command") return <TerminalWindow {...props} />;
  if (activity.kind === "files") return <FileText {...props} />;
  if (activity.kind === "plan") return <CheckCircle {...props} />;
  return <Wrench {...props} />;
}

function activityStatusLabel(activity: DisplayActivity): string {
  if (activity.status === "running") return activity.count > 1 ? `${activity.count} actions, still working` : "In progress";
  if (activity.status === "failed") return activity.count > 1 ? `${activity.count} grouped actions, needs attention` : "Needs attention";
  return activity.count > 1 ? `${activity.count} related actions grouped` : "Completed";
}

function ActivityPanel({ activities, running, outcome }: { activities: ActivityItem[]; running: boolean; outcome?: RunOutcome }) {
  const rawVisible = activities.filter((activity) => !activity.detail?.startsWith("Skill descriptions were shortened to fit the skills context budget."));
  const visible = activitiesForDisplay(rawVisible);
  if (!visible.length && !running && !outcome) return null;
  const current = activitiesForDisplay(rawVisible.slice(-1)).at(-1);
  const outcomeLabel = outcome === "blocked"
    ? "Blocked"
    : outcome === "failed"
      ? "Failed"
      : outcome === "stopped"
        ? "Stopped"
        : "Delivered";
  return (
    <section className={`activity-panel outcome-${outcome || "running"}`} aria-label="Agent activity">
      <div className="activity-heading">
        <span className={`activity-live-mark ${running ? "running" : "complete"}`} aria-hidden="true"><i /><i /><i /></span>
        <span><strong>{running ? current?.label || "Preparing the first action" : "Work summary"}</strong><small>{visible.length} {visible.length === 1 ? "phase" : "phases"} · {rawVisible.length} {rawVisible.length === 1 ? "action" : "actions"}</small></span>
        <em>{running ? "Live" : outcomeLabel}</em>
      </div>
      {!visible.length && running && (
        <div className="activity-skeleton" aria-label="Waiting for the first activity">
          <i /><i /><i />
        </div>
      )}
      {visible.length > 0 && (
        <div className="activity-list">
          {visible.map((activity) => (
            <details className={`activity-row kind-${activity.kind} ${activity.status}`} key={activity.id}>
              <summary>
                <span className="activity-icon">{activityIcon(activity)}</span>
                <span className="activity-label"><strong>{activity.label}{activity.count > 1 && <b>×{activity.count}</b>}</strong><small>{activityStatusLabel(activity)}</small></span>
                <time>{timeLabel(activity.createdAt)}</time>
                {activity.detail && <CaretDown size={13} />}
              </summary>
              {activity.detail && <pre>{activity.detail}</pre>}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function MessageList({ conversation, agents }: { conversation: Conversation; agents: AgentDefinition[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestUserIndex = conversation.messages.findLastIndex((message) => message.role === "user");
  const crewVisible = conversation.agentRuns.length > 0
    || (conversation.status === "running" && conversation.selectedAgentIds.length > 0);
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [conversation.messages.length, conversation.activities.length, conversation.agentRuns.length, conversation.crewCommunications.length, conversation.status]);

  return (
    <div className="message-scroll" ref={scrollRef}>
      <div className="message-stack">
        {!conversation.messages.length ? (
          <div className="empty-session">
            <div className="bot-stage" aria-label="Grokky bot crew">
              <div className="bot-stage-halo" />
              <BotMascot mood="thinking" variant="cyan" size="md" label="Explorer bot" className="stage-bot stage-bot-left" />
              <BotMascot mood="idle" variant="lime" size="lg" label="Lead Grokky bot" className="stage-bot stage-bot-center" />
              <BotMascot mood="working" variant="coral" size="md" label="Builder bot" className="stage-bot stage-bot-right" />
            </div>
            <div className="empty-copy">
              <h1>What should Grokky build?</h1>
              <p>Choose a starting point or describe the outcome below.</p>
              <div className="starter-list">
                {STARTERS.map((starter, index) => (
                  <button key={starter.prompt} type="button" onClick={() => window.dispatchEvent(new CustomEvent("grokky:starter", { detail: starter.prompt }))}>
                    <BotMascot mood={starter.mood} variant={botVariantAt(index + 1)} size="xs" />
                    <strong>{starter.title}</strong>
                    <ArrowUpRight className="starter-arrow" size={15} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          conversation.messages.map((message, index) => (
            <article className={`message ${message.role} ${message.role === "user" && index === latestUserIndex && crewVisible ? "with-crew" : ""}`} key={message.id}>
              {message.role === "assistant" && <BotMascot mood="idle" identity={`conversation:${conversation.id}`} size="xs" className="message-avatar" label="Grokky" />}
              <div className="message-body">
                <div className="message-shell">
                  <header>
                    <span>{message.role === "user" ? "You" : "Grokky"}</span>
                    <time>{timeLabel(message.createdAt)}</time>
                  </header>
                  <MessageImages attachments={message.attachments ?? []} />
                  {message.content && <div className="message-content"><MarkdownMessage content={message.content} /></div>}
                  <MessageActions content={message.content} role={message.role} attachments={message.attachments} />
                </div>
                {message.role === "user" && index === latestUserIndex && (
                  <>
                    {crewVisible && <CrewRunPanel conversation={conversation} agents={agents} />}
                    {!crewVisible && <ActivityPanel activities={conversation.activities} running={conversation.status === "running"} outcome={conversation.lastRunOutcome} />}
                  </>
                )}
              </div>
            </article>
          ))
        )}
        {conversation.error && (
          <div className="run-error" role="alert"><WarningCircle size={17} />{conversation.error}</div>
        )}
      </div>
    </div>
  );
}

const activeAgentStatuses = new Set<AgentRun["status"]>(["starting", "working", "waiting"]);

function runMood(run: AgentRun): BotMood {
  if (run.id.startsWith("queued:") || run.id.startsWith("unconfirmed:")) return "thinking";
  if (run.status === "failed" || run.status === "stopped") return "error";
  if (run.status === "completed") return "success";
  if (run.status === "waiting") return "thinking";
  return "working";
}

function CrewRunPanel({ conversation, agents }: { conversation: Conversation; agents: AgentDefinition[] }) {
  const runs = crewRunsForDisplay(conversation, agents);
  const stage = crewRunStage(conversation, runs);
  const now = useLiveNow(stage !== "complete");
  const queued = runs.filter((run) => run.id.startsWith("queued:"));
  const unconfirmed = runs.filter((run) => run.id.startsWith("unconfirmed:"));
  const synthetic = new Set([...queued, ...unconfirmed].map((run) => run.id));
  const active = runs.filter((run) => !synthetic.has(run.id) && activeAgentStatuses.has(run.status));
  const reported = runs.filter((run) => run.status === "completed");
  const failed = runs.filter((run) => run.status === "failed" || run.status === "stopped");
  const communications = conversation.crewCommunications;
  const leadUpdates = conversation.activities
    .filter((activity) => activity.kind === "notice" && activity.label === "Coordinator update" && activity.detail)
    .slice(-3);
  const [expanded, setExpanded] = useState(runs.length > 0);
  const [activeTab, setActiveTab] = useState<"overview" | "messages">("overview");
  const avatarRuns = runs.slice(0, 3);
  const startedAt = runs.length ? Math.min(...runs.map((run) => run.createdAt)) : conversation.updatedAt;
  const finishedAt = runs.length ? Math.max(...runs.map((run) => run.updatedAt)) : conversation.updatedAt;
  const elapsed = formatDuration((stage === "complete" ? finishedAt : now) - startedAt);
  const header = stage === "starting"
    ? { title: `Requesting ${runs.length} specialist${runs.length === 1 ? "" : "s"}`, detail: `Awaiting ${unconfirmed.length} confirmed thread${unconfirmed.length === 1 ? "" : "s"}` }
    : stage === "parallel"
      ? active.length
        ? { title: `${active.length} specialist${active.length === 1 ? "" : "s"} working`, detail: queued.length ? `${queued.length} queued for handoff` : reported.length ? `${reported.length} of ${runs.length} reports received` : "Independent work is live" }
        : { title: "Preparing the next specialist", detail: `${queued.length} queued for handoff` }
      : stage === "synthesizing"
        ? { title: "Grokky is synthesizing", detail: `${reported.length} specialist ${reported.length === 1 ? "report" : "reports"} ready` }
        : conversation.lastRunOutcome === "stopped"
          ? { title: "Crew run stopped", detail: reported.length ? `${reported.length} specialist ${reported.length === 1 ? "report" : "reports"} retained` : "No specialist reports received" }
        : conversation.lastRunOutcome === "blocked" || conversation.lastRunOutcome === "failed"
          ? { title: "Crew needs attention", detail: failed.length ? `${reported.length} reported, ${failed.length} stopped` : `${reported.length} of ${runs.length} confirmed reports received` }
          : { title: "Crew run delivered", detail: `${reported.length} specialist ${reported.length === 1 ? "report" : "reports"} combined` };
  useEffect(() => {
    if (stage !== "complete") setExpanded(true);
  }, [stage, conversation.id]);

  useEffect(() => setActiveTab("overview"), [conversation.id]);

  const selectTab = (tab: "overview" | "messages") => {
    setActiveTab(tab);
    setExpanded(true);
  };

  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, tab: "overview" | "messages") => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    selectTab(tab);
    requestAnimationFrame(() => document.getElementById(`crew-tab-${tab}-${conversation.id}`)?.focus());
  };

  if (!runs.length) return null;
  return (
    <section className={`crew-run-panel stage-${stage} ${stage !== "complete" ? "is-active" : ""}`} aria-label="Crew activity">
      <div className="crew-run-header">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span className="crew-avatar-stack" aria-hidden="true">
            {avatarRuns.map((run) => <BotMascot key={run.id} mood={runMood(run)} identity={run.name || run.id} variant={run.icon} size="xs" />)}
          </span>
          <span><strong>{header.title}</strong><small>{header.detail}</small></span>
          <time>{elapsed}</time>
          <CaretDown size={14} />
        </button>
        {conversation.status === "running" && <button className="crew-stop" type="button" onClick={() => void window.grokky.cancelRun(conversation.id)}><Stop size={12} weight="fill" />Stop</button>}
      </div>
      {expanded && (
        <>
          <div className="crew-tabs" role="tablist" aria-label="Crew details">
            <button
              id={`crew-tab-overview-${conversation.id}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "overview"}
              aria-controls={`crew-panel-overview-${conversation.id}`}
              tabIndex={activeTab === "overview" ? 0 : -1}
              onClick={() => selectTab("overview")}
              onKeyDown={(event) => moveTab(event, "messages")}
            >
              <UsersThree size={13} /><span>Overview</span>
            </button>
            <button
              id={`crew-tab-messages-${conversation.id}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "messages"}
              aria-controls={`crew-panel-messages-${conversation.id}`}
              tabIndex={activeTab === "messages" ? 0 : -1}
              onClick={() => selectTab("messages")}
              onKeyDown={(event) => moveTab(event, "overview")}
            >
              <PaperPlaneRight size={13} /><span>Messages</span><small>{communications.length}</small>
            </button>
          </div>
          {activeTab === "overview" ? (
            <div
              id={`crew-panel-overview-${conversation.id}`}
              className="crew-run-body"
              role="tabpanel"
              aria-labelledby={`crew-tab-overview-${conversation.id}`}
            >
              {leadUpdates.length > 0 && (
                <section className="crew-lead-updates" aria-label="Grokky lead updates">
                  <header><BotMascot mood={stage === "complete" ? "success" : "thinking"} identity="grokky-lead" variant="lime" size="xs" /><span><strong>Grokky lead</strong><small>{stage === "complete" ? "Run notes" : "Coordinating live"}</small></span></header>
                  <ol>
                    {leadUpdates.map((update) => <li key={update.id}><i /><span>{update.detail}</span><time>{timeLabel(update.createdAt)}</time></li>)}
                  </ol>
                </section>
              )}
              <div className="crew-specialist-lane">
                {runs.map((run) => <CrewRunRow key={run.id} run={run} activities={conversation.activities} now={now} />)}
              </div>
              {stage === "synthesizing" && (
                <div className="crew-run-footer">
                  <div className="crew-lead-node stage-synthesizing">
                    <BotMascot mood="thinking" identity="grokky-lead" variant="lime" size="xs" />
                    <span><strong>Grokky lead</strong><small>Resolving the specialist findings into one response</small></span>
                    <em aria-live="polite"><Sparkle size={11} weight="fill" />Synthesizing</em>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <CrewMailbox
              id={`crew-panel-messages-${conversation.id}`}
              labelledBy={`crew-tab-messages-${conversation.id}`}
              communications={communications}
              running={stage !== "complete"}
            />
          )}
        </>
      )}
    </section>
  );
}

function CrewMailbox({ id, labelledBy, communications, running }: { id: string; labelledBy: string; communications: CrewCommunication[]; running: boolean }) {
  const labels: Record<CrewCommunication["kind"], string> = {
    assignment: "Assignment",
    message: "Direct message",
    report: "Specialist report",
    status: "Control signal",
  };
  const groups = groupCrewCommunications(communications);
  return (
    <section id={id} className="crew-mailbox crew-transcript" role="tabpanel" aria-labelledby={labelledBy}>
      {!groups.length ? (
        <div className="crew-mailbox-empty">
          <span aria-hidden="true"><PaperPlaneRight size={18} /></span>
          <div><strong>No crew messages yet</strong><small>The first confirmed assignment will appear here.</small></div>
        </div>
      ) : (
        <ol aria-live="polite">
          {groups.map((group, groupIndex) => {
            const failed = group.entries.some((entry) => entry.status === "failed");
            const reportsOnly = group.entries.every((entry) => entry.kind === "report");
            return (
              <li key={`${group.senderThreadId}:${groupIndex}`} className="crew-message-group">
                <BotMascot mood={failed ? "error" : reportsOnly ? "success" : "working"} identity={group.senderThreadId} variant={group.senderName === "Grokky lead" ? "lime" : undefined} size="xs" />
                <div className="crew-message-group-copy">
                  <header className="crew-message-group-header">
                    <strong>{group.senderName}</strong>
                    {group.entries.length > 1 && <small>{group.entries.length} messages</small>}
                  </header>
                  <div className="crew-message-stack">
                    {group.entries.map((entry) => (
                      <article key={entry.id} className={`crew-transcript-message kind-${entry.kind} status-${entry.status}`}>
                        <header>
                          <span className="crew-message-recipient"><ArrowRight size={10} weight="bold" />{entry.receiverName}</span>
                          <time>{timeLabel(entry.createdAt)}</time>
                        </header>
                        {entry.content && <div className="crew-mailbox-content"><MarkdownMessage content={entry.content} /></div>}
                        <footer>
                          <span>{labels[entry.kind]}</span>
                          {entry.status !== "completed" && <em><i />{entry.status === "failed" ? "Failed" : running ? "In progress" : "Sent"}</em>}
                        </footer>
                      </article>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function CrewRunRow({ run, activities, now }: { run: AgentRun; activities: ActivityItem[]; now: number }) {
  const currentActivity = activities.filter((activity) => activity.id.startsWith(`${run.threadId}:`)).at(-1);
  const queued = run.id.startsWith("queued:");
  const unconfirmed = run.id.startsWith("unconfirmed:");
  const statusLabel = queued
    ? "Queued for handoff"
    : unconfirmed
    ? "Awaiting spawn"
    : run.status === "starting"
      ? "Connecting"
      : run.status === "waiting"
        ? "Reporting"
        : run.status === "completed"
          ? "Reported"
          : run.status === "failed"
            ? "Failed"
            : run.status === "stopped"
              ? "Stopped"
              : "Working";
  const isSynthetic = queued || unconfirmed;
  const isActive = !isSynthetic && activeAgentStatuses.has(run.status);
  const duration = formatDuration((isActive ? now : run.updatedAt) - run.createdAt);
  const content = (
    <>
      <BotMascot mood={runMood(run)} identity={run.name || run.id} variant={run.icon} size="xs" />
      <span><strong>{run.name}<time>{duration}</time></strong><small>{currentActivity ? currentActivity.label : run.task}</small></span>
      <em><i />{statusLabel}</em>
    </>
  );
  const stateClass = queued ? " is-queued" : unconfirmed ? " is-unconfirmed" : "";
  if (!run.result) return <div className={`crew-run-row status-${run.status}${stateClass}`}>{content}</div>;
  return <details className={`crew-run-row status-${run.status}${stateClass}`}><summary>{content}<CaretDown size={13} /></summary><p>{run.result}</p></details>;
}

function CrewPicker({ conversation, agents, enabled, maxAgents, onOpenAgents, onError }: {
  conversation: Conversation;
  agents: AgentDefinition[];
  enabled: boolean;
  maxAgents: number;
  onOpenAgents(): void;
  onError(error: string): void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const available = agents.filter((agent) => agent.id !== "builtin:default");
  const selected = available.filter((agent) => conversation.selectedAgentIds.includes(agent.id));

  useEffect(() => setOpen(false), [conversation.id]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerAway = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOnWindowBlur = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnPointerAway);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerAway);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [open]);

  async function toggle(agent: AgentDefinition) {
    const exists = conversation.selectedAgentIds.includes(agent.id);
    if (!exists && conversation.selectedAgentIds.length >= maxAgents) {
      onError(`This session is capped at ${maxAgents} crew members`);
      return;
    }
    const next = exists
      ? conversation.selectedAgentIds.filter((id) => id !== agent.id)
      : [...conversation.selectedAgentIds, agent.id];
    try {
      await window.grokky.updateConversation(conversation.id, { selectedAgentIds: next });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Crew selection could not be updated");
    }
  }

  return (
    <div className="crew-picker" ref={pickerRef}>
      <button ref={triggerRef} className={`crew-picker-trigger ${selected.length ? "has-crew" : ""}`} type="button" aria-expanded={open} aria-haspopup="dialog" disabled={conversation.status === "running"} onClick={() => setOpen((value) => !value)}>
        <UsersThree size={14} />
        <span>{selected.length ? `Crew ${selected.length}` : "Solo"}</span>
        <CaretDown size={12} />
      </button>
      {open && (
        <div className="crew-picker-popover" role="dialog" aria-label="Choose the crew">
          <header><strong>Choose the crew</strong><small>{conversation.provider === "openrouter" ? "Parallel read-only scouts, then one lead" : "Codex spawns and coordinates these roles"}</small></header>
          {!enabled && <div className="crew-picker-warning"><WarningCircle size={15} />Multi-agent orchestration is disabled.</div>}
          <div className="crew-picker-list">
            {available.map((agent) => {
              const checked = conversation.selectedAgentIds.includes(agent.id);
              return (
                <button key={agent.id} data-agent-id={agent.id} type="button" className={checked ? "selected" : ""} disabled={!enabled} onClick={() => void toggle(agent)}>
                  <BotMascot mood={checked ? "working" : "idle"} identity={agent.name || agent.id} variant={agent.icon} size="xs" />
                  <span><strong>{agent.name}</strong><small>{agent.description}</small></span>
                  {checked ? <CheckCircle size={17} weight="fill" /> : <Plus size={15} />}
                </button>
              );
            })}
          </div>
          <button className="crew-create-link" type="button" onClick={() => { setOpen(false); onOpenAgents(); }}><UserPlus size={15} />Create or edit agents</button>
        </div>
      )}
    </div>
  );
}

function projectName(pathname: string): string {
  return pathname.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || pathname;
}

function ProjectPicker({ conversation, recentDirectories, attention, openRequest, onError }: {
  conversation: Conversation;
  recentDirectories: string[];
  attention: boolean;
  openRequest: number;
  onError(error: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const directories = [...new Set([
    ...(conversation.projectMode === "project" ? [conversation.workingDirectory] : []),
    ...recentDirectories,
  ])];
  const filtered = directories.filter((pathname) => projectName(pathname).toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    setOpen(false);
    setSearch("");
  }, [conversation.id]);

  useEffect(() => {
    if (!openRequest) return;
    setSearch("");
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerAway = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerAway);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerAway);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function selectProject(pathname: string) {
    try {
      await window.grokky.updateConversation(conversation.id, { projectMode: "project", workingDirectory: pathname });
      setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Project could not be selected");
    }
  }

  async function chooseProject() {
    try {
      const pathname = await window.grokky.chooseWorkingDirectory(conversation.id);
      if (pathname) setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Project could not be selected");
    }
  }

  async function clearProject() {
    try {
      await window.grokky.updateConversation(conversation.id, { projectMode: "none" });
      setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Project could not be cleared");
    }
  }

  return (
    <div className="project-picker" ref={pickerRef}>
      <button ref={triggerRef} className={`project-picker-trigger ${conversation.projectMode === "project" ? "has-project" : ""} ${attention ? "needs-attention" : ""}`} type="button" aria-expanded={open} aria-haspopup="dialog" disabled={conversation.status === "running"} onClick={() => setOpen((value) => !value)}>
        <FolderOpen size={14} />
        <span>{conversation.projectMode === "project" ? projectName(conversation.workingDirectory) : "Choose project"}</span>
        <CaretDown size={12} />
      </button>
      {open && (
        <div className="project-picker-popover" role="dialog" aria-label="Choose a project">
          <label className="project-search"><MagnifyingGlass size={15} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>
          <div className="project-picker-list">
            {filtered.map((pathname) => {
              const selected = conversation.projectMode === "project" && pathname === conversation.workingDirectory;
              return (
                <button key={pathname} type="button" className={selected ? "selected" : ""} onClick={() => void selectProject(pathname)} title={pathname}>
                  <FolderOpen size={17} /><span><strong>{projectName(pathname)}</strong><small>{compactPath(pathname)}</small></span>{selected && <CheckCircle size={17} weight="fill" />}
                </button>
              );
            })}
            {!filtered.length && <p>No matching recent projects</p>}
          </div>
          <div className="project-picker-actions">
            <button type="button" onClick={() => void chooseProject()}><Plus size={16} />Choose or create project</button>
            <button type="button" onClick={() => void clearProject()}><X size={16} />Don't work in a project</button>
          </div>
        </div>
      )}
    </div>
  );
}

type ComposerAccess = "read-only" | "workspace" | "full";

function AccessPicker({ conversation, attention, openRequest, onError }: { conversation: Conversation; attention: boolean; openRequest: number; onError(error: string): void }) {
  const value: ComposerAccess = conversation.sandboxMode === "read-only" ? "read-only" : conversation.allowCommands ? "full" : "workspace";
  const choices: Array<{ id: ComposerAccess; label: string; detail: string }> = [
    { id: "read-only", label: "Read only", detail: "Inspect files without changing them" },
    { id: "workspace", label: "Workspace access", detail: "Read and edit files in this project" },
    { id: "full", label: "Full access", detail: "Edit files and run local development commands" },
  ];
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [conversation.id]);
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  async function select(next: ComposerAccess) {
    try {
      await window.grokky.updateConversation(conversation.id, {
        sandboxMode: next === "read-only" ? "read-only" : "workspace-write",
        allowCommands: next === "full",
      });
      setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Access mode could not be updated");
    }
  }

  return (
    <div className="access-picker" ref={pickerRef}>
      <button className={`access-picker-trigger access-${value} ${attention ? "needs-attention" : ""}`} type="button" aria-expanded={open} disabled={conversation.status === "running"} onClick={() => setOpen((current) => !current)}>
        <ShieldCheck size={14} /><span>{choices.find((choice) => choice.id === value)?.label}</span><CaretDown size={12} />
      </button>
      {open && (
        <div className="access-picker-popover" role="menu" aria-label="Choose access mode">
          {choices.map((choice) => (
            <button key={choice.id} type="button" className={choice.id === value ? "selected" : ""} onClick={() => void select(choice.id)}>
              <ShieldCheck size={17} /><span><strong>{choice.label}</strong><small>{choice.detail}</small></span>{choice.id === value && <CheckCircle size={17} weight="fill" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface DraftImage {
  id: string;
  file: File;
  name: string;
  mimeType: ImageMimeType;
  previewUrl: string;
}

const allowedImageTypes = new Set<ImageMimeType>(["image/png", "image/jpeg", "image/webp"]);

function Composer({ conversation, agents, recentDirectories, multiAgentEnabled, maxAgents, webSearchEnabled, onOpenAgents, onError }: {
  conversation: Conversation;
  agents: AgentDefinition[];
  recentDirectories: string[];
  multiAgentEnabled: boolean;
  maxAgents: number;
  webSearchEnabled: boolean;
  onOpenAgents(): void;
  onError(error: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draggingImages, setDraggingImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"project" | "access" | null>(null);
  const [projectOpenRequest, setProjectOpenRequest] = useState(0);
  const [accessOpenRequest, setAccessOpenRequest] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftImagesRef = useRef<DraftImage[]>([]);

  function replaceDraftImages(images: DraftImage[]) {
    draftImagesRef.current = images;
    setDraftImages(images);
  }

  function clearDraftImages() {
    for (const image of draftImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    replaceDraftImages([]);
    if (fileInput.current) fileInput.current.value = "";
  }

  function addImageFiles(files: File[]) {
    if (!files.length) return;
    const current = draftImagesRef.current;
    const available = MAX_IMAGE_ATTACHMENTS - current.length;
    if (available <= 0) {
      onError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
      return;
    }
    const accepted: DraftImage[] = [];
    let totalBytes = current.reduce((total, image) => total + image.file.size, 0);
    for (const file of files) {
      if (accepted.length >= available) {
        onError(`Only the first ${MAX_IMAGE_ATTACHMENTS} images were added`);
        break;
      }
      if (!allowedImageTypes.has(file.type as ImageMimeType)) {
        onError(`${file.name || "That file"} must be PNG, JPEG, or WebP`);
        continue;
      }
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
        onError(`${file.name || "That image"} must be smaller than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
        continue;
      }
      if (totalBytes + file.size > MAX_IMAGE_TOTAL_BYTES) {
        onError("Attached images are too large in total");
        continue;
      }
      const mimeType = file.type as ImageMimeType;
      const fallbackExtension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
      accepted.push({
        id: crypto.randomUUID(),
        file,
        name: file.name || `pasted-image.${fallbackExtension}`,
        mimeType,
        previewUrl: URL.createObjectURL(file),
      });
      totalBytes += file.size;
    }
    if (accepted.length) replaceDraftImages([...current, ...accepted]);
  }

  function removeDraftImage(id: string) {
    const image = draftImagesRef.current.find((item) => item.id === id);
    if (image) URL.revokeObjectURL(image.previewUrl);
    replaceDraftImages(draftImagesRef.current.filter((item) => item.id !== id));
  }

  useEffect(() => {
    const listener = (event: Event) => {
      setDraft((event as CustomEvent<string>).detail);
      requestAnimationFrame(() => textarea.current?.focus());
    };
    const quoteListener = (event: Event) => {
      setDraft((current) => `${(event as CustomEvent<string>).detail}${current}`);
      requestAnimationFrame(() => textarea.current?.focus());
    };
    window.addEventListener("grokky:starter", listener);
    window.addEventListener("grokky:quote", quoteListener);
    return () => {
      window.removeEventListener("grokky:starter", listener);
      window.removeEventListener("grokky:quote", quoteListener);
    };
  }, []);

  useEffect(() => {
    setDraft("");
    clearDraftImages();
    setDraggingImages(false);
    setPreflightTarget(null);
  }, [conversation.id]);

  useEffect(() => () => {
    for (const image of draftImagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(() => {
    if (preflightTarget === "project" && conversation.projectMode === "project") setPreflightTarget(null);
    if (preflightTarget === "access" && conversation.allowCommands) setPreflightTarget(null);
  }, [conversation.projectMode, conversation.allowCommands, preflightTarget]);

  async function submit(priority: MessagePriority = "normal") {
    const value = draft.trim();
    const pendingImages = draftImagesRef.current;
    if ((!value && !pendingImages.length) || submitting) return;
    if (conversation.status !== "running" && conversation.projectMode === "none" && requiresProjectDirectory(value)) {
      setPreflightTarget("project");
      setProjectOpenRequest((request) => request + 1);
      return;
    }
    if (conversation.status !== "running" && requiresDevelopmentCommands(value) && !conversation.allowCommands) {
      setPreflightTarget("access");
      setAccessOpenRequest((request) => request + 1);
      return;
    }
    setPreflightTarget(null);
    setSubmitting(true);
    try {
      const images: ImageInput[] = await Promise.all(pendingImages.map(async (image) => ({
        name: image.name,
        mimeType: image.mimeType,
        data: new Uint8Array(await image.file.arrayBuffer()),
      })));
      await window.grokky.sendMessage(conversation.id, value, priority, images);
      setDraft("");
      clearDraftImages();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Message could not be sent");
    } finally {
      setSubmitting(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addImageFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingImages(false);
    addImageFiles(Array.from(event.dataTransfer.files));
  }

  const canSend = Boolean(draft.trim() || draftImages.length) && !submitting;

  return (
    <div
      className={`composer-wrap ${draggingImages ? "is-dragging-images" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDraggingImages(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImages(false);
      }}
      onDrop={handleDrop}
    >
      {conversation.status === "running" && !conversation.selectedAgentIds.length && <BotMascot mood={conversationMood(conversation)} identity={`conversation:${conversation.id}`} size="sm" className="composer-bot" label="Grokky is working" />}
      {conversation.queuedMessages.length > 0 && (
        <section className="followup-queue" aria-label={`${conversation.queuedMessages.length} queued follow-ups`}>
          <header><span><ClockCounterClockwise size={13} /><strong>Up next</strong></span><small>{conversation.queuedMessages.length} queued</small></header>
          <ol>
            {conversation.queuedMessages.slice(0, 3).map((message) => (
              <li key={message.id} className={message.priority === "priority" ? "priority" : ""}>
                {message.attachments?.length ? <ImageSquare size={12} weight="fill" /> : message.priority === "priority" ? <Lightning size={12} weight="fill" /> : <PaperPlaneRight size={12} />}
                <span>{message.content || `${message.attachments?.length ?? 0} attached ${message.attachments?.length === 1 ? "image" : "images"}`}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className={`composer ${conversation.status === "running" ? "is-running" : ""}`}>
        {draftImages.length > 0 && (
          <div className="composer-image-previews" aria-label={`${draftImages.length} images ready to send`}>
            {draftImages.map((image) => (
              <div className="composer-image-preview" key={image.id}>
                <img src={image.previewUrl} alt="" draggable={false} />
                <span title={image.name}>{image.name}</span>
                <button type="button" title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`} onClick={() => removeDraftImage(image.id)}><X size={12} weight="bold" /></button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInput}
          className="composer-image-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            addImageFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          className="composer-attach-button"
          type="button"
          title="Attach images"
          aria-label="Attach images"
          disabled={submitting || draftImages.length >= MAX_IMAGE_ATTACHMENTS}
          onClick={() => fileInput.current?.click()}
        >
          <ImageSquare size={18} />
          {draftImages.length > 0 && <small>{draftImages.length}</small>}
        </button>
        <textarea
          ref={textarea}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(conversation.status === "running" && event.metaKey ? "priority" : "normal");
            }
          }}
          rows={1}
          placeholder={conversation.status === "running" ? "Add a follow-up while Grokky works…" : "Message Grokky"}
          aria-label="Message Grokky"
        />
        {conversation.status === "running" ? (
          <div className="running-send-actions">
            <button className="priority-send" type="button" title="Redirect now (Command + Enter)" disabled={!canSend} onClick={() => void submit("priority")}><Lightning size={15} weight="fill" /></button>
            <button className="send-button queue-send" type="button" title="Queue after the current turn" disabled={!canSend} onClick={() => void submit("normal")}><PaperPlaneRight size={17} weight="fill" /></button>
          </div>
        ) : (
          <button className="send-button" type="button" title="Send message" disabled={!canSend} onClick={() => void submit()}>
            <PaperPlaneRight size={17} weight="fill" />
          </button>
        )}
      </div>
      <div className="composer-meta">
        <ProjectPicker conversation={conversation} recentDirectories={recentDirectories} attention={preflightTarget === "project"} openRequest={projectOpenRequest} onError={onError} />
        <AccessPicker conversation={conversation} attention={preflightTarget === "access"} openRequest={accessOpenRequest} onError={onError} />
        <CrewPicker conversation={conversation} agents={agents} enabled={multiAgentEnabled} maxAgents={maxAgents} onOpenAgents={onOpenAgents} onError={onError} />
        {conversation.status === "running" && <button className="run-stop-meta" type="button" onClick={() => void window.grokky.cancelRun(conversation.id)}><Stop size={11} weight="fill" />Stop</button>}
        {preflightTarget && <span className="composer-preflight-note"><WarningCircle size={12} />{preflightTarget === "project" ? "Choose a project to continue" : "Choose Full access to continue"}</span>}
        <span className={`web-access-status ${webSearchEnabled ? "enabled" : ""}`} title={webSearchEnabled ? "Live web search is enabled" : "Live web search is disabled"}><GlobeHemisphereWest size={12} />Web {webSearchEnabled ? "on" : "off"}</span>
        <span>{conversation.status === "running" ? "Enter queues · ⌘Enter redirects" : "Enter to send"}</span>
      </div>
    </div>
  );
}

function Switch({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="switch-control">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true"><i /></span>
    </label>
  );
}

function SignalPalette({ value, onChange }: { value: AccentPalette; onChange(value: AccentPalette): void }) {
  return (
    <fieldset className="signal-palette">
      <legend>Signal colour</legend>
      <div className="signal-palette-grid">
        {SIGNAL_PALETTES.map((palette, index) => (
          <button
            key={palette.id}
            type="button"
            data-palette={palette.id}
            className={value === palette.id ? "selected" : ""}
            aria-pressed={value === palette.id}
            aria-label={`${palette.label}: ${palette.detail}`}
            onClick={() => onChange(palette.id)}
          >
            <span className="signal-swatch" aria-hidden="true"><i /><i /></span>
            <span className="signal-palette-copy"><small>{String(index + 1).padStart(2, "0")}</small><strong>{palette.label}</strong></span>
          </button>
        ))}
      </div>
      <p>{SIGNAL_PALETTES.find((palette) => palette.id === value)?.detail}</p>
    </fieldset>
  );
}

function scopeLabel(skill: SkillCapability): string {
  if (skill.scope === "project") return "Project";
  if (skill.scope === "plugin") {
    const parts = skill.path.split("/");
    const cacheIndex = parts.lastIndexOf("cache");
    const version = cacheIndex >= 0 ? parts[cacheIndex + 3] : undefined;
    return version && /^\d/.test(version) ? `Plugin ${version}` : "Plugin";
  }
  if (skill.scope === "system") return "System";
  return "Personal";
}

function ComputerCapabilityIcon({ id }: { id: ComputerCapabilityId }) {
  if (id === "screen") return <Eye size={17} />;
  if (id === "automation") return <CursorClick size={17} />;
  if (id === "browser") return <GlobeHemisphereWest size={17} />;
  if (id === "commands") return <TerminalWindow size={17} />;
  return <FolderOpen size={17} />;
}

function permissionLabel(value: string): string {
  if (value === "not-required") return "No system prompt needed";
  if (value === "not-determined") return "Permission not granted";
  if (value === "unavailable") return "Unavailable on this device";
  return value === "granted" ? "System permission granted" : "System permission denied";
}

function SettingsDialog({ snapshot, conversation, agents, initialTab, onAgentsChange, onClose, onError }: {
  snapshot: AppSnapshot;
  conversation: Conversation;
  agents: AgentDefinition[];
  initialTab: SettingsTab;
  onAgentsChange(agents: AgentDefinition[]): void;
  onClose(): void;
  onError(error: string): void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [capabilities, setCapabilities] = useState<CapabilitiesSnapshot | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [computerBusy, setComputerBusy] = useState("");
  const [pairOpen, setPairOpen] = useState(false);
  const [runnerEndpoint, setRunnerEndpoint] = useState("http://127.0.0.1:4747");
  const [pairingCode, setPairingCode] = useState("");
  const [networkDomains, setNetworkDomains] = useState(snapshot.computerAccess.networkAllowlist.join("\n"));
  const [sessionTitle, setSessionTitle] = useState(conversation.title);
  const [sessionInstructions, setSessionInstructions] = useState(conversation.instructions);
  const [identityBusy, setIdentityBusy] = useState(false);

  useEffect(() => {
    setTab(initialTab);
    void window.grokky.getCapabilities().then(setCapabilities).catch((error) => onError(error instanceof Error ? error.message : "Capabilities could not be loaded"));
  }, [initialTab, onError]);

  useEffect(() => {
    setNetworkDomains(snapshot.computerAccess.networkAllowlist.join("\n"));
  }, [snapshot.computerAccess.networkAllowlist]);

  useEffect(() => {
    setSessionTitle(conversation.title);
    setSessionInstructions(conversation.instructions);
  }, [conversation.id, conversation.title, conversation.instructions]);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return capabilities?.skills ?? [];
    return capabilities?.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.scope}`.toLowerCase().includes(query)) ?? [];
  }, [capabilities?.skills, search]);

  async function patchConversation(value: Parameters<typeof window.grokky.updateConversation>[1]) {
    try {
      await window.grokky.updateConversation(conversation.id, value);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Session could not be updated");
    }
  }

  async function patchSettings(value: Parameters<typeof window.grokky.updateSettings>[0]) {
    try {
      await window.grokky.updateSettings(value);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Settings could not be updated");
    }
  }

  async function saveSessionIdentity() {
    if (!sessionTitle.trim() || identityBusy) return;
    setIdentityBusy(true);
    try {
      await window.grokky.updateConversation(conversation.id, { title: sessionTitle, instructions: sessionInstructions });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Session identity could not be saved");
    } finally {
      setIdentityBusy(false);
    }
  }

  async function toggleCapability(key: string, action: () => Promise<CapabilitiesSnapshot>) {
    setBusy(key);
    try {
      setCapabilities(await action());
    } catch (error) {
      onError(error instanceof Error ? error.message : "Capability could not be updated");
    } finally {
      setBusy("");
    }
  }

  async function computerAction(key: string, action: () => Promise<void>) {
    setComputerBusy(key);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Computer access could not be updated");
    } finally {
      setComputerBusy("");
    }
  }

  async function pairRunner() {
    await computerAction("pair", async () => {
      await window.grokky.pairComputer(runnerEndpoint, pairingCode);
      setPairOpen(false);
      setPairingCode("");
    });
  }

  function beginAgentDraft(template: AgentDraft, editingId: string | null = null) {
    setEditingAgentId(editingId);
    setAgentDraft({ ...template, icon: template.icon ?? botVariantForIdentity(template.name || "default") });
  }

  function editAgent(agent: AgentDefinition) {
    beginAgentDraft({
      name: agent.name,
      description: agent.description,
      developerInstructions: agent.developerInstructions,
      scope: agent.scope === "project" ? "project" : "personal",
      icon: agent.icon ?? botVariantForIdentity(agent.name),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoning ? { reasoning: agent.reasoning } : {}),
      ...(agent.sandboxMode ? { sandboxMode: agent.sandboxMode } : {}),
    }, agent.builtIn ? null : agent.id);
  }

  async function saveAgent() {
    if (!agentDraft) return;
    setAgentBusy(true);
    try {
      const next = editingAgentId
        ? await window.grokky.updateAgent(editingAgentId, agentDraft)
        : await window.grokky.createAgent(agentDraft);
      onAgentsChange(next);
      setAgentDraft(null);
      setEditingAgentId(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Agent could not be saved");
    } finally {
      setAgentBusy(false);
    }
  }

  async function removeAgent() {
    if (!editingAgentId) return;
    const current = agents.find((agent) => agent.id === editingAgentId);
    if (!current || !window.confirm(`Delete ${current.name}? This removes its local agent definition.`)) return;
    setAgentBusy(true);
    try {
      onAgentsChange(await window.grokky.deleteAgent(editingAgentId));
      setAgentDraft(null);
      setEditingAgentId(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Agent could not be deleted");
    } finally {
      setAgentBusy(false);
    }
  }

  const navItems: Array<{ id: SettingsTab; label: string; icon: typeof SlidersHorizontal }> = [
    { id: "session", label: "Session", icon: SlidersHorizontal },
    { id: "computer", label: "Computer access", icon: DesktopTower },
    { id: "agents", label: "Agents", icon: UsersThree },
    { id: "skills", label: "Skills", icon: PuzzlePiece },
    { id: "mcp", label: "MCP servers", icon: PlugsConnected },
    { id: "connectors", label: "Connectors", icon: Robot },
  ];
  const navGroups: Array<{ label: string; items: typeof navItems }> = [
    { label: "Workspace", items: navItems.slice(0, 2) },
    { label: "Orchestration", items: navItems.slice(2, 4) },
    { label: "Extensions", items: navItems.slice(4, 6) },
  ];

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Grokky settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-brand"><BrandMark size="sm" /><strong>Grokky</strong></div>
          <div className="settings-nav-intro">
            <strong>Control room</strong>
            <span>Shape how Grokky works.</span>
          </div>
          <div className="settings-nav-groups">
            {navGroups.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-group-label"><span>{group.label}</span><i /></div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const index = navItems.findIndex((candidate) => candidate.id === item.id) + 1;
                  return (
                    <button key={item.id} type="button" data-settings-view={item.id} className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>
                      <span className="settings-nav-index">{String(index).padStart(2, "0")}</span>
                      <span className="settings-nav-icon"><Icon size={17} weight={tab === item.id ? "duotone" : "regular"} /></span>
                      <span className="settings-nav-copy">{item.label}</span>
                      <span className="settings-nav-marker" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>

        <section className="settings-panel">
          <header className="settings-header">
            <h2>{navItems.find((item) => item.id === tab)?.label}</h2>
            <button className="icon-button" type="button" title="Close settings" onClick={onClose}><X size={18} /></button>
          </header>
          <div className="settings-body">
            {tab === "session" && (
              <div className="settings-stack">
                <section className="session-identity-card">
                  <div className="session-identity-bot"><BotMascot mood={conversationMood(conversation)} identity={`conversation:${conversation.id}`} size="md" /></div>
                  <div className="session-identity-copy"><span>Session identity</span><h3>Name this session</h3><p>Give this chat a stable role. Grokky carries the purpose into every turn.</p></div>
                  <label><span>Name</span><input value={sessionTitle} maxLength={80} disabled={conversation.status === "running"} onChange={(event) => setSessionTitle(event.target.value)} placeholder="Product launch operator" /></label>
                  <label><span>Purpose</span><textarea value={sessionInstructions} maxLength={4_000} rows={3} disabled={conversation.status === "running"} onChange={(event) => setSessionInstructions(event.target.value)} placeholder="What this session owns, how it should work, and what it should never touch." /></label>
                  <footer><small>{sessionInstructions.length.toLocaleString()} / 4,000</small><button className="primary" type="button" disabled={conversation.status === "running" || identityBusy || !sessionTitle.trim() || (sessionTitle.trim() === conversation.title && sessionInstructions.trim() === conversation.instructions)} onClick={() => void saveSessionIdentity()}>{identityBusy ? <InlineLoader label="Saving identity" /> : <FloppyDisk size={14} />}Save identity</button></footer>
                </section>
                <div className="settings-intro"><h3>Workspace</h3><p>Choose where this chat can read and make changes.</p></div>
                <button className="settings-row path-setting" type="button" onClick={() => void window.grokky.chooseWorkingDirectory(conversation.id)}>
                  <span className="settings-row-icon"><FolderOpen size={18} /></span>
                  <span className="settings-copy"><strong>Working directory</strong><small>{conversation.projectMode === "project" ? conversation.workingDirectory : "No project selected"}</small></span>
                  <ArrowUpRight size={15} />
                </button>
                <div className="settings-row path-setting">
                  <span className="settings-row-icon"><Monitor size={18} /></span>
                  <span className="settings-copy"><strong>Appearance</strong><small>Choose how Grokky looks on this computer.</small></span>
                  <SelectMenu value={snapshot.settings.theme} choices={THEME_CHOICES} label="Application appearance" onChange={(theme) => void patchSettings({ theme })} />
                </div>
                <SignalPalette value={snapshot.settings.accentPalette ?? "lime"} onChange={(accentPalette) => void patchSettings({ accentPalette })} />
                <div className="settings-row">
                  <span className="settings-copy"><strong>Workspace permission</strong><small>Control whether Grokky can edit files.</small></span>
                  <SelectMenu value={conversation.sandboxMode} choices={SANDBOX_CHOICES} label="Workspace permission" disabled={conversation.status === "running"} onChange={(sandboxMode) => void patchConversation({ sandboxMode })} />
                </div>
                <div className={`settings-row ${conversation.sandboxMode === "read-only" ? "disabled" : ""}`}>
                  <span className="settings-copy"><strong>Development commands</strong><small>Allow build and test commands for OpenRouter sessions.</small></span>
                  <Switch checked={conversation.allowCommands} disabled={conversation.sandboxMode === "read-only" || conversation.status === "running"} label="Development commands" onChange={(checked) => void patchConversation({ allowCommands: checked })} />
                </div>
                <div className="settings-row web-search-setting">
                  <span className="settings-row-icon"><GlobeHemisphereWest size={18} /></span>
                  <span className="settings-copy"><strong>Live web search</strong><small>Let Codex and OpenRouter research current information and return source links.</small></span>
                  <Switch checked={snapshot.settings.webSearchEnabled} disabled={conversation.status === "running"} label="Live web search" onChange={(checked) => void patchSettings({ webSearchEnabled: checked })} />
                </div>
                <p className="settings-note">Applies on the next turn. Search calls may add provider tool charges.</p>
                {conversation.provider === "openrouter" && (
                  <button className="settings-row path-setting" type="button" onClick={() => void window.grokky.chooseOpenRouterCredential()}>
                    <span className="settings-row-icon"><Robot size={18} /></span>
                    <span className="settings-copy"><strong>OpenRouter credential</strong><small>{snapshot.settings.openRouterCredentialPath || "Choose an env file"}</small></span>
                    <ArrowUpRight size={15} />
                  </button>
                )}
                {conversation.usage && (
                  <div className="usage-summary">
                    <span><strong>{conversation.usage.inputTokens.toLocaleString()}</strong><small>input</small></span>
                    <span><strong>{conversation.usage.outputTokens.toLocaleString()}</strong><small>output</small></span>
                    <span><strong>{(conversation.usage.reasoningTokens ?? 0).toLocaleString()}</strong><small>reasoning</small></span>
                  </div>
                )}
              </div>
            )}

            {tab === "computer" && (
              <div className="settings-stack computer-access-stack">
                <div className="computer-hero">
                  <div className="computer-hero-bot"><BotMascot mood={snapshot.computerAccess.enabled ? "working" : "idle"} identity="computer-access" size="lg" /></div>
                  <div>
                    <span className="computer-kicker">Local runner</span>
                    <h3>Give agents hands, with boundaries</h3>
                    <p>Files, commands, web pages, screen visibility, and application control stay behind one permission layer.</p>
                  </div>
                  <Switch checked={snapshot.computerAccess.enabled} label="Computer access" onChange={(enabled) => void computerAction("enabled", () => window.grokky.setComputerAccessEnabled(enabled))} />
                </div>

                <section className="computer-section">
                  <div className="computer-section-heading"><div><h4>Connected computers</h4><p>Select where Grokky performs local work.</p></div><button type="button" onClick={() => setPairOpen((open) => !open)}><WifiHigh size={14} />Pair</button></div>
                  <div className="device-list">
                    {snapshot.computerAccess.devices.map((device) => (
                      <div className="device-row-shell" key={device.id}>
                        <button
                          className={`device-row ${snapshot.computerAccess.activeDeviceId === device.id ? "selected" : ""}`}
                          type="button"
                          disabled={device.status === "revoked" || computerBusy === device.id}
                          onClick={() => void computerAction(device.id, () => window.grokky.selectComputer(device.id))}
                        >
                          <span className="device-icon">{device.kind === "local" ? <DesktopTower size={18} /> : <Monitor size={18} />}</span>
                          <span><strong>{device.name}</strong><small>{device.kind === "local" ? "This computer" : device.endpoint} · {device.root}</small></span>
                          <em className={`device-status ${device.status}`}>{device.status}</em>
                          {snapshot.computerAccess.activeDeviceId === device.id && <ShieldCheck size={17} weight="fill" />}
                        </button>
                        {device.kind === "remote" && device.status !== "revoked" && <button className="device-revoke" type="button" title={`Revoke ${device.name}`} aria-label={`Revoke ${device.name}`} onClick={() => void computerAction(`revoke:${device.id}`, () => window.grokky.revokeComputer(device.id))}><Trash size={13} /></button>}
                      </div>
                    ))}
                  </div>
                  {pairOpen && (
                    <div className="pair-runner-form">
                      <div><strong>Pair another computer</strong><small>Start Grokky Runner there, then enter its endpoint and six-digit code.</small></div>
                      <label><span>Runner endpoint</span><input value={runnerEndpoint} onChange={(event) => setRunnerEndpoint(event.target.value)} placeholder="http://100.x.x.x:4747" /></label>
                      <label><span>Pairing code</span><input value={pairingCode} onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" /></label>
                      <div className="pair-runner-actions"><button type="button" onClick={() => setPairOpen(false)}>Cancel</button><button className="primary" type="button" disabled={computerBusy === "pair" || pairingCode.length !== 6 || !runnerEndpoint.trim()} onClick={() => void pairRunner()}>{computerBusy === "pair" ? <InlineLoader label="Pairing computer" /> : <ShieldCheck size={14} />}Pair securely</button></div>
                    </div>
                  )}
                </section>

                <section className={`computer-section ${!snapshot.computerAccess.enabled ? "disabled" : ""}`}>
                  <div className="computer-section-heading"><div><h4>Capability policy</h4><p>Ask pauses the agent and shows a clear approval card.</p></div></div>
                  <div className="computer-capability-list">
                    {snapshot.computerAccess.capabilities.map((capability) => (
                      <div className={`computer-capability-row ${!capability.available ? "unavailable" : ""}`} key={capability.id}>
                        <span className="computer-capability-icon"><ComputerCapabilityIcon id={capability.id} /></span>
                        <span className="settings-copy"><strong>{capability.label}</strong><small>{capability.description}<b>{permissionLabel(capability.permission)}</b></small></span>
                        {(capability.id === "screen" || capability.id === "automation") && capability.permission !== "granted" && capability.available && (
                          <button className="permission-button" type="button" disabled={computerBusy === `permission:${capability.id}`} onClick={() => void computerAction(`permission:${capability.id}`, () => window.grokky.requestComputerPermission(capability.id))}>System access</button>
                        )}
                        <button className="computer-test" type="button" disabled={!snapshot.computerAccess.enabled || !capability.available || capability.level === "blocked" || Boolean(computerBusy)} onClick={() => void computerAction(`test:${capability.id}`, () => window.grokky.testComputerCapability(capability.id))}>{computerBusy === `test:${capability.id}` ? <InlineLoader label={`Testing ${capability.label}`} quiet /> : "Test"}</button>
                        <SelectMenu value={capability.level} choices={COMPUTER_ACCESS_CHOICES} label={`${capability.label} access`} disabled={!snapshot.computerAccess.enabled || !capability.available || Boolean(computerBusy)} onChange={(level) => void computerAction(`level:${capability.id}`, () => window.grokky.setComputerCapability(capability.id, level))} />
                      </div>
                    ))}
                  </div>
                </section>

                <section className={`computer-section network-section ${!snapshot.computerAccess.enabled ? "disabled" : ""}`}>
                  <div className="computer-section-heading"><div><h4>Browser allowlist</h4><p>Always-allowed browsing stays within these public domains. One domain per line.</p></div><button type="button" disabled={computerBusy === "network"} onClick={() => void computerAction("network", () => window.grokky.updateComputerNetworkAllowlist(networkDomains.split(/\n|,/).map((domain) => domain.trim()).filter(Boolean)))}>{computerBusy === "network" ? <InlineLoader label="Saving domains" quiet /> : <FloppyDisk size={13} />}Save</button></div>
                  <textarea value={networkDomains} onChange={(event) => setNetworkDomains(event.target.value)} placeholder={'github.com\ndevelopers.openai.com'} />
                </section>

                <section className="computer-section audit-section">
                  <div className="computer-section-heading"><div><h4>Recent computer activity</h4><p>Every allowed and denied action is recorded locally.</p></div><ClockCounterClockwise size={17} /></div>
                  <div className="computer-audit-list">
                    {snapshot.computerAccess.auditLog.slice(0, 12).map((entry) => (
                      <div className="computer-audit-row" key={entry.id}>
                        <span className={`${entry.decision} ${entry.status}`}><ComputerCapabilityIcon id={entry.capability} /></span>
                        <span><strong>{entry.action.replaceAll("_", " ")}</strong><small>{entry.target}</small></span>
                        <time>{timeLabel(entry.createdAt)}</time>
                      </div>
                    ))}
                    {!snapshot.computerAccess.auditLog.length && <div className="capability-empty">No computer actions yet. Run a capability test to verify the boundary.</div>}
                  </div>
                </section>
              </div>
            )}

            {tab === "skills" && (
              <div className="settings-stack capability-stack">
                <div className="settings-intro"><h3>Skills available to Codex</h3><p>Disable workflows you do not use. This also keeps the skills context concise.</p></div>
                <label className="capability-search"><MagnifyingGlass size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search skills" /></label>
                {!capabilities ? <div className="capability-loading"><InlineLoader label="Loading skills" /><span>Loading skills</span></div> : (
                  <div className="capability-list">
                    {filteredSkills.map((skill) => (
                      <div className="capability-row" key={skill.id}>
                        <span className={`capability-kind-icon skill-kind-icon ${skill.enabled ? "enabled" : ""}`} aria-hidden="true"><PuzzlePiece size={17} weight={skill.enabled ? "fill" : "regular"} /></span>
                        <span className="settings-copy"><strong>{skill.name}<em>{scopeLabel(skill)}</em></strong><small>{skill.description}</small></span>
                        <Switch checked={skill.enabled} disabled={busy === skill.id} label={`${skill.name} skill`} onChange={(enabled) => void toggleCapability(skill.id, () => window.grokky.setSkillEnabled(skill.path, enabled))} />
                      </div>
                    ))}
                    {!filteredSkills.length && <div className="capability-empty">No skills match that search.</div>}
                  </div>
                )}
                {capabilities && <p className="settings-note">{capabilities.skills.filter((skill) => skill.enabled).length} of {capabilities.skills.length} skills active. Changes apply on the next Codex turn.</p>}
              </div>
            )}

            {tab === "agents" && (
              agentDraft ? (
                <div className="settings-stack agent-workbench">
                  <div className="agent-editor-header">
                    <button type="button" onClick={() => { setAgentDraft(null); setEditingAgentId(null); }}><ArrowLeft size={15} />Agents</button>
                    <div><h3>{editingAgentId ? `Edit ${agentDraft.name}` : "Create an agent"}</h3><p>Give Grokky a reusable specialist with a clear job and boundary.</p></div>
                  </div>
                  <div className="agent-form">
                    <fieldset className="agent-icon-field">
                      <legend>Bot profile</legend>
                      <div className="agent-icon-copy"><BotMascot mood="idle" variant={agentDraft.icon ?? "lime"} size="sm" label={`${AGENT_ICONS.find((icon) => icon.id === (agentDraft.icon ?? "lime"))?.label ?? "Lime"} bot profile`} /><span><strong>Choose a bot</strong><small>This profile stays with the agent when it runs.</small></span></div>
                      <div className="agent-icon-picker" aria-label="Bot profile choices">
                        {AGENT_ICONS.map((icon) => (
                          <button key={icon.id} type="button" className={(agentDraft.icon ?? "lime") === icon.id ? "selected" : ""} aria-label={icon.label} aria-pressed={(agentDraft.icon ?? "lime") === icon.id} title={icon.label} onClick={() => setAgentDraft({ ...agentDraft, icon: icon.id })}>
                            <BotMascot mood="idle" variant={icon.id} size="xs" />
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <label className="agent-field"><span>Name</span><input value={agentDraft.name} autoFocus onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })} placeholder="qa_scout" /></label>
                    <label className="agent-field"><span>Description</span><input value={agentDraft.description} onChange={(event) => setAgentDraft({ ...agentDraft, description: event.target.value })} placeholder="When should Grokky choose this agent?" /></label>
                    <label className="agent-field agent-instructions"><span>Instructions</span><textarea value={agentDraft.developerInstructions} onChange={(event) => setAgentDraft({ ...agentDraft, developerInstructions: event.target.value })} placeholder="Describe the role, method, constraints, and expected result." /></label>
                    <div className="agent-form-grid">
                      <div className="agent-field"><span>Scope</span><SelectMenu value={agentDraft.scope} choices={AGENT_SCOPE_CHOICES} label="Agent scope" disabled={Boolean(editingAgentId)} onChange={(scope) => setAgentDraft({ ...agentDraft, scope })} /></div>
                      <div className="agent-field"><span>Model</span><SelectMenu value={agentDraft.model ?? ""} choices={OPTIONAL_MODEL_CHOICES} label="Agent model" onChange={(model) => setAgentDraft({ ...agentDraft, model: model || undefined })} /></div>
                      <div className="agent-field"><span>Reasoning</span><SelectMenu value={agentDraft.reasoning ?? ""} choices={OPTIONAL_REASONING_CHOICES} label="Agent reasoning" onChange={(reasoning) => setAgentDraft({ ...agentDraft, reasoning: reasoning || undefined })} /></div>
                      <div className="agent-field"><span>Workspace</span><SelectMenu value={agentDraft.sandboxMode ?? ""} choices={OPTIONAL_SANDBOX_CHOICES} label="Agent workspace permission" onChange={(sandboxMode) => setAgentDraft({ ...agentDraft, sandboxMode: sandboxMode || undefined })} /></div>
                    </div>
                  </div>
                  <div className="agent-editor-actions">
                    {editingAgentId && <button className="agent-delete" type="button" disabled={agentBusy} onClick={() => void removeAgent()}><Trash size={14} />Delete</button>}
                    <span />
                    <button type="button" disabled={agentBusy} onClick={() => { setAgentDraft(null); setEditingAgentId(null); }}>Cancel</button>
                    <button className="agent-save" type="button" disabled={agentBusy || !agentDraft.name.trim() || !agentDraft.description.trim() || !agentDraft.developerInstructions.trim()} onClick={() => void saveAgent()}>{agentBusy ? <InlineLoader label="Saving agent" /> : <FloppyDisk size={14} />}Save agent</button>
                  </div>
                </div>
              ) : (
                <div className="settings-stack agent-workbench">
                  <div className="capability-hero agent-hero"><BotMascot mood="working" identity="builder" size="lg" /><div><h3>Build a crew around the job</h3><p>Choose specialists per chat. Grokky shows their work live and brings their findings back to one lead.</p><button type="button" onClick={() => beginAgentDraft({ name: "", description: "", developerInstructions: "", scope: "personal", icon: "lime" })}><UserPlus size={15} />New agent</button></div></div>
                  <div className="settings-row">
                    <span className="settings-copy"><strong>Multi-agent orchestration</strong><small>Use native Codex subagents or parallel OpenRouter scouts.</small></span>
                    <Switch checked={snapshot.settings.multiAgentEnabled} label="Multi-agent orchestration" onChange={(checked) => void patchSettings({ multiAgentEnabled: checked })} />
                  </div>
                  <div className={`settings-row ${!snapshot.settings.multiAgentEnabled ? "disabled" : ""}`}>
                    <span className="settings-copy"><strong>Parallel workers</strong><small>Maximum crew members that may run at once.</small></span>
                    <SelectMenu value={snapshot.settings.maxAgentThreads} choices={MAX_AGENT_CHOICES} label="Maximum parallel workers" disabled={!snapshot.settings.multiAgentEnabled} onChange={(maxAgentThreads) => void patchSettings({ maxAgentThreads })} />
                  </div>
                  <div className="agent-form-grid agent-defaults">
                    <div className="agent-field"><span>Default subagent model</span><SelectMenu value={snapshot.settings.defaultSubagentModel} choices={OPTIONAL_MODEL_CHOICES} label="Default subagent model" disabled={!snapshot.settings.multiAgentEnabled} onChange={(defaultSubagentModel) => void patchSettings({ defaultSubagentModel })} /></div>
                    <div className="agent-field"><span>Default reasoning</span><SelectMenu value={snapshot.settings.defaultSubagentReasoning} choices={OPTIONAL_REASONING_CHOICES} label="Default subagent reasoning" disabled={!snapshot.settings.multiAgentEnabled} onChange={(defaultSubagentReasoning) => void patchSettings({ defaultSubagentReasoning })} /></div>
                  </div>
                  <div className={`settings-row ${!snapshot.settings.multiAgentEnabled ? "disabled" : ""}`}>
                    <span className="settings-copy"><strong>Agent updates in chat</strong><small>Let Codex announce delegation and handoffs as they happen.</small></span>
                    <Switch checked={snapshot.settings.interruptAgentMessage} disabled={!snapshot.settings.multiAgentEnabled} label="Agent updates in chat" onChange={(checked) => void patchSettings({ interruptAgentMessage: checked })} />
                  </div>
                  <section className="agent-template-section">
                    <div className="agent-roster-header"><span><strong>Quick start</strong><small>Make one yours, then tune it.</small></span></div>
                    <div className="agent-template-strip">{AGENT_TEMPLATES.map((template) => <button key={template.label} type="button" onClick={() => beginAgentDraft(template)}><BotMascot mood="idle" identity={template.name} variant={template.icon} size="xs" /><span><strong>{template.label}</strong><small>{template.description}</small></span><Plus size={14} /></button>)}</div>
                  </section>
                  <section className="agent-roster">
                    <div className="agent-roster-header"><span><strong>Your agents</strong><small>{agents.length} available in this workspace</small></span><button type="button" onClick={() => beginAgentDraft({ name: "", description: "", developerInstructions: "", scope: "personal", icon: "lime" })}><Plus size={14} />New</button></div>
                    <div className="agent-definition-list">
                      {agents.map((agent) => (
                        <button className="agent-definition-row" type="button" key={agent.id} onClick={() => editAgent(agent)}>
                          <BotMascot mood="idle" identity={agent.name || agent.id} variant={agent.icon} size="xs" />
                          <span className="settings-copy"><strong>{agent.name}<em>{agent.scope}</em></strong><small>{agent.description}</small></span>
                          {agent.builtIn ? <span className="agent-row-action"><Copy size={14} />Duplicate</span> : <span className="agent-row-action">Edit<ArrowUpRight size={13} /></span>}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              )
            )}

            {tab === "mcp" && (
              <div className="settings-stack capability-stack">
                <div className="settings-intro"><h3>Configured MCP servers</h3><p>Grokky inherits the same local Codex MCP configuration.</p></div>
                {!capabilities ? <div className="capability-loading"><InlineLoader label="Loading servers" /><span>Loading servers</span></div> : (
                  <div className="capability-list">
                    {capabilities.mcpServers.map((server) => (
                      <div className="capability-row" key={server.id}>
                        <span className="settings-row-icon"><PlugsConnected size={18} /></span>
                        <span className="settings-copy"><strong>{server.name}<em>{server.transport}</em></strong><small>{server.id}</small></span>
                        <Switch checked={server.enabled} disabled={busy === server.id} label={`${server.name} MCP server`} onChange={(enabled) => void toggleCapability(server.id, () => window.grokky.setMcpEnabled(server.id, enabled))} />
                      </div>
                    ))}
                    {!capabilities.mcpServers.length && <div className="capability-empty">No MCP servers are configured.</div>}
                  </div>
                )}
                <p className="settings-note">Local and remote MCP tools are available to Codex when their own approval policy allows them.</p>
              </div>
            )}

            {tab === "connectors" && (
              <div className="settings-stack capability-stack">
                <div className="settings-intro"><h3>Plugins and connectors</h3><p>Use installed Codex plugins and their bundled tools inside Grokky.</p></div>
                <div className="settings-row">
                  <span className="settings-copy"><strong>Connector runtime</strong><small>Enable plugins, remote tools, and network-backed connectors for Codex.</small></span>
                  <Switch checked={snapshot.settings.connectorsEnabled} label="Connector runtime" onChange={(checked) => void patchSettings({ connectorsEnabled: checked })} />
                </div>
                {!capabilities ? <div className="capability-loading"><InlineLoader label="Loading connectors" /><span>Loading connectors</span></div> : (
                  <div className={`capability-list ${!snapshot.settings.connectorsEnabled ? "disabled" : ""}`}>
                    {capabilities.connectors.map((connector) => (
                      <div className="capability-row" key={connector.id}>
                        <span className="settings-row-icon"><Robot size={18} /></span>
                        <span className="settings-copy"><strong>{connector.name}</strong><small>{connector.id}</small></span>
                        <Switch checked={connector.enabled} disabled={!snapshot.settings.connectorsEnabled || busy === connector.id} label={`${connector.name} connector`} onChange={(enabled) => void toggleCapability(connector.id, () => window.grokky.setConnectorEnabled(connector.id, enabled))} />
                      </div>
                    ))}
                    {!capabilities.connectors.length && <div className="capability-empty">No connector plugins are installed.</div>}
                  </div>
                )}
                <p className="settings-note">This applies to Codex sessions. OpenRouter uses Grokky's built-in workspace tools.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function DeleteConversationDialog({ title, busy, onCancel, onConfirm }: {
  title: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel]);

  return (
    <div className="delete-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
      <section className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-chat-title" aria-describedby="delete-chat-description">
        <div className="delete-dialog-icon"><Trash size={18} weight="fill" /></div>
        <div className="delete-dialog-copy">
          <span>Delete chat</span>
          <h2 id="delete-chat-title">Remove this conversation?</h2>
          <p id="delete-chat-description"><strong>“{title}”</strong> and its messages, work log, and crew history will be permanently removed from this computer.</p>
        </div>
        <footer>
          <button ref={cancelRef} className="delete-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="delete-confirm" type="button" disabled={busy} onClick={onConfirm}><Trash size={14} weight="fill" />{busy ? "Deleting…" : "Delete chat"}</button>
        </footer>
      </section>
    </div>
  );
}

function ComputerApprovalDialog({ request, busy, onDecision }: {
  request: ComputerApprovalRequest;
  busy: boolean;
  onDecision(decision: ComputerApprovalDecision): void;
}) {
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    denyRef.current?.focus();
  }, [request.id]);

  return (
    <div className="computer-approval-backdrop">
      <section className="computer-approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="computer-approval-title" aria-describedby="computer-approval-description">
        <div className="computer-approval-bot"><BotMascot mood="thinking" identity={`approval:${request.capability}`} size="md" /></div>
        <div className="computer-approval-copy">
          <span>Computer permission</span>
          <h2 id="computer-approval-title">Grokky wants to use {request.deviceName}</h2>
          <p id="computer-approval-description">Approve <strong>{request.action}</strong> for <code>{request.target}</code>.</p>
          <small>{request.capability} access · this action is recorded in the local activity log</small>
        </div>
        <footer>
          <button ref={denyRef} type="button" disabled={busy} onClick={() => onDecision("deny")}>Deny</button>
          <button type="button" disabled={busy} onClick={() => onDecision("allow-once")}>Allow once</button>
          <button className="primary" type="button" disabled={busy} onClick={() => onDecision("allow-session")}>{busy ? <InlineLoader label="Applying approval" /> : <ShieldCheck size={14} />}Allow for this chat</button>
        </footer>
      </section>
    </div>
  );
}

function sidebarAgentState(conversation: Conversation, agent: AgentDefinition): { label: string; active: boolean; complete: boolean } {
  const run = conversation.agentRuns.find((candidate) => candidate.name.toLowerCase() === agent.name.toLowerCase());
  if (!run) return { label: conversation.status === "running" ? "Awaiting assignment" : "Ready", active: false, complete: false };
  if (run.status === "completed") return { label: "Reported", active: false, complete: true };
  if (run.status === "failed" || run.status === "stopped") return { label: run.status === "failed" ? "Needs attention" : "Stopped", active: false, complete: false };
  if (run.status === "waiting") return { label: "Reporting", active: true, complete: false };
  if (run.status === "starting") return { label: "Connecting", active: true, complete: false };
  return { label: "Working", active: true, complete: false };
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [search, setSearch] = useState("");
  const [uiError, setUiError] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);

  useEffect(() => {
    void window.grokky.getSnapshot().then(setSnapshot).catch((error) => setUiError(error.message));
    window.grokky.onSnapshot(setSnapshot);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const root = document.documentElement;
    if (snapshot.settings.theme === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = snapshot.settings.theme;
    root.dataset.accent = snapshot.settings.accentPalette ?? "lime";
  }, [snapshot?.settings.theme, snapshot?.settings.accentPalette]);

  const activeWorkingDirectory = snapshot?.conversations.find((item) => item.id === snapshot.activeConversationId)?.workingDirectory
    ?? snapshot?.conversations[0]?.workingDirectory;

  useEffect(() => {
    if (!activeWorkingDirectory) return;
    void window.grokky.getAgents().then(setAgents).catch((error) => setUiError(error instanceof Error ? error.message : "Agents could not be loaded"));
  }, [snapshot?.activeConversationId, activeWorkingDirectory]);

  const active = snapshot?.conversations.find((item) => item.id === snapshot.activeConversationId) ?? snapshot?.conversations[0];
  const filtered = useMemo(() => snapshot?.conversations.filter((item) => item.title.toLowerCase().includes(search.toLowerCase())) ?? [], [snapshot?.conversations, search]);

  if (!snapshot || !active) {
    return <div className="loading-screen"><span className="loading-halo" /><BotMascot mood="thinking" size="lg" label="Grokky is waking up" /><strong>Waking Grokky</strong><InlineLoader label="Loading workspace" /></div>;
  }

  async function updateProvider(provider: ProviderId) {
    try {
      await window.grokky.updateConversation(active!.id, { provider });
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Provider could not be changed");
    }
  }

  function requestDelete(conversation: Conversation) {
    if (conversation.status === "running") {
      setUiError("Stop the current run before deleting this chat");
      return;
    }
    setPendingDelete({ id: conversation.id, title: conversation.title });
  }

  async function confirmDelete() {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await window.grokky.deleteConversation(pendingDelete.id);
      setPendingDelete(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Session could not be deleted");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function resolveComputerApproval(request: ComputerApprovalRequest, decision: ComputerApprovalDecision) {
    if (approvalBusy) return;
    setApprovalBusy(true);
    try {
      await window.grokky.resolveComputerApproval(request.id, decision);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Computer approval could not be resolved");
    } finally {
      setApprovalBusy(false);
    }
  }

  const activeStatus = snapshot.providerStatuses.find((status) => status.id === active.provider);
  const activeDevice = snapshot.computerAccess.devices.find((device) => device.id === snapshot.computerAccess.activeDeviceId);

  return (
    <div className="app-shell">
      <aside className="session-sidebar">
        <div className="window-drag" />
        <div className="brand-row">
          <BrandMark />
          <div><strong>Grokky</strong><span>Local agent workspace</span></div>
          <button className="icon-button new-session" type="button" title="New session" onClick={() => void window.grokky.createConversation()}><Plus size={18} /></button>
        </div>
        <label className="search-box">
          <MagnifyingGlass size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search sessions" />
          {search && <button type="button" onClick={() => setSearch("")}><X size={13} /></button>}
        </label>
        <nav className="session-list" aria-label="Conversations">
          {filtered.map((conversation) => {
            const selectedAgents = agents.filter((agent) => conversation.selectedAgentIds.includes(agent.id));
            return (
              <Fragment key={conversation.id}>
                <div className="session-entry">
                  <button className={`session-item ${conversation.id === active.id ? "active" : ""}`} type="button" onClick={() => void window.grokky.setActiveConversation(conversation.id)}>
                    <BotMascot mood={conversationMood(conversation)} identity={`conversation:${conversation.id}`} size="xs" />
                    <span><strong>{conversation.title}</strong><small>{providerName(conversation.provider)}<i />{timeLabel(conversation.updatedAt)}</small></span>
                    {conversation.status === "running" ? <InlineLoader label={`${conversation.title} is running`} quiet /> : conversation.unreadCount > 0 ? <em className="session-unread" aria-label={`${conversation.unreadCount} unread ${conversation.unreadCount === 1 ? "reply" : "replies"}`}>{conversation.unreadCount}</em> : null}
                  </button>
                  {conversation.status !== "running" && conversation.id === active.id && (
                    <button
                      className="session-delete"
                      type="button"
                      title={`Delete ${conversation.title}`}
                      aria-label={`Delete ${conversation.title}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestDelete(conversation);
                      }}
                    >
                      <Trash size={15} weight="duotone" />
                    </button>
                  )}
                </div>
                {(conversation.id === active.id || conversation.status === "running") && selectedAgents.length > 0 && (
                  <section className="sidebar-crew-nest" aria-label={`${conversation.title} crew`}>
                    <header><span>Crew</span><small>{selectedAgents.length}</small></header>
                    {selectedAgents.map((agent) => {
                      const state = sidebarAgentState(conversation, agent);
                      return (
                        <button key={agent.id} type="button" onClick={() => {
                          void window.grokky.setActiveConversation(conversation.id);
                          setSettingsTab("agents");
                        }}>
                          <BotMascot mood={state.complete ? "success" : state.active ? "working" : "idle"} identity={agent.name} variant={agent.icon} size="micro" />
                          <span><strong>{agent.name}</strong><small>{state.label}</small></span>
                          <i className={state.active ? "active" : state.complete ? "complete" : ""} />
                        </button>
                      );
                    })}
                  </section>
                )}
              </Fragment>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button type="button" data-settings-tab="agents" onClick={() => setSettingsTab("agents")}><UsersThree size={17} />Crew</button>
          <button type="button" data-settings-tab="computer" onClick={() => setSettingsTab("computer")}><DesktopTower size={17} />Computer</button>
          <button type="button" data-settings-tab="skills" onClick={() => setSettingsTab("skills")}><PuzzlePiece size={17} />Skills & tools</button>
          <button type="button" data-settings-tab="session" onClick={() => setSettingsTab("session")}><GearSix size={17} />Settings</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-toolbar">
          <div className="toolbar-drag" />
          <div className="chat-identity">
            <BotMascot mood={conversationMood(active)} identity={`conversation:${active.id}`} size="xs" />
            <span><strong>{active.title}</strong><small>{active.projectMode === "project" ? compactPath(active.workingDirectory) : "No project selected"}</small></span>
          </div>
          <div className="toolbar-controls">
            <div className="toolbar-rail" aria-label="Run configuration">
              <div className="provider-switch" aria-label="Provider">
                <button type="button" aria-pressed={active.provider === "codex"} className={active.provider === "codex" ? "active" : ""} onClick={() => void updateProvider("codex")}><span aria-hidden="true" />Codex</button>
                <button type="button" aria-pressed={active.provider === "openrouter"} className={active.provider === "openrouter" ? "active" : ""} onClick={() => void updateProvider("openrouter")}><span aria-hidden="true" />OpenRouter</button>
              </div>
              <i className="toolbar-separator" aria-hidden="true" />
              <div className="toolbar-field model-field">
                <Robot size={15} weight="duotone" />
                {active.provider === "codex" ? (
                  <SelectMenu value={active.model} choices={CODEX_MODEL_CHOICES} label="Codex model" compact disabled={active.status === "running"} onChange={(model) => void window.grokky.updateConversation(active.id, { model }).catch((error) => setUiError(error.message))} />
                ) : (
                  <ModelCombobox value={active.model} suggestions={OPENROUTER_SUGGESTIONS} label="OpenRouter model" disabled={active.status === "running"} onCommit={(model) => void window.grokky.updateConversation(active.id, { model }).catch((error) => setUiError(error.message))} />
                )}
              </div>
              <i className="toolbar-separator" aria-hidden="true" />
              <div className="toolbar-field reasoning-field">
                <Brain size={15} weight="duotone" />
                <SelectMenu value={active.reasoning} choices={REASONING_CHOICES} label="Reasoning effort" compact disabled={active.status === "running"} onChange={(reasoning) => void window.grokky.updateConversation(active.id, { reasoning }).catch((error) => setUiError(error.message))} />
              </div>
            </div>
            <div className="toolbar-actions" aria-label="Session actions">
              <button className={`icon-button computer-toolbar ${snapshot.computerAccess.enabled && activeDevice?.status === "online" ? "connected" : ""}`} data-tooltip={snapshot.computerAccess.enabled ? `Computer: ${activeDevice?.name || "Unavailable"}` : "Computer access is off"} aria-label={snapshot.computerAccess.enabled ? `Computer: ${activeDevice?.name || "Unavailable"}` : "Computer access is off"} type="button" onClick={() => setSettingsTab("computer")}><DesktopTower size={17} weight="duotone" /></button>
              {!activeStatus?.ready && <button className="icon-button setup-warning" data-tooltip={activeStatus?.detail || "Provider needs setup"} aria-label={activeStatus?.detail || "Provider needs setup"} type="button" onClick={() => setSettingsTab("session")}><WarningCircle size={17} /></button>}
              <button className="icon-button" data-tooltip="Session settings" aria-label="Session settings" type="button" onClick={() => setSettingsTab("session")}><GearSix size={17} /></button>
              <button className="icon-button danger" data-tooltip={active.status === "running" ? "Stop the run before deleting this chat" : "Delete chat"} aria-label={active.status === "running" ? "Stop the run before deleting this chat" : "Delete chat"} type="button" onClick={() => requestDelete(active)} disabled={active.status === "running"}><Trash size={16} /></button>
            </div>
          </div>
        </header>

        <MessageList conversation={active} agents={agents} />
        <Composer conversation={active} agents={agents} recentDirectories={snapshot.settings.recentWorkingDirectories} multiAgentEnabled={snapshot.settings.multiAgentEnabled} maxAgents={snapshot.settings.maxAgentThreads} webSearchEnabled={snapshot.settings.webSearchEnabled} onOpenAgents={() => setSettingsTab("agents")} onError={setUiError} />
      </main>

      {settingsTab && <SettingsDialog snapshot={snapshot} conversation={active} agents={agents} initialTab={settingsTab} onAgentsChange={setAgents} onClose={() => setSettingsTab(null)} onError={setUiError} />}

      {pendingDelete && <DeleteConversationDialog title={pendingDelete.title} busy={deleteBusy} onCancel={() => { if (!deleteBusy) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} />}

      {snapshot.computerAccess.pendingApproval && <ComputerApprovalDialog request={snapshot.computerAccess.pendingApproval} busy={approvalBusy} onDecision={(decision) => void resolveComputerApproval(snapshot.computerAccess.pendingApproval!, decision)} />}

      {uiError && <div className="toast" role="alert"><WarningCircle size={17} /><span>{uiError}</span><button type="button" onClick={() => setUiError("")}><X size={14} /></button></div>}
    </div>
  );
}
