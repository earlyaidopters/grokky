import { useConversationScroll } from "./use-conversation-scroll";
import { ConversationDrafts, type DraftImage } from "./conversation-drafts";
import { PhoneControl } from "./PhoneControl";
import type { PhoneDesktopStatus } from "../../shared/phone";
import { Fragment, createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ArrowsInSimple,
  ArrowsOutSimple,
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
  Minus,
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
  AgentComputerAction,
  AgentComputerEvidence,
  AgentComputerSession,
  AgentDefinition,
  AgentDraft,
  AgentIcon,
  AgentMeeting,
  AgentRun,
  AgentTask,
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
import { FeatureCenter, GeneratedArtifacts, type FeatureCenterView } from "./OpenBotFeatures";

const OPENROUTER_SUGGESTIONS = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-pro",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-chat-latest",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
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

const DEFAULT_SIDEBAR_WIDTH = 292;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_WIDTH_STORAGE_KEY = "grokky.sessionSidebarWidth";
const DEFAULT_WATCH_WIDTH = 470;
const MIN_WATCH_WIDTH = 360;
const MAX_WATCH_WIDTH = 960;
const WATCH_WIDTH_STORAGE_KEY = "grokky.agentWatchWidth";

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function clampWatchWidth(value: number): number {
  return Math.min(MAX_WATCH_WIDTH, Math.max(MIN_WATCH_WIDTH, Math.round(value)));
}

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

function computerActionLabel(action: string): string {
  return action
    .split("_")
    .map((word) => word.toLowerCase() === "url" ? "URL" : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function computerEffectLabel(effect: NonNullable<AgentComputerAction["effect"]>): string {
  return effect.replaceAll("_", " ");
}

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
  const [expanded, setExpanded] = useState(true);
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
    <section className={`activity-panel outcome-${outcome || "running"} ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent activity">
      <div className="activity-heading">
        <span className={`activity-live-mark ${running ? "running" : "complete"}`} aria-hidden="true"><i /><i /><i /></span>
        <span><strong>{running ? current?.label || "Preparing the first action" : "Work summary"}</strong><small>{visible.length} {visible.length === 1 ? "phase" : "phases"} · {rawVisible.length} {rawVisible.length === 1 ? "action" : "actions"}</small></span>
        <em>{running ? "Live" : outcomeLabel}</em>
        <button className="activity-toggle" type="button" aria-expanded={expanded} aria-label={expanded ? "Hide agent actions" : "Show agent actions"} onClick={() => setExpanded((value) => !value)}>
          <span>{expanded ? "Hide" : "Show"}</span><CaretDown size={13} />
        </button>
      </div>
      {!visible.length && running && (
        <div className="activity-skeleton" aria-label="Waiting for the first activity" hidden={!expanded}>
          <i /><i /><i />
        </div>
      )}
      {visible.length > 0 && (
        <div className="activity-list" hidden={!expanded}>
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

function MessageList({ conversation, agents, onWatchComputer }: { conversation: Conversation; agents: AgentDefinition[]; onWatchComputer(computerId: string): void }) {
  const { scrollRef, contentRef, onScroll, showLatest, jumpToLatest } = useConversationScroll(conversation.id);
  const latestUserIndex = conversation.messages.findLastIndex((message) => message.role === "user");
  const liveCrewVisible = conversation.agentRuns.length > 0
    || (conversation.status === "running" && conversation.selectedAgentIds.length > 0);

  return (
    <div className="message-region">
    <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="message-stack" ref={contentRef}>
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
          conversation.messages.map((message, index) => {
            const historical = message.crew ? {
              ...conversation,
              messages: conversation.messages.slice(0, index + 1),
              activities: message.crew.activities,
              agentRuns: message.crew.agentRuns,
              crewCommunications: message.crew.communications,
              agentTasks: message.crew.tasks,
              agentMeetings: message.crew.meetings,
              agentComputers: message.crew.agentComputers,
              status: "idle" as const,
              lastRunOutcome: message.crew.lastRunOutcome,
              usage: message.crew.usage,
              error: undefined,
              updatedAt: message.crew.updatedAt,
            } : undefined;
            const isLiveTurn = message.role === "user" && index === latestUserIndex;
            const projected = historical || (isLiveTurn ? conversation : undefined);
            const hasCrew = Boolean(projected && (projected.agentRuns.length > 0 || (isLiveTurn && liveCrewVisible)));
            return (
            <article className={`message ${message.role} ${hasCrew ? "with-crew" : ""}`} key={message.id}>
              {message.role === "assistant" && <BotMascot mood="idle" identity={`conversation:${conversation.id}`} size="xs" className="message-avatar" label="Grokky" />}
              <div className="message-body">
                <div className="message-shell">
                  <header>
                    <span>{message.role === "user" ? "You" : "Grokky"}</span>
                    <time>{timeLabel(message.createdAt)}</time>
                  </header>
                  <MessageImages attachments={message.attachments ?? []} />
                  {message.content && <div className="message-content"><MarkdownMessage content={message.content} /></div>}
                  <GeneratedArtifacts artifacts={message.artifacts} />
                  <MessageActions content={message.content} role={message.role} attachments={message.attachments} />
                </div>
                {message.role === "user" && projected && (
                  <>
                    {hasCrew && <CrewRunPanel conversation={projected} agents={agents} panelId={message.id} onWatchComputer={onWatchComputer} />}
                    {!hasCrew && <ActivityPanel activities={projected.activities} running={projected.status === "running"} outcome={projected.lastRunOutcome} />}
                    {historical && <ArchivedComputerHistory computers={message.crew?.agentComputers ?? []} onWatchComputer={onWatchComputer} />}
                  </>
                )}
              </div>
            </article>
            );
          })
        )}
        {conversation.error && (
          <div className="run-error" role="alert"><WarningCircle size={17} />{conversation.error}</div>
        )}
      </div>
    </div>
    {showLatest && <button className="jump-to-latest" type="button" onClick={jumpToLatest}><CaretDown size={14} />Back to latest</button>}
    </div>
  );
}

const activeAgentStatuses = new Set<AgentRun["status"]>(["starting", "working", "waiting"]);

function archivedComputerStatus(computer: AgentComputerSession): string {
  if (computer.status === "completed") return "Completed";
  if (computer.status === "stopped") return "Stopped";
  if (computer.status === "failed") return "Needs attention";
  return "Last observed state";
}

function ArchivedComputerHistory({ computers, onWatchComputer }: { computers: AgentComputerSession[]; onWatchComputer(computerId: string): void }) {
  if (!computers.length) return null;
  return (
    <section className="archived-computer-history" aria-label="Computer history for this turn">
      <header><span><ClockCounterClockwise size={13} />Computer history</span><small>{computers.length} {computers.length === 1 ? "seat" : "seats"}</small></header>
      <div>
        {computers.map((computer) => (
          <button key={computer.id} type="button" onClick={() => onWatchComputer(computer.id)} aria-label={`Watch archived computer for ${computer.agentName}`}>
            <BotMascot mood={computer.status === "failed" ? "error" : computer.status === "completed" ? "success" : "idle"} identity={computer.agentName} variant={computer.icon} size="micro" />
            <span><strong>{computer.agentName}</strong><small>{computer.role === "lead" ? "Lead seat" : "Specialist seat"} · {archivedComputerStatus(computer)}</small></span>
            <em>{computer.actions.length} {computer.actions.length === 1 ? "action" : "actions"} · {computer.evidence.length} {computer.evidence.length === 1 ? "frame" : "frames"}</em>
            <Eye size={13} />
          </button>
        ))}
      </div>
    </section>
  );
}

function runMood(run: AgentRun): BotMood {
  if (run.id.startsWith("queued:") || run.id.startsWith("unconfirmed:")) return "thinking";
  if (run.status === "failed" || run.status === "stopped") return "error";
  if (run.status === "completed") return "success";
  if (run.status === "waiting") return "thinking";
  return "working";
}

function CrewRunPanel({ conversation, agents, panelId, onWatchComputer }: { conversation: Conversation; agents: AgentDefinition[]; panelId?: string; onWatchComputer(computerId: string): void }) {
  const runs = crewRunsForDisplay(conversation, agents);
  const stage = crewRunStage(conversation, runs);
  const now = useLiveNow(stage !== "complete");
  const queued = runs.filter((run) => run.id.startsWith("queued:"));
  const unconfirmed = runs.filter((run) => run.id.startsWith("unconfirmed:"));
  const synthetic = new Set([...queued, ...unconfirmed].map((run) => run.id));
  const active = runs.filter((run) => !synthetic.has(run.id) && activeAgentStatuses.has(run.status));
  const reported = runs.filter((run) => run.status === "completed");
  const failed = runs.filter((run) => run.status === "failed");
  const stopped = runs.filter((run) => run.status === "stopped");
  const communications = conversation.crewCommunications;
  const tasks = conversation.agentTasks ?? [];
  const meetings = conversation.agentMeetings ?? [];
  const leadUpdates = conversation.activities
    .filter((activity) => activity.kind === "notice" && activity.label === "Coordinator update" && activity.detail)
    .slice(-3);
  const [expanded, setExpanded] = useState(runs.length > 0);
  type CrewTab = "overview" | "tasks" | "meeting" | "messages";
  const [activeTab, setActiveTab] = useState<CrewTab>("overview");
  const panelKey = panelId ?? conversation.id;
  const turnId = conversation.messages.findLast((message) => message.role === "user")?.id;
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
          ? { title: "Crew needs attention", detail: failed.length || stopped.length ? `${reported.length} reported · ${failed.length} failed · ${stopped.length} stopped` : `${reported.length} of ${runs.length} confirmed reports received` }
          : { title: "Crew run delivered", detail: `${reported.length} specialist ${reported.length === 1 ? "report" : "reports"} combined` };
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const problemTasks = tasks.filter((task) => new Set<AgentTask["status"]>(["blocked", "failed", "stopped"]).has(task.status)).length;
  const latestMeeting = meetings.at(-1);
  const accessibilityUpdate = tasks.length || latestMeeting
    ? `Crew update: ${completedTasks} of ${tasks.length} tasks completed${problemTasks ? `, ${problemTasks} need attention` : ""}. ${latestMeeting ? `Meeting ${meetingStatusLabel(latestMeeting).toLowerCase()} with ${latestMeeting.contributions.length} observed contributions.` : "No meeting opened."}`
    : `Crew update: ${header.title}.`;
  useEffect(() => {
    if (stage !== "complete") setExpanded(true);
  }, [stage, conversation.id]);

  useEffect(() => setActiveTab("overview"), [conversation.id, turnId]);

  const selectTab = (tab: CrewTab) => {
    setActiveTab(tab);
    setExpanded(true);
  };

  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, current: CrewTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const order: CrewTab[] = ["overview", "tasks", "meeting", "messages"];
    const index = order.indexOf(current);
    const tab = event.key === "Home"
      ? order[0]!
      : event.key === "End"
        ? order.at(-1)!
        : order[(index + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length]!;
    selectTab(tab);
    requestAnimationFrame(() => document.getElementById(`crew-tab-${tab}-${panelKey}`)?.focus());
  };

  if (!runs.length) return null;
  return (
    <section className={`crew-run-panel stage-${stage} ${stage !== "complete" ? "is-active" : ""}`} aria-label="Crew activity">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{accessibilityUpdate}</div>
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
              id={`crew-tab-overview-${panelKey}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "overview"}
              aria-controls={`crew-panel-overview-${panelKey}`}
              tabIndex={activeTab === "overview" ? 0 : -1}
              onClick={() => selectTab("overview")}
              onKeyDown={(event) => moveTab(event, "overview")}
            >
              <UsersThree size={13} /><span>Overview</span>
            </button>
            <button
              id={`crew-tab-tasks-${panelKey}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "tasks"}
              aria-controls={`crew-panel-tasks-${panelKey}`}
              tabIndex={activeTab === "tasks" ? 0 : -1}
              onClick={() => selectTab("tasks")}
              onKeyDown={(event) => moveTab(event, "tasks")}
            >
              <CheckCircle size={13} /><span>Tasks</span><small>{tasks.length}</small>
            </button>
            <button
              id={`crew-tab-meeting-${panelKey}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "meeting"}
              aria-controls={`crew-panel-meeting-${panelKey}`}
              tabIndex={activeTab === "meeting" ? 0 : -1}
              onClick={() => selectTab("meeting")}
              onKeyDown={(event) => moveTab(event, "meeting")}
            >
              <UsersThree size={13} /><span>Meeting</span><small>{meetings.length}</small>
            </button>
            <button
              id={`crew-tab-messages-${panelKey}`}
              className="crew-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "messages"}
              aria-controls={`crew-panel-messages-${panelKey}`}
              tabIndex={activeTab === "messages" ? 0 : -1}
              onClick={() => selectTab("messages")}
              onKeyDown={(event) => moveTab(event, "messages")}
            >
              <PaperPlaneRight size={13} /><span>Messages</span><small>{communications.length}</small>
            </button>
          </div>
          {activeTab === "overview" ? (
            <div
              id={`crew-panel-overview-${panelKey}`}
              className="crew-run-body"
              role="tabpanel"
              aria-labelledby={`crew-tab-overview-${panelKey}`}
              tabIndex={0}
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
                {runs.map((run) => <CrewRunRow
                  key={run.id}
                  run={run}
                  activities={conversation.activities}
                  now={now}
                  computer={(conversation.agentComputers ?? []).findLast((candidate) => candidate.threadId === run.threadId || candidate.agentName.toLowerCase() === run.name.toLowerCase())}
                  onWatchComputer={onWatchComputer}
                />)}
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
          ) : activeTab === "tasks" ? (
            <CrewTaskBoard id={`crew-panel-tasks-${panelKey}`} labelledBy={`crew-tab-tasks-${panelKey}`} tasks={tasks} />
          ) : activeTab === "meeting" ? (
            <CrewMeetingRoom id={`crew-panel-meeting-${panelKey}`} labelledBy={`crew-tab-meeting-${panelKey}`} meetings={meetings} />
          ) : (
            <CrewMailbox
              id={`crew-panel-messages-${panelKey}`}
              labelledBy={`crew-tab-messages-${panelKey}`}
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
    <section id={id} className="crew-mailbox crew-transcript" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
      {!groups.length ? (
        <div className="crew-mailbox-empty">
          <span aria-hidden="true"><PaperPlaneRight size={18} /></span>
          <div><strong>No crew messages yet</strong><small>The first confirmed assignment will appear here.</small></div>
        </div>
      ) : (
        <ol>
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

function taskStatusLabel(status: AgentTask["status"]): string {
  if (status === "assigned") return "Assigned";
  if (status === "working") return "Working";
  if (status === "waiting") return "Waiting";
  if (status === "completed") return "Completed";
  if (status === "blocked") return "Blocked";
  if (status === "failed") return "Failed";
  return "Stopped";
}

function CrewTaskBoard({ id, labelledBy, tasks }: { id: string; labelledBy: string; tasks: AgentTask[] }) {
  return (
    <section id={id} className="crew-task-board" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
      {!tasks.length ? (
        <div className="crew-mailbox-empty">
          <span aria-hidden="true"><CheckCircle size={18} /></span>
          <div><strong>No confirmed tasks yet</strong><small>Assignments and direct handoffs appear here as the crew accepts them.</small></div>
        </div>
      ) : (
        <ol>
          {[...tasks].reverse().map((task) => (
            <li className={`crew-task status-${task.status}`} key={task.id}>
              <header>
                <span><strong>{task.fromName}</strong><ArrowRight size={10} weight="bold" /><strong>{task.toName}</strong></span>
                <em><i />{taskStatusLabel(task.status)}</em>
              </header>
              <h4>{task.title}</h4>
              {task.instructions.trim().toLowerCase() !== task.title.trim().toLowerCase() && <p>{task.instructions}</p>}
              {task.acceptanceCriteria.length > 0 && (
                <details><summary>Detected checks · {task.acceptanceCriteria.length}<CaretDown size={12} /></summary><ul>{task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></details>
              )}
              {task.result && <details className="crew-task-result"><summary>{task.status === "failed" ? "Failure detail" : task.status === "stopped" ? "Interruption detail" : task.status === "blocked" ? "Blocker detail" : "Reported evidence"}<CaretDown size={12} /></summary><div><MarkdownMessage content={task.result} /></div></details>}
              <time>{timeLabel(task.updatedAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function meetingStatusLabel(meeting: AgentMeeting): string {
  if (meeting.status === "live") return "Live";
  if (meeting.status === "completed") return meeting.decisions.length ? "Decided" : "Complete";
  return "Incomplete";
}

function CrewMeetingRoom({ id, labelledBy, meetings }: { id: string; labelledBy: string; meetings: AgentMeeting[] }) {
  const [selectedMeetingId, setSelectedMeetingId] = useState(meetings.at(-1)?.id ?? "");
  useEffect(() => setSelectedMeetingId(meetings.at(-1)?.id ?? ""), [meetings.at(-1)?.id]);
  const meeting = meetings.find((candidate) => candidate.id === selectedMeetingId) ?? meetings.at(-1);
  if (!meeting) {
    return (
      <section id={id} className="crew-meeting-room" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
        <div className="crew-mailbox-empty">
          <span aria-hidden="true"><UsersThree size={18} /></span>
          <div><strong>No crew meeting yet</strong><small>Ask the crew to challenge findings or agree on a decision. Only observed contributions will appear here.</small></div>
        </div>
      </section>
    );
  }
  return (
    <section id={id} className={`crew-meeting-room status-${meeting.status}`} role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
      {meetings.length > 1 && <nav className="crew-meeting-picker" aria-label="Meeting history">{meetings.map((candidate, index) => <button type="button" aria-pressed={candidate.id === meeting.id} key={candidate.id} onClick={() => setSelectedMeetingId(candidate.id)}>Meeting {index + 1}</button>)}</nav>}
      <header className="crew-meeting-header">
        <span><strong>{meeting.title}</strong><small>{meeting.participantNames.join(" · ") || "Waiting for participants"}</small></span>
        <em><i />{meetingStatusLabel(meeting)}</em>
      </header>
      <div className="crew-meeting-agenda"><small>Agenda</small><p>{meeting.agenda}</p></div>
      <ol className="crew-meeting-transcript">
        {meeting.contributions.map((contribution) => (
          <li key={contribution.id} className={`kind-${contribution.kind}`}>
            <BotMascot identity={contribution.speakerThreadId} variant={contribution.speakerName === "Grokky lead" ? "lime" : undefined} mood={contribution.kind === "decision" ? "success" : "thinking"} size="micro" />
            <div><header><strong>{contribution.speakerName}</strong><em>{contribution.kind}</em><time>{timeLabel(contribution.createdAt)}</time></header><MarkdownMessage content={contribution.content} /></div>
          </li>
        ))}
      </ol>
      {!meeting.contributions.length && <div className="crew-mailbox-empty compact"><div><strong>Meeting opened</strong><small>Waiting for the first observed contribution.</small></div></div>}
      {(meeting.decisions.length > 0 || meeting.actionItems.length > 0) && (
        <div className="crew-meeting-outcomes">
          {meeting.decisions.length > 0 && <section><small>Decisions</small><ul>{meeting.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul></section>}
          {meeting.actionItems.length > 0 && <section><small>Next actions</small><ul>{meeting.actionItems.map((action) => <li key={action}>{action}</li>)}</ul></section>}
        </div>
      )}
      {meeting.status === "incomplete" && <p className="crew-meeting-warning"><WarningCircle size={14} />The lead turn ended before every participant delivered a confirmed report. No consensus is implied.</p>}
    </section>
  );
}

function CrewRunRow({ run, activities, now, computer, onWatchComputer }: {
  run: AgentRun;
  activities: ActivityItem[];
  now: number;
  computer?: AgentComputerSession;
  onWatchComputer(computerId: string): void;
}) {
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
  return (
    <div className="crew-run-record">
      {!run.result
        ? <div className={`crew-run-row status-${run.status}${stateClass}`}>{content}</div>
        : <details className={`crew-run-row status-${run.status}${stateClass}`}><summary>{content}<CaretDown size={13} /></summary><p>{run.result}</p></details>}
      {computer && !isSynthetic && (
        <button className="crew-watch-button" type="button" onClick={() => onWatchComputer(computer.id)} title={`Watch ${run.name}'s computer`}>
          <Eye size={12} /><span>Watch</span>
        </button>
      )}
    </div>
  );
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
        <span>{selected.length ? `Crew ${selected.length}` : enabled ? "Auto" : "Solo"}</span>
        <CaretDown size={12} />
      </button>
      {open && (
        <div className="crew-picker-popover" role="dialog" aria-label="Choose the crew">
          <header><strong>Choose the crew</strong><small>{conversation.provider === "openrouter" ? "Ask for specialists in chat, or choose a crew" : "Codex chooses agents, or uses your selected roles"}</small></header>
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

function AccessPicker({ conversation, sandboxCommandsAvailable, attention, openRequest, onError }: { conversation: Conversation; sandboxCommandsAvailable: boolean; attention: boolean; openRequest: number; onError(error: string): void }) {
  const value: ComposerAccess = conversation.sandboxMode === "read-only" ? "read-only" : conversation.allowCommands ? "full" : "workspace";
  const choices: Array<{ id: ComposerAccess; label: string; detail: string }> = [
    { id: "read-only", label: "Read only", detail: "Inspect files without changing them" },
    { id: "workspace", label: "Workspace access", detail: "Read and edit files in this project" },
    ...(conversation.provider === "codex" ? [{ id: "full" as const, label: "Full access", detail: "Edit files and run commands in Codex's native sandbox" }] : sandboxCommandsAvailable ? [{ id: "full" as const, label: "Full access", detail: "Edit files and run commands in a disposable remote sandbox" }] : []),
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
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      pickerRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
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

const allowedImageTypes = new Set<ImageMimeType>(["image/png", "image/jpeg", "image/webp"]);

function Composer({ conversation, drafts, agents, recentDirectories, multiAgentEnabled, maxAgents, webSearchEnabled, sandboxCommandsAvailable, onOpenAgents, onError }: {
  conversation: Conversation;
  drafts: ConversationDrafts;
  agents: AgentDefinition[];
  recentDirectories: string[];
  multiAgentEnabled: boolean;
  maxAgents: number;
  webSearchEnabled: boolean;
  sandboxCommandsAvailable: boolean;
  onOpenAgents(): void;
  onError(error: string): void;
}) {
  const savedDraft = useSyncExternalStore(drafts.subscribe, () => drafts.get(conversation.id));
  const { text: draft, images: draftImages } = savedDraft;
  function setDraft(value: string | ((previous: string) => string)) {
    drafts.update(conversation.id, { text: typeof value === "function" ? value(drafts.get(conversation.id).text) : value });
  }
  const [draggingImages, setDraggingImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"project" | "access" | null>(null);
  const [projectOpenRequest, setProjectOpenRequest] = useState(0);
  const [accessOpenRequest, setAccessOpenRequest] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  function replaceDraftImages(images: DraftImage[]) {
    drafts.update(conversation.id, { images });
  }

  function addImageFiles(files: File[]) {
    if (!files.length) return;
    const current = drafts.get(conversation.id).images;
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
    replaceDraftImages(drafts.get(conversation.id).images.filter((item) => item.id !== id));
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
  }, [conversation.id, drafts]);

  useEffect(() => {
    setDraggingImages(false);
    setPreflightTarget(null);
  }, [conversation.id]);

  useEffect(() => {
    if (preflightTarget === "project" && conversation.projectMode === "project") setPreflightTarget(null);
    if (preflightTarget === "access" && conversation.allowCommands) setPreflightTarget(null);
  }, [conversation.projectMode, conversation.allowCommands, preflightTarget]);

  async function submit(priority: MessagePriority = "normal") {
    const submittedDraft = drafts.get(conversation.id);
    const value = submittedDraft.text.trim();
    const pendingImages = submittedDraft.images;
    if ((!value && !pendingImages.length) || submitting) return;
    if (conversation.status !== "running" && conversation.projectMode === "none" && requiresProjectDirectory(value)) {
      setPreflightTarget("project");
      setProjectOpenRequest((request) => request + 1);
      return;
    }
    if (conversation.provider === "codex" && conversation.status !== "running" && requiresDevelopmentCommands(value) && !conversation.allowCommands) {
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
      drafts.clearSubmitted(conversation.id, submittedDraft);
      if (fileInput.current) fileInput.current.value = "";
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
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
        <AccessPicker conversation={conversation} sandboxCommandsAvailable={sandboxCommandsAvailable} attention={preflightTarget === "access"} openRequest={accessOpenRequest} onError={onError} />
        <CrewPicker conversation={conversation} agents={agents} enabled={multiAgentEnabled} maxAgents={maxAgents} onOpenAgents={onOpenAgents} onError={onError} />
        {conversation.status === "running" && <button className="run-stop-meta" type="button" onClick={() => void window.grokky.cancelRun(conversation.id)}><Stop size={11} weight="fill" />Stop</button>}
        {preflightTarget && <span className="composer-preflight-note"><WarningCircle size={12} />{preflightTarget === "project" ? "Choose a project to continue" : "Choose Full access to continue"}</span>}
        <span className={`web-access-status ${webSearchEnabled ? "enabled" : ""}`} title={webSearchEnabled ? "Live web search is enabled" : "Live web search is disabled"}><GlobeHemisphereWest size={12} />Web search {webSearchEnabled ? "on" : "off"}</span>
        <span className="composer-shortcut">{conversation.status === "running" ? "Enter queues · ⌘Enter redirects" : "Enter to send"}</span>
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
  if (id === "external") return <PlugsConnected size={17} />;
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
  const activeRemoteCommandDevice = snapshot.computerAccess.devices.find((device) => device.id === snapshot.computerAccess.activeDeviceId && device.kind === "remote" && device.status === "online" && device.capabilities.includes("commands"));
  const pairingSecretValid = /^\d{6}$/.test(pairingCode) || /^gsk_[a-zA-Z0-9_-]{32,180}$/.test(pairingCode);

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
                {conversation.provider === "codex" || activeRemoteCommandDevice ? (
                  <div className={`settings-row ${conversation.sandboxMode === "read-only" ? "disabled" : ""}`}>
                    <span className="settings-copy"><strong>Development commands</strong><small>{conversation.provider === "codex" ? "Allow commands inside Codex's native workspace sandbox." : `Allow commands inside isolated seats on ${activeRemoteCommandDevice?.name}.`}</small></span>
                    <Switch checked={conversation.allowCommands} disabled={conversation.sandboxMode === "read-only" || conversation.status === "running"} label="Development commands" onChange={(checked) => void patchConversation({ allowCommands: checked })} />
                  </div>
                ) : (
                  <p className="settings-note">OpenRouter commands stay off until an online disposable sandbox is selected.</p>
                )}
                <div className="settings-row web-search-setting">
                  <span className="settings-row-icon"><GlobeHemisphereWest size={18} /></span>
                  <span className="settings-copy"><strong>Live web search</strong><small>Let Codex and OpenRouter research current information and return source links.</small></span>
                  <Switch checked={snapshot.settings.webSearchEnabled} disabled={conversation.status === "running"} label="Live web search" onChange={(checked) => void patchSettings({ webSearchEnabled: checked })} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-icon"><Sparkle size={18} /></span>
                  <span className="settings-copy"><strong>Structured views</strong><small>Render requested tables, scorecards, checklists, and timelines as native workspace cards.</small></span>
                  <Switch checked={snapshot.settings.generatedArtifactsEnabled !== false} label="Structured views" onChange={(checked) => void patchSettings({ generatedArtifactsEnabled: checked })} />
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
                    <p>OpenRouter's structured tools pass through this permission layer. Codex native tools follow its own local sandbox policy.</p>
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
                          disabled={device.status !== "online" || computerBusy === device.id}
                          onClick={() => void computerAction(device.id, () => window.grokky.selectComputer(device.id))}
                        >
                          <span className="device-icon">{device.kind === "local" ? <DesktopTower size={18} /> : <Monitor size={18} />}</span>
                          <span><strong>{device.name}</strong><small>{device.kind === "local" ? "This computer" : device.endpoint} · {device.root}</small></span>
                          <em className={`device-status ${device.status}`}>{device.status}</em>
                          {snapshot.computerAccess.activeDeviceId === device.id && <ShieldCheck size={17} weight="fill" />}
                        </button>
                        {device.kind === "remote" && device.status !== "revoked" && <button className="device-revoke" type="button" title={`Revoke and forget ${device.name}`} aria-label={`Revoke and forget ${device.name}`} onClick={() => void computerAction(`revoke:${device.id}`, () => window.grokky.revokeComputer(device.id))}><Trash size={13} /></button>}
                      </div>
                    ))}
                  </div>
                  {pairOpen && (
                    <div className="pair-runner-form">
                      <div><strong>Pair a computer or sandbox</strong><small>Use a six-digit private-runner code or a one-time <code>gsk_</code> sandbox enrollment key.</small></div>
                      <label><span>Runner endpoint</span><input value={runnerEndpoint} onChange={(event) => setRunnerEndpoint(event.target.value)} placeholder="https://runner.example.com:4747" /></label>
                      <label><span>Pairing secret</span><input value={pairingCode} onChange={(event) => setPairingCode(event.target.value.replace(/\s/g, "").slice(0, 184))} autoComplete="off" spellCheck={false} placeholder="000000 or gsk_…" /></label>
                      <div className="pair-runner-actions"><button type="button" onClick={() => setPairOpen(false)}>Cancel</button><button className="primary" type="button" disabled={computerBusy === "pair" || !pairingSecretValid || !runnerEndpoint.trim()} onClick={() => void pairRunner()}>{computerBusy === "pair" ? <InlineLoader label="Pairing computer" /> : <ShieldCheck size={14} />}Pair securely</button></div>
                    </div>
                  )}
                  <div className="settings-row computer-spread-setting">
                    <span className="settings-copy"><strong>Spread OpenRouter crew across computers</strong><small>{conversation.provider === "codex" ? "Codex runs locally through its SDK; remote routing is unavailable." : "Pin OpenRouter agent seats across online devices in round-robin order."}</small></span>
                    <Switch checked={snapshot.settings.spreadAgentComputers ?? false} disabled={conversation.provider === "codex"} label="Spread OpenRouter crew across computers" onChange={(checked) => void patchSettings({ spreadAgentComputers: checked })} />
                  </div>
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
                    {snapshot.computerAccess.auditLog.slice(-12).reverse().map((entry) => (
                      <div className="computer-audit-row" key={entry.id}>
                        <span className={`${entry.decision} ${entry.status}`}><ComputerCapabilityIcon id={entry.capability} /></span>
                        <span><strong>{entry.agentName ? `${entry.agentName} · ` : ""}{entry.action.startsWith("test_") ? `Manual test · ${entry.capability}` : entry.action.replaceAll("_", " ")}</strong><small title={entry.detail}>{entry.target}</small></span>
                        <em className={`computer-audit-result ${entry.status}`}>{entry.status === "pending" ? "In progress" : entry.status === "completed" ? "Passed" : entry.status === "indeterminate" ? "Outcome unknown" : "Failed"}</em>
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
                <div className="settings-row">
                  <span className="settings-row-icon"><PlugsConnected size={18} /></span>
                  <span className="settings-copy"><strong>OpenRouter MCP tools</strong><small>Expose enabled servers to OpenRouter through bounded tool selection and Grokky's approval boundary.</small></span>
                  <Switch checked={Boolean(snapshot.settings.openRouterExternalTools)} label="OpenRouter MCP tools" onChange={(checked) => void patchSettings({ openRouterExternalTools: checked })} />
                </div>
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
  const dialogRef = useRef<HTMLElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    denyRef.current?.focus();
    setCopyState("idle");
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [request.id]);

  const keepFocusInside = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  const copyTarget = async () => {
    try {
      await navigator.clipboard.writeText(request.target);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="computer-approval-backdrop">
      <section ref={dialogRef} className="computer-approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="computer-approval-title" aria-describedby="computer-approval-description" onKeyDown={keepFocusInside}>
        <div className="computer-approval-bot"><BotMascot mood="thinking" identity={`approval:${request.capability}`} size="md" /></div>
        <div className="computer-approval-copy">
          <span>Computer permission</span>
          <h2 id="computer-approval-title">{request.agentName || "Grokky"} wants to use {request.deviceName}</h2>
          <p id="computer-approval-description">Review the exact target before allowing <strong>{request.action}</strong>.</p>
          <div className="computer-approval-target">
            <span id="computer-approval-target-label">Exact target</span>
            <code tabIndex={0} aria-labelledby="computer-approval-target-label">{request.target}</code>
            <button type="button" disabled={busy} onClick={() => void copyTarget()} aria-label="Copy exact approval target">
              <Copy size={12} />{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </button>
          </div>
          <small>{request.capability} access · every action stays recorded in the local activity log</small>
        </div>
        <footer>
          <button ref={denyRef} type="button" disabled={busy} onClick={() => onDecision("deny")}>Deny</button>
          <button type="button" disabled={busy} onClick={() => onDecision("allow-once")}>Allow once</button>
          <button className="primary" type="button" disabled={busy} onClick={() => onDecision("allow-session")}>{busy ? <InlineLoader label="Applying approval" /> : <ShieldCheck size={14} />}{request.agentName ? "Allow all for this agent run" : "Allow all for this run"}</button>
        </footer>
      </section>
    </div>
  );
}

function AgentComputerEvidencePreview({ evidence, onError }: { evidence: AgentComputerEvidence; onError(error: string): void }) {
  const [dataUrl, setDataUrl] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    setDataUrl("");
    setLoadError("");
    void window.grokky.getAgentComputerEvidenceData(evidence.id)
      .then((value) => { if (active) setDataUrl(value); })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Evidence preview could not be loaded";
        setLoadError(message);
        onError(message);
      });
    return () => { active = false; };
  }, [evidence.id, onError, retry]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setExpanded(false);
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [expanded]);
  return (
    <figure className="agent-watch-evidence agent-desktop-frame">
      {dataUrl
        ? <><img src={dataUrl} alt={`${evidence.title} captured evidence`} /><button className="agent-desktop-open" type="button" onClick={() => setExpanded(true)}><ArrowUpRight size={15} />Open</button></>
        : loadError
          ? <div className="agent-watch-evidence-error"><WarningCircle size={20} /><strong>Preview unavailable</strong><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>
          : <div><InlineLoader label="Loading captured evidence" /></div>}
      <figcaption><span><strong>{evidence.title}</strong><small>{evidence.sha256 ? `Integrity-verified ${evidence.kind} frame` : `Legacy captured ${evidence.kind} frame`}</small></span><time>{timeLabel(evidence.createdAt)}</time></figcaption>
      {expanded && dataUrl && createPortal(
        <div className="agent-desktop-lightbox" role="dialog" aria-modal="true" aria-label={`${evidence.title} expanded cloud computer frame`} onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}>
          <header><span><Monitor size={16} />{evidence.title}</span><button type="button" onClick={() => setExpanded(false)} aria-label="Close expanded computer frame"><X size={18} /></button></header>
          <img src={dataUrl} alt={`${evidence.title} expanded captured evidence`} />
        </div>,
        document.body,
      )}
    </figure>
  );
}

function AgentDesktopPlaceholder({ agentName, ready, cloud, native }: { agentName: string; ready: boolean; cloud: boolean; native: boolean }) {
  return (
    <div className="agent-desktop-placeholder">
      <div className="agent-desktop-placeholder-copy">
        <span><Monitor size={31} weight="duotone" /></span>
        <strong>{cloud && ready ? "Cloud computer ready" : cloud ? "No saved frames yet" : native ? "Native Codex session" : "Local tool session"}</strong>
        <small>{!cloud ? "Follow assignments, reports and recorded tool actions in the conversation. This session has no live cloud screen." : ready ? "Live view switches on after the first cloud browser action. Saved checkpoints stay here in History." : "This run did not save a browser or screen checkpoint."}</small>
      </div>
      {cloud && <div className="agent-desktop-dock" aria-label="Available cloud computer apps">
        <span title="Browser"><GlobeHemisphereWest size={18} weight="fill" /></span>
        <span title="Files"><FolderOpen size={18} weight="fill" /></span>
        <span title="Terminal"><TerminalWindow size={18} weight="fill" /></span>
      </div>}
      <p>{agentName}&apos;s {cloud ? "screen" : "session"}</p>
    </div>
  );
}

function AgentLiveDesktop({ url, agentName, onError }: { url: string; agentName: string; onError(error: string): void }) {
  const BASE_WIDTH = 1280;
  const BASE_HEIGHT = 800;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const liveViewRef = useRef<(HTMLElement & { reload(): void }) | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLoaded(false);
    setLoadError("");
  }, [url]);

  useEffect(() => {
    const node = liveViewRef.current;
    if (!node) return;
    const didStartLoading = () => { setLoaded(false); setLoadError(""); };
    const didStopLoading = () => { setLoaded(true); setLoadError(""); };
    const didFailLoad = (event: Event) => {
      const details = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (details.isMainFrame === false || details.errorCode === -3) return;
      const message = details.errorDescription && details.errorDescription !== "ERR_FAILED"
        ? `Live desktop could not connect: ${details.errorDescription}`
        : "Live desktop could not connect. Retry the stream or use History.";
      setLoaded(false);
      setLoadError(message);
    };
    node.addEventListener("did-start-loading", didStartLoading);
    node.addEventListener("did-stop-loading", didStopLoading);
    node.addEventListener("did-fail-load", didFailLoad);
    return () => {
      node.removeEventListener("did-start-loading", didStartLoading);
      node.removeEventListener("did-stop-loading", didStopLoading);
      node.removeEventListener("did-fail-load", didFailLoad);
    };
  }, [url]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const fitScale = viewport.width > 0 && viewport.height > 0
    ? Math.min(viewport.width / BASE_WIDTH, viewport.height / BASE_HEIGHT)
    : 0.35;
  const effectiveScale = fitScale * zoom;
  const canvasWidth = Math.round(BASE_WIDTH * effectiveScale);
  const canvasHeight = Math.round(BASE_HEIGHT * effectiveScale);
  const updateZoom = (next: number) => setZoom(Math.min(3, Math.max(1, Math.round(next * 4) / 4)));
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === containerRef.current) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Live desktop could not enter full screen");
    }
  };

  return (
    <div ref={containerRef} className={`agent-live-viewer${fullscreen ? " fullscreen" : ""}`}>
      <div className="agent-live-toolbar">
        <span><i />Live & interactive</span>
        <div>
          <button type="button" aria-label="Zoom live desktop out" disabled={zoom <= 1} onClick={() => updateZoom(zoom - 0.25)}><Minus size={13} /></button>
          <output aria-label="Live desktop zoom">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="Zoom live desktop in" disabled={zoom >= 3} onClick={() => updateZoom(zoom + 0.25)}><Plus size={13} /></button>
          <button className="agent-live-fit" type="button" onClick={() => setZoom(1)}>Fit</button>
          <button type="button" aria-label={fullscreen ? "Exit full screen" : "Watch live desktop full screen"} onClick={() => void toggleFullscreen()}>{fullscreen ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}</button>
        </div>
      </div>
      <div ref={viewportRef} className="agent-live-viewport">
        {!loaded && !loadError && <span className="agent-live-loading"><InlineLoader label="Connecting to live desktop" /></span>}
        {loadError && <span className="agent-live-error"><WarningCircle size={22} /><strong>Live stream unavailable</strong><small>{loadError}</small><button type="button" onClick={() => liveViewRef.current?.reload()}>Retry</button></span>}
        <div className="agent-live-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
          {createElement("webview", {
            key: url,
            ref: liveViewRef,
            src: url,
            partition: "grokky-live-view",
            title: `${agentName} live cloud desktop`,
            className: "agent-live-webview",
            style: { transform: `scale(${effectiveScale})` },
          } as never)}
        </div>
      </div>
      <small>Click to interact. Zoom in, then scroll to pan around the live computer.</small>
    </div>
  );
}

function AgentWatchDrawer({ computer, conversation, phone, build, liveViewUrl, watchWidth, focusOnMount, onResizeStart, onResizeMove, onResizeEnd, onResetWidth, onResizeKeyDown, onClose, onError }: {
  phone?: PhoneDesktopStatus;
  build?: string;
  computer: AgentComputerSession;
  conversation: Conversation;
  liveViewUrl?: string;
  watchWidth: number;
  focusOnMount: boolean;
  onResizeStart(event: ReactPointerEvent<HTMLDivElement>): void;
  onResizeMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onResizeEnd(event: ReactPointerEvent<HTMLDivElement>): void;
  onResetWidth(): void;
  onResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  onClose(): void;
  onError(error: string): void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(computer.evidence.at(-1)?.id ?? "");
  const [desktopMode, setDesktopMode] = useState<"live" | "history">(liveViewUrl ? "live" : "history");
  const matchedEvidenceIndex = computer.evidence.findIndex((evidence) => evidence.id === selectedEvidenceId);
  const selectedEvidenceIndex = matchedEvidenceIndex >= 0 ? matchedEvidenceIndex : Math.max(0, computer.evidence.length - 1);
  const selectedEvidence = computer.evidence[selectedEvidenceIndex] ?? computer.evidence.at(-1);
  const statusLabel = computer.status === "provisioning"
    ? "Provisioning"
    : computer.status === "ready"
      ? "Ready"
      : computer.status === "working"
        ? "Working"
        : computer.status === "waiting"
          ? "Waiting"
          : computer.status === "completed"
            ? "Completed"
            : computer.status === "blocked"
              ? "Blocked"
            : computer.status === "stopped"
              ? "Stopped"
              : "Needs attention";
  const currentActivity = computer.currentAction
    || (computer.status === "completed"
      ? "Work delivered"
      : computer.status === "stopped"
        ? "Work stopped"
        : computer.status === "blocked"
          ? "Work is blocked"
        : computer.status === "failed"
          ? "Action needs attention"
          : computer.status === "waiting"
            ? "Waiting for the next update"
            : computer.task || "Ready for the next action");
  const assignmentActive = new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting"]).has(computer.status);
  const emptyActionCopy = assignmentActive
    ? "The assignment is active; its first policy-gated action will appear here."
    : computer.status === "completed"
      ? "This seat completed without a Grokky-owned computer action."
      : computer.status === "stopped"
        ? "The run stopped before a Grokky-owned computer action began."
        : "No Grokky-owned computer action was recorded before the run needed attention.";

  useEffect(() => {
    setSelectedEvidenceId(computer.evidence.at(-1)?.id ?? "");
  }, [computer.id, computer.evidence.at(-1)?.id]);

  useEffect(() => {
    if (liveViewUrl) setDesktopMode("live");
  }, [liveViewUrl]);

  useEffect(() => {
    if (focusOnMount) drawerRef.current?.focus();
  }, [computer.id, focusOnMount]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.fullscreenElement) onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const reportFailure = (error: unknown, fallback: string) => onError(error instanceof Error ? error.message : fallback);
  const openCurrentUrl = async () => {
    if (!computer.currentUrl) return;
    try {
      await window.grokky.openExternal(computer.currentUrl);
    } catch (error) {
      reportFailure(error, "The current page could not be opened");
    }
  };
  const stopRun = async () => {
    try {
      await window.grokky.cancelRun(conversation.id);
    } catch (error) {
      reportFailure(error, "The run could not be stopped");
    }
  };
  const moveEvidence = (delta: number) => {
    const index = Math.min(computer.evidence.length - 1, Math.max(0, selectedEvidenceIndex + delta));
    setSelectedEvidenceId(computer.evidence[index]?.id ?? "");
  };

  return (
    <aside ref={drawerRef} className="agent-watch-drawer agent-desktop-panel" tabIndex={-1} aria-label={`Desktop: ${computer.agentName} in ${conversation.title}`}>
      <div
        className="agent-watch-resizer"
        role="separator"
        aria-label="Resize live desktop sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WATCH_WIDTH}
        aria-valuemax={MAX_WATCH_WIDTH}
        aria-valuenow={watchWidth}
        tabIndex={0}
        onDoubleClick={onResetWidth}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKeyDown}
      />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {computer.agentName}: {statusLabel}. {currentActivity}. {computer.evidence.length} captured {computer.evidence.length === 1 ? "frame" : "frames"}; {computer.actions.length} recorded {computer.actions.length === 1 ? "action" : "actions"}.
      </div>
      <header className="agent-watch-header">
        <div><BotMascot mood={computer.status === "failed" ? "error" : computer.status === "completed" ? "success" : computer.status === "working" ? "working" : "thinking"} identity={computer.agentName} variant={computer.icon} size="sm" /></div>
        <span><small title={conversation.title}>{conversation.title}</small><strong>{computer.agentName}</strong><em className={`status-${computer.status}`}><i />{statusLabel}</em></span>
        <button type="button" title="Close Watch" aria-label="Close Watch" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="agent-watch-body">
        {conversation.provider === "openrouter" && computer.role === "lead" && computer.isolation === "cloud-browser" && <PhoneControl conversationId={conversation.id} status={phone} build={build} onError={onError} />}
        <section className="agent-watch-section agent-desktop-section">
          <header>
            <span>{computer.isolation === "cloud-browser" ? "Cloud desktop" : "Computer screen"}</span>
            <span className="agent-desktop-modes">
              <button type="button" className={desktopMode === "live" ? "active" : ""} disabled={!liveViewUrl} onClick={() => setDesktopMode("live")}><i />Live</button>
              <button type="button" className={desktopMode === "history" ? "active" : ""} onClick={() => setDesktopMode("history")}>History <small>{computer.evidence.length}</small></button>
            </span>
          </header>
          {desktopMode === "live" && liveViewUrl
            ? <AgentLiveDesktop url={liveViewUrl} agentName={computer.agentName} onError={onError} />
            : <>
                {computer.evidence.length > 0 && (
                  <div className="agent-history-toolbar">
                    <button type="button" aria-label="Previous captured frame" disabled={selectedEvidenceIndex <= 0} onClick={() => moveEvidence(-1)}><ArrowLeft size={11} /></button>
                    <small>Saved frame {selectedEvidenceIndex + 1} of {computer.evidence.length}</small>
                    <button type="button" aria-label="Next captured frame" disabled={selectedEvidenceIndex >= computer.evidence.length - 1} onClick={() => moveEvidence(1)}><ArrowRight size={11} /></button>
                  </div>
                )}
                {selectedEvidence
                  ? <AgentComputerEvidencePreview evidence={selectedEvidence} onError={onError} />
                  : <AgentDesktopPlaceholder agentName={computer.agentName} ready={assignmentActive} cloud={computer.isolation === "cloud-browser"} native={conversation.provider === "codex"} />}
              </>}
          {computer.currentUrl && <button className="agent-watch-url" type="button" onClick={() => void openCurrentUrl()}><GlobeHemisphereWest size={13} /><span>{computer.pageTitle || computer.currentUrl}</span><ArrowUpRight size={12} /></button>}
        </section>
        <section className="agent-watch-now">
          <header><span>Current activity</span><Eye size={14} /></header>
          <strong>{currentActivity}</strong>
          {computer.currentTarget && <p>{computer.currentTarget}</p>}
          <dl>
            <div><dt>Computer</dt><dd>{computer.deviceName}</dd></div>
            <div><dt>Boundary</dt><dd>{computer.isolation === "cloud-browser" ? "Isolated Cloudflare browser" : computer.isolation === "isolated-browser" ? "Ephemeral browser profile" : conversation.provider === "codex" ? "SDK-observed local session" : "Policy-isolated seat"}</dd></div>
            <div><dt>Workspace</dt><dd title={computer.workspaceRoot}>{compactPath(computer.workspaceRoot)}</dd></div>
          </dl>
        </section>
        <section className="agent-watch-section">
          <header><span>Action timeline</span><small>{computer.actions.length} {computer.actions.length === 1 ? "action" : "actions"}</small></header>
          <ol className="agent-watch-actions">
            {[...computer.actions].reverse().map((action) => (
              <li key={action.id} className={`status-${action.status}`}>
                <i />
                <span><strong>{computerActionLabel(action.action)}{action.effect && <em className={`effect-${action.effect}`}>{computerEffectLabel(action.effect)}</em>}{action.status === "indeterminate" && <em>Outcome unknown</em>}</strong><small title={action.detail || action.target}>{action.status === "completed" ? action.detail || action.target : action.detail || action.target}</small></span>
                <time>{timeLabel(action.updatedAt)}</time>
              </li>
            ))}
          </ol>
          {!computer.actions.length && <div className="agent-watch-empty compact"><ClockCounterClockwise size={18} /><strong>No computer actions recorded</strong><small>{emptyActionCopy}</small></div>}
        </section>
      </div>
      <footer className="agent-watch-footer">
        <span><ShieldCheck size={13} />{conversation.provider === "codex" ? "Codex controls native tools; Watch shows only activity its SDK exposes." : "Grokky-owned tools stay behind the approval and local audit boundary."}</span>
        {conversation.status === "running" && <button type="button" onClick={() => void stopRun()}><Stop size={12} weight="fill" />Stop run</button>}
      </footer>
    </aside>
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
  const [drafts] = useState(() => new ConversationDrafts());
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [search, setSearch] = useState("");
  const [uiError, setUiError] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [featureCenterView, setFeatureCenterView] = useState<FeatureCenterView | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const creatingSession = useRef(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [watchedComputerId, setWatchedComputerId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? "", 10);
      return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
    } catch {
      return DEFAULT_SIDEBAR_WIDTH;
    }
  });
  const [watchWidth, setWatchWidth] = useState(() => {
    try {
      const stored = Number.parseInt(localStorage.getItem(WATCH_WIDTH_STORAGE_KEY) ?? "", 10);
      return Number.isFinite(stored) ? clampWatchWidth(stored) : DEFAULT_WATCH_WIDTH;
    } catch {
      return DEFAULT_WATCH_WIDTH;
    }
  });
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const watchResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const autoWatchedComputerIds = useRef(new Set<string>());
  const onboardingOpened = useRef(false);
  useEffect(() => {
    if (snapshot) drafts.retain(new Set(snapshot.conversations.map((conversation) => conversation.id)));
  }, [snapshot?.conversations, drafts]);
  useEffect(() => () => drafts.retain(new Set()), [drafts]);
  const watchReturnFocus = useRef<HTMLElement | null>(null);
  const watchShouldRestoreFocus = useRef(false);

  useEffect(() => {
    void window.grokky.getSnapshot().then(setSnapshot).catch((error) => setUiError(error.message));
    window.grokky.onSnapshot(setSnapshot);
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.settings.onboardingComplete !== false || onboardingOpened.current) return;
    onboardingOpened.current = true;
    setFeatureCenterView("setup");
  }, [snapshot?.settings.onboardingComplete]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // A read-only renderer storage partition should not disable resizing for this session.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(WATCH_WIDTH_STORAGE_KEY, String(watchWidth));
    } catch {
      // A read-only renderer storage partition should not disable resizing for this session.
    }
  }, [watchWidth]);

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
  const archivedComputers = active?.messages.flatMap((message) => message.crew?.agentComputers ?? []) ?? [];
  const activeComputers = [...archivedComputers, ...(active?.agentComputers ?? [])];
  const watchedComputer = activeComputers.find((computer) => computer.id === watchedComputerId);
  const watchedConversation = watchedComputer ? active : undefined;
  const watchedComputerIsCurrent = Boolean(
    active?.agentComputers?.some((computer) => computer.id === watchedComputerId)
    && !archivedComputers.some((computer) => computer.id === watchedComputerId),
  );
  const modalOpen = Boolean(settingsTab || featureCenterView || pendingDelete || snapshot?.computerAccess.pendingApproval);

  const openWatch = (computerId: string, restoreFocus = true) => {
    watchReturnFocus.current = restoreFocus && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    watchShouldRestoreFocus.current = restoreFocus;
    setWatchedComputerId(computerId);
  };

  const closeWatch = (restoreFocus = true) => {
    if (watchedComputerId) autoWatchedComputerIds.current.add(watchedComputerId);
    const returnTarget = restoreFocus && watchShouldRestoreFocus.current ? watchReturnFocus.current : null;
    watchShouldRestoreFocus.current = false;
    watchReturnFocus.current = null;
    setWatchedComputerId(null);
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    sidebarResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    event.preventDefault();
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeResize = sidebarResize.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(activeResize.startWidth + event.clientX - activeResize.startX));
  };

  const endSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResize.current?.pointerId !== event.pointerId) return;
    sidebarResize.current = null;
    event.currentTarget.dataset.dragging = "false";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const beginWatchResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    watchResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: watchWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    event.preventDefault();
  };

  const moveWatchResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeResize = watchResize.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    setWatchWidth(clampWatchWidth(activeResize.startWidth - (event.clientX - activeResize.startX)));
  };

  const endWatchResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (watchResize.current?.pointerId !== event.pointerId) return;
    watchResize.current = null;
    event.currentTarget.dataset.dragging = "false";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    if (!watchedComputer || !watchedConversation || !watchedComputerIsCurrent || watchedConversation.status !== "running") return;
    const latest = (watchedConversation.agentComputers ?? []).findLast((computer) => computer.agentId === watchedComputer.agentId);
    if (latest && latest.id !== watchedComputer.id) setWatchedComputerId(latest.id);
  }, [watchedComputer, watchedConversation, watchedComputerIsCurrent]);

  useEffect(() => {
    if (!watchedComputerId || watchedComputer) return;
    watchShouldRestoreFocus.current = false;
    watchReturnFocus.current = null;
    setWatchedComputerId(null);
  }, [active?.id, watchedComputerId, watchedComputer]);

  useEffect(() => {
    if (!watchedComputerId || !modalOpen) return;
    closeWatch(false);
  }, [modalOpen, watchedComputerId]);

  useEffect(() => {
    if (!snapshot || !active || watchedComputerId || modalOpen) return;
    const candidate = [active]
      .filter((conversation) => conversation.status === "running")
      .flatMap((conversation) => conversation.agentComputers ?? [])
      .sort((left, right) => Number(right.role === "lead") - Number(left.role === "lead") || right.updatedAt - left.updatedAt)
      .find((computer) => computer.isolation === "cloud-browser" && (computer.actions.some((action) => ["browser", "screen", "automation"].includes(action.capability)) || computer.evidence.length > 0) && !autoWatchedComputerIds.current.has(computer.id));
    if (!candidate) return;
    autoWatchedComputerIds.current.add(candidate.id);
    openWatch(candidate.id, false);
  }, [snapshot, active, watchedComputerId, modalOpen]);

  if (!snapshot || !active) {
    if (uiError) return <div className="loading-screen startup-error"><BotMascot mood="error" size="lg" label="Grokky startup failed" /><strong>Grokky couldn’t start</strong><p>{uiError}</p><button type="button" onClick={() => { setUiError(""); void window.grokky.getSnapshot().then(setSnapshot).catch((error) => setUiError(error.message)); }}>Retry</button></div>;
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

  async function createSession() {
    if (creatingSession.current) return;
    creatingSession.current = true;
    setSessionBusy(true);
    try {
      await window.grokky.createConversation();
      setSearch("");
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "The session could not be created");
    } finally {
      creatingSession.current = false;
      setSessionBusy(false);
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
  const activeDevice = active.provider === "codex"
    ? snapshot.computerAccess.devices.find((device) => device.kind === "local")
    : snapshot.computerAccess.devices.find((device) => device.id === snapshot.computerAccess.activeDeviceId);

  return (
    <div className={`app-shell ${watchedComputer && watchedConversation && !modalOpen ? "desktop-open" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--watch-width": `${watchWidth}px` } as CSSProperties}>
      <aside className="session-sidebar">
        <div className="window-drag" />
        <div className="brand-row">
          <BrandMark />
          <div><strong>Grokky</strong><span>Local agent workspace</span></div>
          <button className="icon-button new-session" type="button" title="New session" aria-label={sessionBusy ? "Creating session" : "New session"} aria-busy={sessionBusy} disabled={sessionBusy} onClick={() => void createSession()}>{sessionBusy ? <InlineLoader label="Creating session" quiet /> : <Plus size={18} />}</button>
        </div>
        <label className="search-box">
          <MagnifyingGlass size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search sessions" />
          {search && <button type="button" aria-label="Clear session search" onClick={() => setSearch("")}><X size={13} /></button>}
        </label>
        <nav className="session-list" aria-label="Conversations">
          {filtered.map((conversation) => {
            const selectedAgents = agents.filter((agent) => conversation.selectedAgentIds.includes(agent.id));
            return (
              <Fragment key={conversation.id}>
                <div className="session-entry">
                  <button className={`session-item ${conversation.id === active.id ? "active" : ""}`} type="button" onClick={() => void window.grokky.setActiveConversation(conversation.id).catch((error) => setUiError(error instanceof Error ? error.message : "The session could not be opened"))}>
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
                      const computer = (conversation.agentComputers ?? []).findLast((candidate) => candidate.agentId === agent.id || candidate.agentName.toLowerCase() === agent.name.toLowerCase());
                      return (
                        <button key={agent.id} type="button" onClick={() => {
                          void window.grokky.setActiveConversation(conversation.id)
                            .then(() => { if (computer) openWatch(computer.id); })
                            .catch((error) => setUiError(error instanceof Error ? error.message : "The conversation could not be opened"));
                        }}>
                          <BotMascot mood={state.complete ? "success" : state.active ? "working" : "idle"} identity={agent.name} variant={agent.icon} size="micro" />
                          <span><strong>{agent.name}</strong><small>{state.label}</small></span>
                          {computer ? <Eye className="sidebar-watch-icon" size={12} /> : <i className={state.active ? "active" : state.complete ? "complete" : ""} />}
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
          <button type="button" data-feature-center="routines" onClick={() => setFeatureCenterView("routines")}><ClockCounterClockwise size={17} />Routines{snapshot.routines.length > 0 && <em className="sidebar-feature-count">{snapshot.routines.length}</em>}</button>
          <button type="button" data-feature-center="attention" onClick={() => setFeatureCenterView("attention")}><WarningCircle size={17} />Attention{snapshot.attention.some((item) => item.status === "open") && <em className="sidebar-feature-count warning">{snapshot.attention.filter((item) => item.status === "open").length}</em>}</button>
          {!snapshot.settings.onboardingComplete && <button type="button" data-feature-center="setup" onClick={() => setFeatureCenterView("setup")}><Sparkle size={17} />Quick setup<em className="sidebar-feature-count warning">!</em></button>}
          <button type="button" data-settings-tab="agents" onClick={() => setSettingsTab("agents")}><UsersThree size={17} />Crew</button>
          <button type="button" data-settings-tab="computer" onClick={() => setSettingsTab("computer")}><DesktopTower size={17} />Computer</button>
          <button type="button" data-settings-tab="skills" onClick={() => setSettingsTab("skills")}><PuzzlePiece size={17} />Skills & tools</button>
          <button type="button" data-settings-tab="session" onClick={() => setSettingsTab("session")}><GearSix size={17} />Settings</button>
        </div>
      </aside>

      <div
        className="session-sidebar-resizer"
        role="separator"
        aria-label="Resize session sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onPointerDown={beginSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={endSidebarResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setSidebarWidth((value) => clampSidebarWidth(value - 16));
          else if (event.key === "ArrowRight") setSidebarWidth((value) => clampSidebarWidth(value + 16));
          else if (event.key === "Home") setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          else return;
          event.preventDefault();
        }}
      />

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
              {(active.agentComputers ?? []).findLast((computer) => computer.role === "lead") && <button className="icon-button watch-toolbar" data-tooltip="Watch Grokky's computer" aria-label="Watch Grokky's computer" type="button" onClick={() => openWatch((active.agentComputers ?? []).findLast((computer) => computer.role === "lead")!.id)}><Eye size={17} weight="duotone" /></button>}
              <button className={`icon-button computer-toolbar ${snapshot.computerAccess.enabled && activeDevice?.status === "online" ? "connected" : ""}`} data-tooltip={snapshot.computerAccess.enabled ? `${active.provider === "codex" ? "Codex local session" : "Computer"}: ${activeDevice?.name || "Unavailable"}` : "Computer access is off"} aria-label={snapshot.computerAccess.enabled ? `${active.provider === "codex" ? "Codex local session" : "Computer"}: ${activeDevice?.name || "Unavailable"}` : "Computer access is off"} type="button" onClick={() => setSettingsTab("computer")}><DesktopTower size={17} weight="duotone" /></button>
              {!activeStatus?.ready && <button className="icon-button setup-warning" data-tooltip={activeStatus?.detail || "Provider needs setup"} aria-label={activeStatus?.detail || "Provider needs setup"} type="button" onClick={() => setSettingsTab("session")}><WarningCircle size={17} /></button>}
              <button className="icon-button" data-tooltip="Session settings" aria-label="Session settings" type="button" onClick={() => setSettingsTab("session")}><GearSix size={17} /></button>
              <button className="icon-button danger" data-tooltip={active.status === "running" ? "Stop the run before deleting this chat" : "Delete chat"} aria-label={active.status === "running" ? "Stop the run before deleting this chat" : "Delete chat"} type="button" onClick={() => requestDelete(active)} disabled={active.status === "running"}><Trash size={16} /></button>
            </div>
          </div>
        </header>

        <MessageList conversation={active} agents={agents} onWatchComputer={openWatch} />
        <Composer conversation={active} drafts={drafts} agents={agents} recentDirectories={snapshot.settings.recentWorkingDirectories} multiAgentEnabled={snapshot.settings.multiAgentEnabled} maxAgents={snapshot.settings.maxAgentThreads} webSearchEnabled={snapshot.settings.webSearchEnabled} sandboxCommandsAvailable={Boolean(activeDevice?.kind === "remote" && activeDevice.status === "online" && activeDevice.capabilities.includes("commands"))} onOpenAgents={() => setSettingsTab("agents")} onError={setUiError} />
      </main>

      {settingsTab && <SettingsDialog snapshot={snapshot} conversation={active} agents={agents} initialTab={settingsTab} onAgentsChange={setAgents} onClose={() => setSettingsTab(null)} onError={setUiError} />}

      {featureCenterView && <FeatureCenter snapshot={snapshot} conversation={active} initialView={featureCenterView} onClose={() => setFeatureCenterView(null)} onError={setUiError} />}

      {pendingDelete && <DeleteConversationDialog title={pendingDelete.title} busy={deleteBusy} onCancel={() => { if (!deleteBusy) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} />}

      {snapshot.computerAccess.pendingApproval && <ComputerApprovalDialog request={snapshot.computerAccess.pendingApproval} busy={approvalBusy} onDecision={(decision) => void resolveComputerApproval(snapshot.computerAccess.pendingApproval!, decision)} />}

      {!modalOpen && watchedComputer && watchedConversation && <AgentWatchDrawer
        computer={watchedComputer}
        conversation={watchedConversation}
        phone={snapshot.phone}
        build={`${snapshot.appVersion} · ${snapshot.buildIdentity ?? "development"}`}
        liveViewUrl={snapshot.phone?.computerId === watchedComputer.id && snapshot.phone.owner !== "agent" ? undefined : snapshot.agentComputerLiveViews[watchedComputer.id]}
        watchWidth={watchWidth}
        focusOnMount={watchShouldRestoreFocus.current}
        onResizeStart={beginWatchResize}
        onResizeMove={moveWatchResize}
        onResizeEnd={endWatchResize}
        onResetWidth={() => setWatchWidth(DEFAULT_WATCH_WIDTH)}
        onResizeKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWatchWidth((value) => clampWatchWidth(value + 24));
          else if (event.key === "ArrowRight") setWatchWidth((value) => clampWatchWidth(value - 24));
          else if (event.key === "Home") setWatchWidth(DEFAULT_WATCH_WIDTH);
          else return;
          event.preventDefault();
        }}
        onClose={() => closeWatch()}
        onError={setUiError}
      />}

      {uiError && <div className="toast" role="alert"><WarningCircle size={17} /><span>{uiError}</span><button type="button" aria-label="Dismiss error" onClick={() => setUiError("")}><X size={14} /></button></div>}
    </div>
  );
}
