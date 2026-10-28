// Install state for the settings screen: the platform builder's useInstallPrompt
// (src/push/install.ts keeps the beforeinstallprompt event from page load and
// replays it from a click). Re-exported here so the settings screens and their
// tests have one import.
export { useInstallPrompt as useInstall, type InstallOutcome, type InstallState } from '../../push/install';
