// Client-side clipboard write for the checkout shortcuts. Isolated here so
// tests can exercise the fallbacks (no navigator, rejected write) without a
// React Native environment. The call must happen inside a user gesture
// (Pressable onPress) or webviews may deny the clipboard.
export async function copyTextToClipboard(text, clipboardProvider) {
  const clipboard = clipboardProvider ?? globalThis.navigator?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    throw new Error("Clipboard unavailable in this environment");
  }
  await clipboard.writeText(text);
}
