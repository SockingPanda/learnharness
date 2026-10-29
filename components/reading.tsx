"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/i18n";
import { ArrowRightIcon, BookOpenIcon, CornerUpLeftIcon, GitBranchIcon, XIcon } from "lucide-react";
import { PlanDiagram } from "@/components/plan-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	messageAnchorId, propositionSessionHref, readingNodeHistory,
	type ArtifactPartProps, type GraphSnapshot, type ReadingBlock, type ReadingEvent,
	type ReadingNote, type ReadingState, type ReadingNavigation, type LhMessage,
} from "@/src/core";

const NOTE_LABEL = { understanding: "My understanding", discovery: "My discovery", question: "Open questions" } as const;
const CONTROL = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40";

export function ReadingSource({ blocks, url }: { blocks: readonly ReadingBlock[]; url?: string }) {
	const { t } = useI18n();
	return <details className="my-2 rounded-lg border border-border/70 text-xs" data-testid="reading-original">
		<summary className="cursor-pointer px-3 py-2 text-muted-foreground">{t(blocks.length === 1 ? "View original · {count} passage" : "View original · {count} passages", { count: blocks.length })}</summary>
		<div className="space-y-4 border-t px-4 py-3 font-prose text-(length:--lh-prose-size)">
			{blocks.map((block) => <div key={block.id} id={`reading-source-${block.id}`}><MessageResponse>{block.markdown}</MessageResponse></div>)}
			{url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">{t("Open article webpage ↗")}</a>}
		</div>
	</details>;
}

/** The source expander is attached to the passage that was actually read,
 * so later detours never change the original beside an older explanation. */
export function ReadingArtifact({ part }: ArtifactPartProps) {
	const { t } = useI18n();
	if (part.state === "output-error") return <ToolCallCard part={part} />;
	if (part.state !== "output-available") return null;
	const output = part.output as { readingEvent?: ReadingEvent; source?: ReadingBlock[]; url?: string; title?: string } | undefined;
	const event = output?.readingEvent;
	if (!event) return null;
	if (event.kind === "source") return <div className="my-3 flex items-center gap-2 text-sm text-muted-foreground"><BookOpenIcon className="size-4 shrink-0" /><span>{event.article.title}</span></div>;
	if (event.kind === "focus" && (event.action === "read" || event.action === "return")) return <ReadingSource blocks={output?.source ?? []} url={output?.url} />;
	if (event.kind === "note") return <div id={part.resultMessageId ? messageAnchorId(part.resultMessageId) : undefined} data-testid="reading-saved-note" className="my-2 border-l-2 border-sky-400/60 pl-3 text-sm">
		<span className="mr-2 text-xs text-muted-foreground">{t(NOTE_LABEL[event.note.kind])}</span>{event.note.text}
	</div>;
	return null;
}

export function ReadingToolbar({ state, busy, onOpen, onAction }: {
	state: ReadingState; busy: boolean; onOpen: () => void; onAction: (navigation: ReadingNavigation) => void;
}) {
	const { t } = useI18n();
	const bookmark = state.nodes.find((n) => n.id === state.readNodeId);
	const discussion = state.nodes.find((n) => n.id === state.discussionNodeId);
	const detour = discussion && discussion.id !== bookmark?.id;
	return <div data-testid="reading-toolbar" className="pointer-events-auto mb-2 space-y-2 rounded-xl border border-border bg-card/95 px-3 py-2">
		<div className="flex min-w-0 items-center gap-2 text-xs">
			<BookOpenIcon className="size-3.5 shrink-0 text-sky-400" />
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{state.finished ? t("Finished reading; keep discussing or revisit the article") : bookmark ? t("Article bookmark: {title}", { title: bookmark.title }) : t("Ready to start reading")}</span>
			<button type="button" onClick={onOpen} className="shrink-0 cursor-pointer text-foreground hover:underline">{state.notes.length ? t("Route and notes · {count}", { count: state.notes.length }) : t("Route and notes")}</button>
		</div>
		{detour && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranchIcon className="size-3" />{t("Exploring: {title}", { title: discussion.title })}</p>}
		{state.nodes.length > 0 && <div className="flex flex-wrap gap-2">
			{detour && <button type="button" disabled={busy} className={CONTROL} onClick={() => onAction({ action: "return" })}><CornerUpLeftIcon className="size-3" />{t("Return to article")}</button>}
			<button type="button" disabled={busy} data-testid="reading-continue" className={`${CONTROL} bg-foreground text-background hover:bg-foreground/85`} onClick={() => onAction({ action: state.finished ? "review" : "next" })}>{t(state.finished ? "Review what you learned" : "Continue reading")}<ArrowRightIcon className="size-3" /></button>
			{!state.finished && <button type="button" disabled={busy} className={CONTROL} onClick={() => onAction({ action: "skip" })}>{t("Skip this section")}</button>}
		</div>}
	</div>;
}

export function ReadingDiagram({ state, showBranches, onSelect }: { state: ReadingState; showBranches: boolean; onSelect: (id: string) => void }) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const activePath = new Set<string>();
	let current = state.nodes.find((n) => n.id === state.discussionNodeId);
	while (current?.parentId && !activePath.has(current.id)) {
		activePath.add(current.id);
		current = state.nodes.find((n) => n.id === current!.parentId);
	}
	const nodes = state.nodes.filter((n) => !n.parentId || showBranches || activePath.has(n.id));
	const main = nodes.filter((n) => !n.parentId);
	const edges = [
		...main.slice(1).map((n, i) => ({ from: main[i]!.id, to: n.id })),
		...nodes.filter((n) => n.parentId).map((n) => ({ from: n.parentId!, to: n.id, discussion: true })),
	];
	return <div className="mx-auto w-full max-w-3xl px-6 py-6" data-testid="reading-diagram">
		<PlanDiagram nodes={nodes} edges={edges} markerId={markerId} pad={28} textCapScale={1.1}
			bookmarkId={state.readNodeId} glowId={state.discussionNodeId} onSelectNode={onSelect}
			statusOf={(id) => id === state.discussionNodeId || id === state.readNodeId ? "current" : state.visited.includes(id) ? "visited" : "upcoming"} />
	</div>;
}

function PersonalNote({ note, state, chatId, onClose }: { note: ReadingNote; state: ReadingState; chatId: string; onClose: () => void }) {
	const { t } = useI18n();
	return <article className="space-y-2 rounded-lg border border-border bg-card px-4 py-3" data-testid="reading-note">
		<div className="text-xs text-muted-foreground">{t(NOTE_LABEL[note.kind])} · {state.nodes.find((n) => n.id === note.nodeId)?.title}</div>
		<p className="font-prose text-(length:--lh-prose-size)">{note.text}</p>
		<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("My original words")}</summary>
			{note.evidence.map((e, i) => <a key={i} className="mt-2 block border-l border-border pl-3 underline" href={`/chat/${encodeURIComponent(chatId)}#${encodeURIComponent(messageAnchorId(e.messageId))}`} onClick={onClose}>“{e.quote}”</a>)}
		</details>
		<ReadingSource blocks={state.article?.blocks.filter((b) => note.blockIds.includes(b.id)) ?? []} url={state.article?.url} />
	</article>;
}

function ReadingKnowledge({ chatId, relatedIds }: { chatId: string; relatedIds: readonly string[] }) {
	const { t } = useI18n();
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [error, setError] = useState(false);
	const mounted = useRef(true);
	const refresh = useCallback(() => {
		void fetch("/api/graph").then((res) => { if (!res.ok) throw new Error("graph"); return res.json() as Promise<GraphSnapshot>; })
			.then((data) => { if (mounted.current) { setSnapshot(data); setError(false); } }).catch(() => { if (mounted.current) setError(true); });
	}, []);
	useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
	useServerEvent("activity-changed", refresh);
	useServerResync(refresh);
	const nodes = snapshot?.propositions.filter((n) => relatedIds.includes(n.id) || n.provenance.some((p) => p.chatId === chatId)) ?? [];
	return <div className="space-y-3">
		<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>{t("Ideas from this reading in your knowledge graph")}</span><button type="button" className="cursor-pointer underline" onClick={refresh}>{t("Refresh")}</button><Link href="/" className="ml-auto underline">{t("Open full knowledge graph ↗")}</Link></div>
		{error ? <p role="alert">{t("Could not load the knowledge graph. Please try again.")}</p> : !snapshot ? <p className="text-sm text-muted-foreground">{t("Loading knowledge graph…")}</p> : nodes.length === 0 ? <p className="text-sm text-muted-foreground">{t("This reading has no graph entries yet. They will appear after the graph updates; you can also check the graph progress indicator above.")}</p> : nodes.map((node) => {
			const sources = [...new Set(node.provenance.map((p) => p.chatId))];
			return <details key={node.id} className="rounded-lg border border-border bg-card px-4 py-3">
				<summary className="cursor-pointer font-prose text-(length:--lh-prose-size)">{node.name}{sources.some((id) => id !== chatId) && <span className="ml-2 font-ui text-xs text-sky-400">{t("Connected to earlier knowledge")}</span>}</summary>
				<p className="mt-2 font-prose text-(length:--lh-prose-size)">{node.statement}</p>
				<div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">{sources.map((id) => snapshot.sessions[id] ? <Link key={id} href={propositionSessionHref(node, id)} className="underline">{snapshot.sessions[id]}</Link> : <span key={id}>{t("Note source")}</span>)}</div>
			</details>;
		})}
	</div>;
}

export function ReadingPanel({ state, messages = [], chatId, busy, onClose, onAction }: {
	state: ReadingState; messages?: readonly LhMessage[]; chatId: string; busy: boolean; onClose: () => void; onAction: (navigation: ReadingNavigation) => void;
}) {
	const { t } = useI18n();
	const [tab, setTab] = useState<"route" | "notes" | "knowledge">("route");
	const [showBranches, setShowBranches] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		closeButton.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
			if (e.key === "Tab") {
				const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, input, [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
				const first = controls[0], last = controls.at(-1);
				if (e.shiftKey && document.activeElement === first && last) { e.preventDefault(); last.focus(); }
				else if (!e.shiftKey && document.activeElement === last && first) { e.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener("keydown", onKey);
		return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
	}, [onClose]);
	const selected = state.nodes.find((n) => n.id === selectedId) ?? state.nodes.find((n) => n.id === state.discussionNodeId);
	const notes = useMemo(() => selected ? state.notes.filter((n) => n.nodeId === selected.id) : [], [selected, state.notes]);
	const history = useMemo(() => selected ? readingNodeHistory(messages, selected.id) : [], [selected, messages]);
	const act = (navigation: ReadingNavigation) => { onClose(); onAction(navigation); };
	return <div ref={root} role="dialog" aria-modal="true" aria-label={t("Reading route and notes")} data-testid="reading-panel" className="absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm">
		<div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
			<BookOpenIcon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm">{state.article?.title ?? t("Reading route and notes")}</span>
			<button ref={closeButton} type="button" onClick={onClose} aria-label={t("Close reading route and notes")} className="cursor-pointer rounded-md p-1.5 hover:bg-accent"><XIcon className="size-4" /></button>
		</div>
		<div className="flex gap-2 border-b px-4 py-2" role="group" aria-label={t("Reading views")}>
			{([["route", t("Reading route")], ["notes", t("My notes · {count}", { count: state.notes.length })], ["knowledge", t("Knowledge connections")]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`${CONTROL} ${tab === key ? "bg-accent" : "border-transparent text-muted-foreground"}`}>{label}</button>)}
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto p-4">
			{tab === "route" && <>
				<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span className="text-sky-400">{t("Blue outline: article bookmark")}</span><span>{t("Yellow glow: current discussion")}</span><span>{t("Solid lines: reading order · Dashed lines: discussion branches")}</span></div>
				<label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showBranches} onChange={(e) => setShowBranches(e.target.checked)} />{t("Expand all discussion branches")}</label>
				{state.nodes.length ? <ReadingDiagram state={state} showBranches={showBranches} onSelect={setSelectedId} /> : <p className="my-6 text-sm text-muted-foreground">{t("The reading route will appear here after the guide reviews the article.")}</p>}
				{selected && <section className="mx-auto max-w-3xl space-y-3 border-t pt-4">
					<div className="flex flex-wrap items-center gap-2"><h2 className="flex-1 font-prose text-lg">{selected.title}</h2><span className="text-xs text-muted-foreground">{t(state.skipped.includes(selected.id) ? "Skipped" : selected.id === state.discussionNodeId ? "Current discussion" : selected.id === state.readNodeId ? "Article bookmark" : state.visited.includes(selected.id) ? "Read / discussed" : "Not explored yet")}</span></div>
					{selected.summary && <p className="font-prose text-(length:--lh-prose-size) text-muted-foreground">{selected.summary}</p>}
					<ReadingSource blocks={state.article?.blocks.filter((b) => selected.blockIds.includes(b.id)) ?? []} url={state.article?.url} />
					<button type="button" disabled={busy} className={CONTROL} onClick={() => act({ action: selected.parentId ? "discuss" : "read", nodeId: selected.id })}>{t(selected.parentId ? "Explore this question further" : "Read from here")}</button>
					{history.length > 0 && <details className="rounded-lg border border-border px-4 py-3 text-sm"><summary className="cursor-pointer">{t("Revisit related discussion · {count}", { count: history.length })}</summary><div className="mt-3 space-y-3">{history.map((item) => <a key={item.messageId} href={`/chat/${encodeURIComponent(chatId)}#${encodeURIComponent(messageAnchorId(item.messageId))}`} onClick={onClose} className="block border-l-2 border-border pl-3"><span className="text-xs text-muted-foreground">{t(item.role === "user" ? "My words" : "Reading guidance")}</span><p className="mt-1 whitespace-pre-line font-prose">{item.text.length > 240 ? `${item.text.slice(0, 240)}…` : item.text}</p></a>)}</div></details>}
					{notes.map((note) => <PersonalNote key={note.id} note={note} state={state} chatId={chatId} onClose={onClose} />)}
				</section>}
			</>}
			{tab === "notes" && <div className="mx-auto max-w-3xl space-y-3"><p className="text-xs text-muted-foreground">{t("Notes reflect the understanding, discoveries and questions you actually expressed. Add to or revise them in the conversation at any time.")}</p>{state.notes.length ? state.notes.map((note) => <PersonalNote key={note.id} note={note} state={state} chatId={chatId} onClose={onClose} />) : <p className="text-sm text-muted-foreground">{t("Ask questions and share your understanding while reading; your notes will collect here.")}</p>}</div>}
			{tab === "knowledge" && <div className="mx-auto max-w-3xl"><ReadingKnowledge chatId={chatId} relatedIds={state.notes.flatMap((n) => n.graphNodeIds)} /></div>}
		</div>
	</div>;
}
