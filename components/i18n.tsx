"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	APP_DESCRIPTION, createTranslator, isLocalePreference, LOCALE_CHANGE_SIGNAL, readLocaleCookie,
	resolveUiLocale, serializeLocaleCookie,
	type LocalePreference, type Translator, type UiLocale,
} from "@/src/core";

type I18nValue = {
	locale: UiLocale;
	preference: LocalePreference;
	t: Translator;
	setPreference: (preference: LocalePreference) => void;
};

// Standalone render tests and embedding surfaces retain the English default.
const I18nContext = createContext<I18nValue>({
	locale: "en", preference: "system", t: createTranslator("en"), setPreference: () => {},
});

function browserLanguages(): readonly string[] {
	return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function I18nProvider({
	children, initialLocale = "en", initialPreference = "system",
}: {
	children: React.ReactNode;
	initialLocale?: UiLocale;
	initialPreference?: LocalePreference;
}) {
	// The server supplies these two values together, so hydration uses exactly
	// the same language. There is no process-global mutable translator.
	const [preference, setPreferenceState] = useState(initialPreference);
	const [locale, setLocale] = useState(initialLocale);
	const preferenceRef = useRef(initialPreference);
	const apply = useCallback((next: LocalePreference) => {
		preferenceRef.current = next;
		setPreferenceState(next);
		setLocale(resolveUiLocale(next, browserLanguages()));
	}, []);

	useEffect(() => {
		apply(preferenceRef.current);
		const sync = () => apply(readLocaleCookie(document.cookie));
		const languageChanged = () => apply(preferenceRef.current);
		const storageChanged = (event: StorageEvent) => {
			if (event.key === LOCALE_CHANGE_SIGNAL) sync();
		};
		window.addEventListener("languagechange", languageChanged);
		window.addEventListener("storage", storageChanged);
		window.addEventListener("focus", sync);
		window.addEventListener(LOCALE_CHANGE_SIGNAL, sync);
		return () => {
			window.removeEventListener("languagechange", languageChanged);
			window.removeEventListener("storage", storageChanged);
			window.removeEventListener("focus", sync);
			window.removeEventListener(LOCALE_CHANGE_SIGNAL, sync);
		};
	}, [apply]);

	useEffect(() => {
		document.documentElement.lang = locale;
		document.querySelector('meta[name="description"]')?.setAttribute("content", createTranslator(locale)(APP_DESCRIPTION));
	}, [locale]);

	const setPreference = useCallback((next: LocalePreference) => {
		if (!isLocalePreference(next)) return;
		document.cookie = serializeLocaleCookie(next);
		apply(next);
		window.dispatchEvent(new Event(LOCALE_CHANGE_SIGNAL));
		// The cookie is the source of truth. localStorage only broadcasts an
		// invalidation to other windows; no second language setting is stored.
		try { localStorage.setItem(LOCALE_CHANGE_SIGNAL, `${Date.now()}:${Math.random()}`); }
		catch { /* Storage restrictions do not prevent this window switching. */ }
	}, [apply]);

	const value = useMemo(() => ({ locale, preference, t: createTranslator(locale), setPreference }), [locale, preference, setPreference]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	return useContext(I18nContext);
}
