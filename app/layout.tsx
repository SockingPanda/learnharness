import type { Metadata } from "next";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { I18nProvider } from "@/components/i18n";
import { APP_DESCRIPTION, LOCALE_COOKIE, localePreference, preferredLanguages, resolveUiLocale, translateUi } from "@/src/core";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

const requestLanguage = cache(async () => {
	const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
	const preference = localePreference(cookieStore.get(LOCALE_COOKIE)?.value);
	const locale = resolveUiLocale(preference, preferredLanguages(requestHeaders.get("accept-language")));
	return { preference, locale };
});

export async function generateMetadata(): Promise<Metadata> {
	const { locale } = await requestLanguage();
	return { title: "Learning Harness", description: translateUi(locale, APP_DESCRIPTION) };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const { preference, locale } = await requestLanguage();
	return (
		<html lang={locale} className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			<I18nProvider initialLocale={locale} initialPreference={preference}>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			</I18nProvider>
		</body>
		</html>
	);
}
