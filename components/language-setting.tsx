"use client";

import { isLocalePreference } from "@/src/core";
import { useI18n } from "@/components/i18n";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";

export function LanguageSetting() {
	const { t, preference, setPreference } = useI18n();
	return <SettingsRow label={t("Interface language")} hint={t("Saved on this device. Applies to the interface.")} testid="row-interface-language">
		<ThinSelect value={preference} ariaLabel={t("Interface language")} testid="interface-language" onChange={(value) => {
			if (isLocalePreference(value)) setPreference(value);
		}}>
			<option value="system">{t("Follow system")}</option>
			<option value="zh-CN">简体中文</option>
			<option value="en">English</option>
		</ThinSelect>
	</SettingsRow>;
}
