/** Preguntas compartidas por los dos proveedores, incluidas las que llegan como Markdown. */
import { choiceAnswers, type ChatItem, type Json, type PermissionItem, type QuestionChoice } from "./chatState";

export const questionInstructions = (provider: "claude" | "codex"): string => [
  `To get an answer or a choice from the user, use ${provider === "claude" ? "AskUserQuestion" : "request_user_input"}`,
  "(trex shows selectable options and a custom answer); never offer options only as plain text or a Markdown list.",
].join(" ");

const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,2}[.)]|[a-hA-H][.)])\s+(.+)$/;
const CHOICE_QUESTION = /prefier|prefer|elig|elij|escog|opci[oó]n|decid|seleccion|quieres|te parece|cu[aá]l|qu[eé] (?:estilo|tipo|formato|modo|enfoque|versi[oó]n|diseño|color)|c[oó]mo (?:lo |te |quieres|prefieres|proced)|which|what (?:style|type|format|mode|approach|version|design|color)|choose|select|pick|would you|do you want|(?:shall|should) (?:i|we)/i;
const plainLabel = (value: string): string => value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();

/**
 * Recupera elecciones explícitas, no listas de tareas, ejemplos o bloques de
 * código. Solo se aplica a mensajes completos; el protocolo nativo tiene prioridad.
 */
export function textQuestions(value: string): Json[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const questions: Json[] = [];
  let paragraph: string[] = [];
  let separated = false;
  let fence: { char: string; length: number } | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.char && marker.length >= fence.length) fence = null;
      paragraph = [];
      continue;
    }
    if (marker) { fence = { char: marker[0], length: marker.length }; paragraph = []; continue; }
    if (!line.trim()) { separated = true; continue; }
    const first = LIST_ITEM.exec(line);
    if (!first) {
      if (/^(?: {4}|\t| {0,3}>)/.test(line)) { paragraph = []; continue; }
      if (separated && /^(?:opciones|options)\s*:?$/i.test(plainLabel(line)) && /[?？]/.test(paragraph.join(" "))) continue;
      if (separated) paragraph = [];
      paragraph.push(line.replace(/^ {0,3}#{1,6}\s+/, "").trim());
      separated = false;
      continue;
    }

    const options: { label: string; description: string }[] = [];
    const indent = line.length - line.trimStart().length;
    let invalid = false;
    let end = at;
    for (; end < lines.length; end++) {
      const entry = LIST_ITEM.exec(lines[end]);
      if (entry) {
        if (/^\[[ xX]\]\s/.test(entry[1]) || lines[end].length - lines[end].trimStart().length !== indent) invalid = true;
        const described = /^\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$/.exec(entry[1]);
        options.push({ label: plainLabel(described?.[1] ?? entry[1]), description: described?.[2] ?? "" });
      } else if (!lines[end].trim()) {
        if (!LIST_ITEM.test(lines[end + 1] ?? "")) break;
      } else if (/^ {2,}\S/.test(lines[end]) && options.length && !/^\s*(?:>|`{3,}|~{3,})/.test(lines[end])) {
        options[options.length - 1].description += `${options[options.length - 1].description ? " " : ""}${lines[end].trim()}`;
      } else break;
    }
    const question = paragraph.join(" ");
    if (!invalid && question.length <= 1000 && /[?？]/.test(question) && CHOICE_QUESTION.test(question) && options.length >= 2 && options.length <= 12
      && options.every(option => option.label && option.label.length <= 400) && new Set(options.map(option => option.label)).size === options.length) {
      questions.push({ id: String(questions.length), question, options, multiSelect: false, isOther: true });
    }
    at = end - 1;
    paragraph = [];
    separated = false;
  }
  return questions;
}

/** La última pregunta textual sin un mensaje posterior del usuario ni una pregunta nativa. */
export function pendingTextQuestion(items: ChatItem[]): PermissionItem | null {
  let start = items.length - 1;
  for (; start >= 0 && items[start].kind !== "user"; start--) {
    const item = items[start];
    if ((item.kind === "tool" && item.name === "AskUserQuestion")
      || (item.kind === "permission" && item.toolName === "AskUserQuestion")) return null;
  }
  for (let at = items.length - 1; at > start; at--) {
    const item = items[at];
    if (item.kind !== "text" || !item.final) continue;
    const questions = textQuestions(item.text);
    if (questions.length) return { kind: "permission", id: `text-question:${item.id}`, toolName: "AskUserQuestion", toolUseId: null,
      input: { questions }, description: "", suggestions: [], state: "pending" };
  }
  return null;
}

/** Las preguntas textuales se contestan como mensaje, nunca como respuesta a un RPC inexistente. */
export const textQuestionAnswer = (choices: QuestionChoice[]): string => choices.flatMap(choice => {
  const values = choiceAnswers(choice);
  return values.length ? [`${choice.question}\n→ ${values.join(", ")}`] : [];
}).join("\n\n");
