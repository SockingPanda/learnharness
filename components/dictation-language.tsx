"use client";
import { useI18n } from "@/components/i18n";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DICTATION_LANGUAGES, type DictationLanguage } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

type LanguagePreference = ReturnType<typeof useDictationLanguage>;

/** Translate catalog labels only; provider language codes stay unchanged. */
function languageLabel(item: (typeof DICTATION_LANGUAGES)[number], t: ReturnType<typeof useI18n>["t"]) {
	const suffix = ` (${item.code})`;
	return item.label.endsWith(suffix) ? `${t(item.label.slice(0, -suffix.length))}${suffix}` : t(item.label);
}

export function DictationLanguageSetting() {
	const { t } = useI18n();
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label={t("Language")} testid="row-dictation-language" dimmed={active}>
		<DictationLanguagePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

function DictationLanguagePicker({ preference, disabled }: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { t } = useI18n();
	const { language, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const selected = DICTATION_LANGUAGES.find((item) => item.code === language);
	const label = selected ? languageLabel(selected, t) : "—";

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-language-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (code: DictationLanguage) => {
		if (disabled || saving || language === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ? t(error) : t("Dictation language: {language}", { language: label })} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-language"
				aria-label={t("Dictation language: {language}", { language: label })}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (language === undefined) void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-language-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					// Empty search results must not submit the composer, but a
					// focused option button still needs Enter's native click.
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				{error && <div role="alert" className="mb-1.5 text-destructive">{t(error)}</div>}
				<SearchMenuList
					items={DICTATION_LANGUAGES}
					itemKey={(item) => item.code}
					searchTerms={(item) => [item.code, item.label, languageLabel(item, t)]}
					isSelected={(item) => item.code === language}
					onPick={(item) => { void pick(item.code); }}
					disabled={saving || language === undefined}
					searchTestid="dictation-language-search"
					listTestid="dictation-language-list"
					optionTestid={(item) => `dictation-language-${item.code}`}
					ariaLabel={t("Search dictation languages")}
					placeholder={t("Search languages…")}
					empty={t("No languages match.")}
					renderItem={(item) => <span className="text-card-foreground">{languageLabel(item, t)}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}
