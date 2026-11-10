// The mails that keep a contract moving (ADR-0013). Pure, like decision-email.ts, and under the same
// rules: titles and reasons were written by the other party, so they lose their links and are
// escaped, and the only link in the message is the one built here. None of them decides anything.
import { cut, escapeHtml, formatWhen, oneLine, stripLinks } from "./decision-email.js";

type Mail = { subject: string; text: string; html: string };
const isEs = (locale: string) => locale === "es";

// Plain paragraphs, one link at the end. `paragraphs` are already safe to read as text.
function render(subject: string, paragraphs: readonly string[], action: string, link: string): Mail {
  return {
    subject,
    text: [...paragraphs.flatMap((p) => [p, ""]), `${action}: ${link}`].join("\n"),
    html: [...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`), `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`].join("\n"),
  };
}

export interface InvitationEmailInput {
  readonly locale: string;
  readonly buyerName: string;
  readonly contractTitle: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly link: string;
}

// Anyone with an account can type any address here, so this is the one mail a stranger can cause:
// the title and the name carry no links, and the invitation is the only thing it offers.
export function buildInvitationEmail(input: InvitationEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const buyer = safe(input.buyerName);
  const title = safe(input.contractTitle);
  const when = formatWhen(input.expiresAt);
  return isEs(input.locale)
    ? render(
        `${buyer} te invitó a un contrato en Settld`,
        [
          `${buyer} te invitó como vendedor en "${title}". Puedes leer los hitos y criterios antes de aceptar. Aceptar no te obliga a nada todavía.`,
          `Entra o crea tu cuenta con esta misma dirección: ${input.email}. La invitación solo se abre con ella.`,
          `Vence el ${when}. Si no esperabas este correo, puedes ignorarlo.`,
        ],
        "Ver la invitación",
        input.link,
      )
    : render(
        `${buyer} invited you to a contract on Settld`,
        [
          `${buyer} invited you as the seller on "${title}". You can read the milestones and criteria before accepting. Accepting does not bind you to anything yet.`,
          `Sign in or create your account with this same address: ${input.email}. The invitation only opens with it.`,
          `It expires on ${when}. If you were not expecting this, you can ignore it.`,
        ],
        "See the invitation",
        input.link,
      );
}

export interface ContractLockedEmailInput {
  readonly locale: string;
  readonly recipient: "BUYER" | "SELLER";
  readonly otherPartyName: string;
  readonly contractTitle: string;
  readonly link: string;
}

// Says that no money moved, because "agreed" reads like "charged" to a buyer who was not watching.
export function buildContractLockedEmail(input: ContractLockedEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const other = safe(input.otherPartyName);
  const title = safe(input.contractTitle);
  if (isEs(input.locale)) {
    return input.recipient === "BUYER"
      ? render(`${other} aceptó "${title}"`, [`${other} aceptó los términos de "${title}", y el contrato quedó acordado.`, "No se ha movido dinero. Para que empiece el trabajo, financia el primer hito. Si no quieres seguir, puedes cancelar antes de financiar."], "Financiar el hito", input.link)
      : render(`"${title}" quedó acordado`, [`Tú y ${other} acordaron los términos de "${title}".`, "No se ha movido dinero. Espera a que el comprador financie el hito antes de empezar."], "Ver el contrato", input.link);
  }
  return input.recipient === "BUYER"
    ? render(`${other} agreed to "${title}"`, [`${other} agreed to the terms of "${title}", and the contract is now locked.`, "No money has moved. To get the work started, fund the first milestone. If you do not want to continue, you can cancel before funding."], "Fund the milestone", input.link)
    : render(`"${title}" is agreed`, [`You and ${other} agreed on the terms of "${title}".`, "No money has moved. Wait for the buyer to fund the milestone before you start."], "See the contract", input.link);
}

export interface WindowOpenedEmailInput {
  readonly locale: string;
  readonly viewer: "BUYER" | "SELLER";
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly windowEndsAt: Date;
  readonly link: string;
}

// To the buyer only when no decision.needed goes out, so "nothing to decide" is true for them.
export function buildWindowOpenedEmail(input: WindowOpenedEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const milestone = safe(input.milestoneTitle);
  const contract = safe(input.contractTitle);
  const when = formatWhen(input.windowEndsAt);
  if (isEs(input.locale)) {
    return input.viewer === "BUYER"
      ? render(
          `Se liberará un pago de "${milestone}"`,
          [`El vendedor entregó "${milestone}" en "${contract}" y las comprobaciones terminaron.`, `Lo que pasó las comprobaciones se paga el ${when}, si no haces nada. Hasta entonces puedes aprobarlo antes o pedirle al vendedor que corrija algo.`],
          "Revisar la entrega",
          input.link,
        )
      : render(
          `Empezó la cuenta regresiva de "${milestone}"`,
          [`Las comprobaciones de "${milestone}" en "${contract}" terminaron.`, `Lo que cuente al ${when} se paga. Lo que dependa del comprador solo se paga si lo aprueba, y puede pedirte que corrijas algo.`],
          "Ver el hito",
          input.link,
        );
  }
  return input.viewer === "BUYER"
    ? render(
        `A payment for "${milestone}" will be released`,
        [`The seller delivered "${milestone}" in "${contract}", and the checks finished.`, `What passed the checks is paid on ${when} if you do nothing. Until then you can approve it sooner, or ask the seller to fix something.`],
        "Review the delivery",
        input.link,
      )
    : render(
        `The countdown started for "${milestone}"`,
        [`The checks on "${milestone}" in "${contract}" finished.`, `What counts on ${when} is paid. What depends on the buyer is paid only if they approve it, and they can ask you to fix something.`],
        "See the milestone",
        input.link,
      );
}

export interface ObjectionEmailInput {
  readonly locale: string;
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly reason: string;
  readonly link: string;
}

export function buildObjectionEmail(input: ObjectionEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const milestone = safe(input.milestoneTitle);
  const contract = safe(input.contractTitle);
  const reason = cut(safe(input.reason));
  return isEs(input.locale)
    ? render(
        `El comprador pidió un arreglo en "${milestone}"`,
        [`El comprador pidió un arreglo en "${milestone}" ("${contract}"). La cuenta regresiva se detuvo y el dinero sigue reservado.`, `Motivo, escrito por el comprador: "${reason}"`, "Corrige y vuelve a entregar para que se verifique de nuevo."],
        "Ver qué arreglar",
        input.link,
      )
    : render(
        `The buyer asked for a fix on "${milestone}"`,
        [`The buyer asked for a fix on "${milestone}" ("${contract}"). The countdown stopped and the money stays reserved.`, `Reason, written by the buyer: "${reason}"`, "Fix it and deliver again to have it verified."],
        "See what to fix",
        input.link,
      );
}

export interface EscalatedEmailInput {
  readonly locale: string;
  readonly viewer: "PARTY" | "REVIEWER";
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly link: string;
}

export function buildEscalatedEmail(input: EscalatedEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const milestone = safe(input.milestoneTitle);
  const contract = safe(input.contractTitle);
  if (input.viewer === "REVIEWER") {
    return isEs(input.locale)
      ? render(`Una objeción espera tu fallo: "${milestone}"`, [`La objeción de "${milestone}" en "${contract}" no se resolvió entre las partes.`, "Lee la entrega y a las dos partes, y decide con un motivo escrito. El dinero sigue reservado."], "Revisar el caso", input.link)
      : render(`An objection is waiting for your ruling: "${milestone}"`, [`The objection on "${milestone}" in "${contract}" was not settled by the parties.`, "Read the delivery and both sides, and decide with a written reason. The money stays reserved."], "Review the case", input.link);
  }
  return isEs(input.locale)
    ? render(`Un revisor decidirá "${milestone}"`, [`La objeción de "${milestone}" en "${contract}" no se resolvió, así que la decidirá un revisor neutral. El dinero sigue reservado hasta entonces.`, "Volver a entregar ya no responde esta objeción. Si no lo hiciste, todavía puedes explicar tu lado en el hito."], "Ver el hito", input.link)
    : render(`A reviewer will decide "${milestone}"`, [`The objection on "${milestone}" in "${contract}" was not settled, so a neutral reviewer will decide it. The money stays reserved until then.`, "Delivering again no longer answers this objection. If you have not yet, you can still explain your side on the milestone."], "See the milestone", input.link);
}

export interface RuledEmailInput {
  readonly locale: string;
  readonly decision: "RELEASE" | "VOID";
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly reason: string;
  readonly link: string;
}

export function buildRuledEmail(input: RuledEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const milestone = safe(input.milestoneTitle);
  const contract = safe(input.contractTitle);
  const reason = cut(safe(input.reason));
  const release = input.decision === "RELEASE";
  return isEs(input.locale)
    ? render(`Un revisor decidió "${milestone}"`, [`Un revisor neutral decidió la objeción de "${milestone}" en "${contract}": ${release ? "lo que seguía reservado se paga al vendedor" : "lo que seguía reservado vuelve al comprador"}.`, `Motivo del revisor: "${reason}"`], "Ver el hito", input.link)
    : render(`A reviewer decided "${milestone}"`, [`A neutral reviewer decided the objection on "${milestone}" in "${contract}": ${release ? "what was still reserved is paid to the seller" : "what was still reserved goes back to the buyer"}.`, `The reviewer's reason: "${reason}"`], "See the milestone", input.link);
}

export interface MilestoneEndedEmailInput {
  readonly locale: string;
  readonly partlyPaid: boolean;
  readonly contractTitle: string;
  readonly milestoneTitle: string;
  readonly link: string;
}

// Nothing here decides anything: it reports where the money went when a milestone ended early.
export function buildMilestoneEndedEmail(input: MilestoneEndedEmailInput): Mail {
  const safe = (text: string) => oneLine(stripLinks(text, input.locale));
  const milestone = safe(input.milestoneTitle);
  const contract = safe(input.contractTitle);
  return isEs(input.locale)
    ? render(`Terminó "${milestone}"`, [`El hito "${milestone}" de "${contract}" terminó antes de pagarse completo.`, input.partlyPaid ? "Lo que ya se pagó se mantiene, y lo que seguía reservado vuelve al comprador." : "No se cobró nada, y lo reservado vuelve al comprador."], "Ver el hito", input.link)
    : render(`"${milestone}" ended`, [`The milestone "${milestone}" in "${contract}" ended before being paid in full.`, input.partlyPaid ? "What was paid stands, and what was still reserved goes back to the buyer." : "Nothing was charged, and what was reserved goes back to the buyer."], "See the milestone", input.link);
}

export interface ApplicationEmailInput {
  readonly locale: string;
  readonly kind: "RECEIVED" | "TO_DECIDE" | "APPROVED" | "REJECTED" | "SUSPENDED";
  readonly displayName: string;
  readonly reason: string | null;
  readonly link: string;
}

// The word people see is Settler; the contract's word stays REVIEWER (ADR-0015, C11).
export function buildApplicationEmail(input: ApplicationEmailInput): Mail {
  const name = oneLine(stripLinks(input.displayName, input.locale));
  const reason = input.reason === null ? null : cut(oneLine(stripLinks(input.reason, input.locale)));
  const es = isEs(input.locale);
  const because = reason === null ? [] : [es ? `Motivo: "${reason}"` : `Reason: "${reason}"`];
  const action = es ? "Ver tu solicitud" : "See your application";
  switch (input.kind) {
    case "RECEIVED":
      return es
        ? render("Recibimos tu solicitud para ser Settler", ["Settld la va a revisar. Solicitarlo no te da permisos de revisor hasta que se apruebe."], action, input.link)
        : render("We received your application to be a Settler", ["Settld will review it. Applying does not give you reviewer permissions until it is approved."], action, input.link);
    case "TO_DECIDE":
      return es
        ? render(`Nueva solicitud de revisor: ${name}`, [`${name} pidió ser revisor.`], "Revisar solicitudes", input.link)
        : render(`New reviewer application: ${name}`, [`${name} applied to be a reviewer.`], "Review applications", input.link);
    case "APPROVED":
      return es
        ? render("Ya eres Settler", ["Aprobamos tu solicitud. Puedes recibir casos para revisar. Para cobrar necesitas tener PayPal conectado.", ...because], action, input.link)
        : render("You are now a Settler", ["Your application was approved. You can now receive cases to review. To be paid you need PayPal connected.", ...because], action, input.link);
    case "REJECTED":
      return es ? render("No aprobamos tu solicitud para ser Settler", ["Puedes volver a solicitarlo en 30 días.", ...because], action, input.link) : render("Your application to be a Settler was not approved", ["You can apply again in 30 days.", ...because], action, input.link);
    case "SUSPENDED":
      return es ? render("Tu cuenta de Settler quedó suspendida", ["Ya no puedes revisar casos.", ...because], action, input.link) : render("Your Settler account was suspended", ["You can no longer review cases.", ...because], action, input.link);
  }
}
