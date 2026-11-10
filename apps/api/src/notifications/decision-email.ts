// The mail that asks the buyer to decide (ADR-0011). Pure, so every rule below has a test.
//
// Everything that is not ours comes from the contract or from a model that read the seller's
// page, so a seller can influence it. A mail is a good place to phish a buyer who is about to
// release money, hence: every outside text loses its links and is escaped, and the only link in
// the message is the one built here. The mail decides nothing: the link opens the screen, and
// the decision is taken there, signed in.
export interface DecisionItem {
  readonly text: string;
  readonly required: boolean;
  readonly level: "AUTOMATIC" | "AI_EVALUATED" | "HUMAN";
  readonly verdict: "PASS" | "FAIL" | "UNCERTAIN" | "NEEDS_HUMAN" | "PENDING";
  readonly reason: string;
  readonly flagged: boolean;
}

export interface DecisionEmailInput {
  readonly locale: string;
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly windowEndsAt: Date;
  readonly link: string;
  // Empty when the report could not be read: the mail still goes, because the warning is what
  // matters while the countdown runs.
  readonly items: readonly DecisionItem[];
}

const MAX_REASON = 500;

const COPY = {
  en: {
    removed: "[link removed]",
    subjectFail: (m: string) => `Action needed: the AI found a problem in "${m}"`,
    subjectFlag: (m: string) => `Action needed: possible manipulation in "${m}"`,
    subjectDecide: (m: string) => `Action needed: decide on "${m}"`,
    intro: (c: string, m: string) => `The seller delivered "${m}" in "${c}", and part of the payment is waiting for your decision.`,
    noReport: "Open Settld to read the verification report.",
    verdict: { PASS: "AI: looks met", FAIL: "AI: looks not met", UNCERTAIN: "Not sure", NEEDS_HUMAN: "Your call", PENDING: "Not checked yet" },
    flagged: "Warning: the delivery may be trying to manipulate the verifier. Check it yourself before approving.",
    opinion: "These are opinions from the AI. Nothing counts toward the payment unless you approve it.",
    options: "On the next screen you can approve it, or ask the seller to fix it.",
    deadline: (when: string) => `Decide before ${when}. If you do not, this part is not paid.`,
    deadlineRequired: (when: string) => `Decide before ${when}. This criterion is required: if you do not decide, nothing is paid and the work goes back to the seller.`,
    action: "Review and decide",
    quote: "Assessment",
  },
  es: {
    removed: "[enlace omitido]",
    subjectFail: (m: string) => `Acción necesaria: la IA encontró un problema en "${m}"`,
    subjectFlag: (m: string) => `Acción necesaria: posible manipulación en "${m}"`,
    subjectDecide: (m: string) => `Acción necesaria: decide sobre "${m}"`,
    intro: (c: string, m: string) => `El vendedor entregó "${m}" en "${c}", y parte del pago espera tu decisión.`,
    noReport: "Abre Settld para leer el reporte de verificación.",
    verdict: { PASS: "IA: parece cumplido", FAIL: "IA: parece no cumplido", UNCERTAIN: "Sin certeza", NEEDS_HUMAN: "Lo decides tú", PENDING: "Sin revisar" },
    flagged: "Advertencia: la entrega podría estar intentando manipular al verificador. Revísala tú antes de aprobar.",
    opinion: "Son opiniones de la IA. Nada cuenta para el pago si no lo apruebas.",
    options: "En la siguiente pantalla puedes aprobarlo, o pedirle al vendedor que lo corrija.",
    deadline: (when: string) => `Decide antes del ${when}. Si no lo haces, esta parte no se paga.`,
    deadlineRequired: (when: string) => `Decide antes del ${when}. Este criterio es obligatorio: si no decides, no se paga nada y el trabajo vuelve al vendedor.`,
    action: "Revisar y decidir",
    quote: "Evaluación",
  },
} as const;

// Bare domains and addresses too: mail clients turn "evil.example/login" into a link by themselves.
// \\p{L}, because \\w is ASCII only and an internationalized domain would walk through. The TLD
// needs two letters and an IP four numbers, so "Version 2.5" survives.
const LINK = /https?:\/\/\S+|(?:[\p{L}\p{N}._+-]+@)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:[/?#]\S*)?|\b\d{1,3}(?:\.\d{1,3}){3}\b(?:[/?#:]\S*)?/giu;

export function stripLinks(text: string, locale: string): string {
  return text.replace(LINK, copyFor(locale).removed);
}

function copyFor(locale: string) {
  return locale === "es" ? COPY.es : COPY.en;
}

export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

export function cut(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON).trimEnd()}…`;
}

export function formatWhen(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function buildDecisionEmail(input: DecisionEmailInput): { subject: string; text: string; html: string } {
  const copy = copyFor(input.locale);
  const safe = (text: string) => stripLinks(text, input.locale);
  const milestone = oneLine(safe(input.milestoneTitle));
  const contract = oneLine(safe(input.contractTitle));
  const items = input.items.map((item) => ({
    text: oneLine(safe(item.text)),
    label: copy.verdict[item.verdict],
    // Not when flagged: that text is the one most likely shaped by whoever is trying to manipulate
    // the verifier, and a mail from Settld would lend it authority.
    reason: item.flagged ? "" : cut(safe(item.reason)),
    flagged: item.flagged,
  }));

  const subject = input.items.some((i) => i.flagged) ? copy.subjectFlag(milestone) : input.items.some((i) => i.verdict === "FAIL") ? copy.subjectFail(milestone) : copy.subjectDecide(milestone);
  // G-REQUIRED-COUNTED: a required criterion left undecided holds back the whole round, including
  // what already passed. The buyer has to know that before choosing not to answer. With no report
  // the mail cannot tell, and says the milder thing: it does not know which criteria are waiting.
  const when = formatWhen(input.windowEndsAt);
  const deadline = input.items.some((i) => i.required) ? copy.deadlineRequired(when) : copy.deadline(when);

  const anyAi = input.items.some((i) => i.level === "AI_EVALUATED");
  const lines = [
    copy.intro(contract, milestone),
    "",
    ...(items.length === 0
      ? [copy.noReport]
      : [
          ...items.flatMap((i) => [`- ${i.text}: ${i.label}`, ...(i.reason === "" ? [] : [`  ${copy.quote}: "${i.reason}"`]), ...(i.flagged ? [`  ${copy.flagged}`] : [])]),
          ...(anyAi ? ["", copy.opinion] : []),
        ]),
    "",
    deadline,
    copy.options,
    "",
    `${copy.action}: ${input.link}`,
  ];

  const list = items
    .map(
      (i) =>
        `<li><strong>${escapeHtml(i.text)}</strong>: ${escapeHtml(i.label)}${i.reason === "" ? "" : `<br><em>${escapeHtml(copy.quote)}: &quot;${escapeHtml(i.reason)}&quot;</em>`}${i.flagged ? `<br><strong>${escapeHtml(copy.flagged)}</strong>` : ""}</li>`,
    )
    .join("");
  const html = [
    `<p>${escapeHtml(copy.intro(contract, milestone))}</p>`,
    items.length === 0 ? `<p>${escapeHtml(copy.noReport)}</p>` : `<ul>${list}</ul>${anyAi ? `<p>${escapeHtml(copy.opinion)}</p>` : ""}`,
    `<p><strong>${escapeHtml(deadline)}</strong></p>`,
    `<p>${escapeHtml(copy.options)}</p>`,
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(copy.action)}</a></p>`,
  ].join("\n");

  return { subject, text: lines.join("\n"), html };
}
