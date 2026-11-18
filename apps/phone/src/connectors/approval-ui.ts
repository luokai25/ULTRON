import type { Approval } from "./agent-loop";

/** A plain confirmation dialog for actions that change something outside the phone. Always asks; closes on any choice. */
export function askApproval(request: { tool: string; summary: string }): Promise<Approval> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "sheet-wrap"; wrap.style.zIndex = "90";
    const sheet = document.createElement("div");
    sheet.className = "sheet"; sheet.setAttribute("role", "alertdialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Approve action");
    const h = document.createElement("h2"); h.textContent = "Ultron wants to act in your apps";
    const p = document.createElement("p"); p.className = "native-model-status"; p.textContent = "Review what will be sent. Nothing runs until you allow it.";
    const pre = document.createElement("pre"); pre.className = "native-model-status"; pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;max-height:32vh;overflow:auto;font-size:12px"; pre.textContent = request.summary;
    const row = document.createElement("div"); row.className = "sheet-actions";
    const done = (v: Approval): void => { wrap.remove(); resolve(v); };
    const mk = (label: string, cls: string, v: Approval): HTMLButtonElement => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.addEventListener("click", () => done(v)); return b; };
    row.append(mk("Allow once", "solid", "once"), mk("Always allow this", "ghost", "always"), mk("Deny", "ghost danger", "deny"));
    sheet.append(h, p, pre, row); wrap.append(sheet); document.body.append(wrap);
    (row.firstElementChild as HTMLButtonElement).focus();
  });
}
