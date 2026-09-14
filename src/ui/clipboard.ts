import { Notice } from "obsidian";

/**
 * Copy text to the clipboard with an execCommand fallback — iOS and some
 * Android WebViews still refuse navigator.clipboard.
 */
export function copyText(text: string, notice = "Copied."): void {
  const fallback = () => {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(helper);
    new Notice(ok ? notice : "Could not copy to the clipboard.");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => new Notice(notice),
      () => fallback()
    );
    return;
  }
  fallback();
}
