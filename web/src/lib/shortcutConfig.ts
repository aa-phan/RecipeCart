// Placeholder for the iCloud share link of the pre-built RecipeCart iOS
// Shortcut (see docs/ios-shortcut.md §4). No real link can be minted from
// this repo — an iCloud Shortcut link only exists once a human builds the
// Shortcut by hand in the Shortcuts app on their own iPhone and taps
// "Copy iCloud Link." That's a genuine, undelegatable manual step.
//
// Because docs/ios-shortcut.md §3.2 moved token entry into a first-run
// "Ask for Input" prompt (stored per-device in iCloud Drive) instead of
// baking a specific token into the Shortcut's actions, the Shortcut is now
// generic — the SAME iCloud link works for every install, and each person
// who taps it is prompted for their own token on their own first run.
//
// Once someone builds that Shortcut and copies its iCloud link, paste it
// here to activate the "Add Shortcut to your device" button on /setup.
// Leave empty to keep that button hidden/disabled.
//
// Set 2026-07-20: real link for the built-and-verified Shortcut (first-run
// iCloud-Drive token prompt, real share -> submit -> Choose from Menu ->
// Open URLs confirmed working end-to-end on a real device).
export const SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/b359847eabd442068e622cced4410ebc";
