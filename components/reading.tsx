"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
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

const NOTE_LABEL = { understanding: "我的理解", discovery: "我的发现", question: "待解问题" };
const CONTROL = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40";

export function ReadingSource({ blocks, url }: { blocks: readonly ReadingBlock[]; url?: string }) {
	return <details className="my-2 rounded-lg border border-border/70 text-xs" data-testid="reading-original">
		<summary className="cursor-pointer px-3 py-2 text-muted-foreground">查看对应原文 · {blocks.length} 段</summary>
		<div className="space-y-4 border-t px-4 py-3 font-prose text-(length:--lh-prose-size)">
			{blocks.map((block) => <div key={block.id} id={`reading-source-${block.id}`}><MessageResponse>{block.markdown}</MessageResponse></div>)}
			{url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">打开文章网页 ↗</a>}
		</div>
	</details>;
}

/** The source expander is attached to the passage that was actually read,
 * so later detours never change the original beside an older explanation. */
export function ReadingArtifact({ part }: ArtifactPartProps) {
	if (part.state === "output-error") return <ToolCallCard part={part} />;
	if (part.state !== "output-available") return null;
	const output = part.output as { readingEvent?: ReadingEvent; source?: ReadingBlock[]; url?: string; title?: string } | undefined;
	const event = output?.readingEvent;
	if (!event) return null;
	if (event.kind === "source") return <div className="my-3 flex items-center gap-2 text-sm text-muted-foreground"><BookOpenIcon className="size-4 shrink-0" /><span>{event.article.title}</span></div>;
	if (event.kind === "focus" && (event.action === "read" || event.action === "return")) return <ReadingSource blocks={output?.source ?? []} url={output?.url} />;
	if (event.kind === "note") return <div id={part.resultMessageId ? messageAnchorId(part.resultMessageId) : undefined} data-testid="reading-saved-note" className="my-2 border-l-2 border-sky-400/60 pl-3 text-sm">
		<span className="mr-2 text-xs text-muted-foreground">{NOTE_LABEL[event.note.kind]}</span>{event.note.text}
	</div>;
	return null;
}

export function ReadingToolbar({ state, busy, onOpen, onAction }: {
	state: ReadingState; busy: boolean; onOpen: () => void; onAction: (navigation: ReadingNavigation) => void;
}) {
	const bookmark = state.nodes.find((n) => n.id === state.readNodeId);
	const discussion = state.nodes.find((n) => n.id === state.discussionNodeId);
	const detour = discussion && discussion.id !== bookmark?.id;
	return <div data-testid="reading-toolbar" className="pointer-events-auto mb-2 space-y-2 rounded-xl border border-border bg-card/95 px-3 py-2">
		<div className="flex min-w-0 items-center gap-2 text-xs">
			<BookOpenIcon className="size-3.5 shrink-0 text-sky-400" />
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{state.finished ? "本篇已读完，可以继续讨论或回看" : bookmark ? `文章书签：${bookmark.title}` : "准备开始带读"}</span>
			<button type="button" onClick={onOpen} className="shrink-0 cursor-pointer text-foreground hover:underline">路线与记录{state.notes.length ? ` · ${state.notes.length}` : ""}</button>
		</div>
		{detour && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranchIcon className="size-3" />正在展开：{discussion.title}</p>}
		{state.nodes.length > 0 && <div className="flex flex-wrap gap-2">
			{detour && <button type="button" disabled={busy} className={CONTROL} onClick={() => onAction({ action: "return" })}><CornerUpLeftIcon className="size-3" />回到文章</button>}
			<button type="button" disabled={busy} data-testid="reading-continue" className={`${CONTROL} bg-foreground text-background hover:bg-foreground/85`} onClick={() => onAction({ action: state.finished ? "review" : "next" })}>{state.finished ? "回顾阅读收获" : "继续读"}<ArrowRightIcon className="size-3" /></button>
			{!state.finished && <button type="button" disabled={busy} className={CONTROL} onClick={() => onAction({ action: "skip" })}>跳过这一节</button>}
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
	return <article className="space-y-2 rounded-lg border border-border bg-card px-4 py-3" data-testid="reading-note">
		<div className="text-xs text-muted-foreground">{NOTE_LABEL[note.kind]} · {state.nodes.find((n) => n.id === note.nodeId)?.title}</div>
		<p className="font-prose text-(length:--lh-prose-size)">{note.text}</p>
		<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">我当时的表达</summary>
			{note.evidence.map((e, i) => <a key={i} className="mt-2 block border-l border-border pl-3 underline" href={`/chat/${encodeURIComponent(chatId)}#${encodeURIComponent(messageAnchorId(e.messageId))}`} onClick={onClose}>“{e.quote}”</a>)}
		</details>
		<ReadingSource blocks={state.article?.blocks.filter((b) => note.blockIds.includes(b.id)) ?? []} url={state.article?.url} />
	</article>;
}

function ReadingKnowledge({ chatId, relatedIds }: { chatId: string; relatedIds: readonly string[] }) {
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
		<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>这次阅读在知识图谱中的观点</span><button type="button" className="cursor-pointer underline" onClick={refresh}>刷新</button><Link href="/" className="ml-auto underline">打开完整知识图谱 ↗</Link></div>
		{error ? <p role="alert">暂时无法读取知识图谱，请重试。</p> : !snapshot ? <p className="text-sm text-muted-foreground">正在读取知识图谱……</p> : nodes.length === 0 ? <p className="text-sm text-muted-foreground">图谱中暂时没有这次阅读的内容。图谱更新后会显示在这里，也可以从顶部的图谱进度查看状态。</p> : nodes.map((node) => {
			const sources = [...new Set(node.provenance.map((p) => p.chatId))];
			return <details key={node.id} className="rounded-lg border border-border bg-card px-4 py-3">
				<summary className="cursor-pointer font-prose text-(length:--lh-prose-size)">{node.name}{sources.some((id) => id !== chatId) && <span className="ml-2 font-ui text-xs text-sky-400">连接了过往知识</span>}</summary>
				<p className="mt-2 font-prose text-(length:--lh-prose-size)">{node.statement}</p>
				<div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">{sources.map((id) => snapshot.sessions[id] ? <Link key={id} href={propositionSessionHref(node, id)} className="underline">{snapshot.sessions[id]}</Link> : <span key={id}>笔记来源</span>)}</div>
			</details>;
		})}
	</div>;
}

export function ReadingPanel({ state, messages = [], chatId, busy, onClose, onAction }: {
	state: ReadingState; messages?: readonly LhMessage[]; chatId: string; busy: boolean; onClose: () => void; onAction: (navigation: ReadingNavigation) => void;
}) {
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
	return <div ref={root} role="dialog" aria-modal="true" aria-label="阅读路线与记录" data-testid="reading-panel" className="absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm">
		<div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
			<BookOpenIcon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm">{state.article?.title ?? "阅读路线与记录"}</span>
			<button ref={closeButton} type="button" onClick={onClose} aria-label="关闭阅读路线与记录" className="cursor-pointer rounded-md p-1.5 hover:bg-accent"><XIcon className="size-4" /></button>
		</div>
		<div className="flex gap-2 border-b px-4 py-2" role="group" aria-label="阅读视图">
			{([["route", "阅读路线"], ["notes", `我的记录 · ${state.notes.length}`], ["knowledge", "知识连接"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`${CONTROL} ${tab === key ? "bg-accent" : "border-transparent text-muted-foreground"}`}>{label}</button>)}
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto p-4">
			{tab === "route" && <>
				<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span className="text-sky-400">蓝框：文章书签</span><span>黄光：当前讨论</span><span>实线：阅读顺序 · 虚线：讨论分支</span></div>
				<label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showBranches} onChange={(e) => setShowBranches(e.target.checked)} />展开全部讨论分支</label>
				{state.nodes.length ? <ReadingDiagram state={state} showBranches={showBranches} onSelect={setSelectedId} /> : <p className="my-6 text-sm text-muted-foreground">通读文章后，阅读路线会出现在这里。</p>}
				{selected && <section className="mx-auto max-w-3xl space-y-3 border-t pt-4">
					<div className="flex flex-wrap items-center gap-2"><h2 className="flex-1 font-prose text-lg">{selected.title}</h2><span className="text-xs text-muted-foreground">{state.skipped.includes(selected.id) ? "已跳过" : selected.id === state.discussionNodeId ? "当前讨论" : selected.id === state.readNodeId ? "文章书签" : state.visited.includes(selected.id) ? "已读 / 已讨论" : "尚未展开"}</span></div>
					{selected.summary && <p className="font-prose text-(length:--lh-prose-size) text-muted-foreground">{selected.summary}</p>}
					<ReadingSource blocks={state.article?.blocks.filter((b) => selected.blockIds.includes(b.id)) ?? []} url={state.article?.url} />
					<button type="button" disabled={busy} className={CONTROL} onClick={() => act({ action: selected.parentId ? "discuss" : "read", nodeId: selected.id })}>{selected.parentId ? "继续展开这个问题" : "从这里读"}</button>
					{history.length > 0 && <details className="rounded-lg border border-border px-4 py-3 text-sm"><summary className="cursor-pointer">回看相关讨论 · {history.length}</summary><div className="mt-3 space-y-3">{history.map((item) => <a key={item.messageId} href={`/chat/${encodeURIComponent(chatId)}#${encodeURIComponent(messageAnchorId(item.messageId))}`} onClick={onClose} className="block border-l-2 border-border pl-3"><span className="text-xs text-muted-foreground">{item.role === "user" ? "我的表达" : "带读讲解"}</span><p className="mt-1 whitespace-pre-line font-prose">{item.text.length > 240 ? `${item.text.slice(0, 240)}…` : item.text}</p></a>)}</div></details>}
					{notes.map((note) => <PersonalNote key={note.id} note={note} state={state} chatId={chatId} onClose={onClose} />)}
				</section>}
			</>}
			{tab === "notes" && <div className="mx-auto max-w-3xl space-y-3"><p className="text-xs text-muted-foreground">记录来自你实际表达的理解、发现和问题。随时可以在对话里补充或修改。</p>{state.notes.length ? state.notes.map((note) => <PersonalNote key={note.id} note={note} state={state} chatId={chatId} onClose={onClose} />) : <p className="text-sm text-muted-foreground">阅读中提出疑问、说说你的理解，记录会逐渐积累在这里。</p>}</div>}
			{tab === "knowledge" && <div className="mx-auto max-w-3xl"><ReadingKnowledge chatId={chatId} relatedIds={state.notes.flatMap((n) => n.graphNodeIds)} /></div>}
		</div>
	</div>;
}
