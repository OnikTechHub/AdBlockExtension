/**
 * Shared Type Definitions for Chrome Blocks
 */

export interface ModuleSettings {
  blockYouTubeAds: boolean;
  blockSocialAds: boolean;
  blockCookieBanners: boolean;
}

export interface CustomFilters {
  [domain: string]: string[];
}

export interface StorageData {
  isEnabled?: boolean;
  totalBlocked?: number;
  todayBlocked?: number;
  lastResetDate?: string;
  whitelistedDomains?: string[];
  customFilters?: CustomFilters;
  moduleSettings?: ModuleSettings;
}

export type ExtensionMessage =
  | { type: 'GET_STATS' }
  | { type: 'TOGGLE_ENABLE' }
  | { type: 'TOGGLE_WHITELIST_DOMAIN'; domain: string }
  | { type: 'ADD_CUSTOM_FILTER'; domain: string; selector: string }
  | { type: 'RESET_STATS' }
  | { type: 'AD_BLOCKED'; count: number; domain: string }
  | { type: 'GET_TAB_STATS' }
  | { type: 'START_ELEMENT_PICKER' };

export interface StatsResponse {
  isEnabled: boolean;
  totalBlocked: number;
  todayBlocked: number;
  whitelistedDomains: string[];
}

export interface ToggleEnableResponse {
  isEnabled: boolean;
}

export interface WhitelistResponse {
  success: boolean;
  isWhitelisted: boolean;
  whitelistedDomains: string[];
}

export interface TabStatsResponse {
  domain: string;
  blockedOnPage: number;
  isWhitelisted: boolean;
  isEnabled: boolean;
}
