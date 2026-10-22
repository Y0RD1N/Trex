/**
 * Preguntas del asistente (AskUserQuestion en Claude Code, request_user_input
 * en Codex) en el sitio de la caja de mensaje: una pregunta cada vez, con sus
 * opciones numeradas, una respuesta propia y, si las hay, vistas previas.
 *
 * Elegir una opción en una pregunta de respuesta única responde y pasa a la
 * siguiente; con varias se marcan y se sigue con «Siguiente». Los números
 * eligen, las flechas recorren y Enter confirma.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { choiceAnswers, questionsOf, questionsTitle, type PermissionItem, type Question, type QuestionChoice } from "../../chatState";
import { ArrowRightIcon, CheckIcon, QuestionIcon } from "../Icons";
import Markdown from "./Markdown";

type Props = {
  item: PermissionItem;
  /** Nombre del asistente («Claude», «Codex»). */
  agent: string;
  /** La sesión está a la vista: el panel puede tomar el foco. */
  active: boolean;
  onAnswer: (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]) => void;
};

const initialChoice = (question: Question): QuestionChoice => ({
  question: question.question,
  selected: [],
  other: question.number?.initial !== null && question.number?.initial !== undefined ? String(question.number.initial) : "",
});

const answered = (choice: QuestionChoice | undefined): boolean => !!choice && choiceAnswers(choice).length > 0;

/** Vista previa de una opción: con bloques de Markdown se pinta como tal; si no, tal cual, en monoespaciada. */
function Preview({ text }: { text: string }) {
  return /```|^#{1,3} |^\s*[-*] /m.test(text)
    ? <div className="chat-ask-preview-body"><Markdown text={text} /></div>
    : <pre className="chat-ask-preview-body">{text}</pre>;
}

export default function QuestionPanel({ item, agent, active, onAnswer }: Props) {
  const questions = questionsOf(item.input);
  const title = questionsTitle(item.input);
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<QuestionChoice[]>(() => questions.map(initialChoice));
  /** Opción resaltada con el teclado o el ratón: decide la vista previa. */
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const question = questions[step];
  const choice = choices[step];
  const last = step === questions.length - 1;
  const anyAnswered = choices.some(answered);

  // Al llegar a una pregunta, el foco va a lo que se responde: la opción elegida, la primera o el campo de texto.
  useEffect(() => {
    if (!active || !question) return;
    const selected = question.options.findIndex(option => choice?.selected.includes(option.label));
    const start = selected >= 0 ? selected : 0;
    setHighlight(start);
    const target = question.kind === "choice" && !(choice?.other && !question.multiSelect) ? optionRefs.current[start] : fieldRef.current;
    (target ?? rootRef.current)?.focus({ preventScroll: true });
    // Solo al cambiar de pregunta o al mostrarse la sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, active]);

  // Las respuestas largas hacen crecer el campo hasta un tope.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [choice?.other, step]);

  if (!question || !choice) return null;

  const submit = (next: QuestionChoice[]): void => onAnswer(item, true, false, next);
  /** Pasa a la siguiente pregunta o, en la última, responde. */
  const advance = (next: QuestionChoice[]): void => {
    setChoices(next);
    if (!last) setStep(step + 1);
    else if (next.some(answered)) submit(next);
  };
  const update = (change: Partial<QuestionChoice>): QuestionChoice[] =>
    choices.map((current, index) => index === step ? { ...current, ...change } : current);

  const pick = (label: string): void => {
    if (question.multiSelect) {
      const selected = choice.selected.includes(label) ? choice.selected.filter(entry => entry !== label) : [...choice.selected, label];
      setChoices(update({ selected }));
    } else {
      advance(update({ selected: [label], other: "" }));
    }
  };

  const setOther = (other: string): void => {
    // En una pregunta de respuesta única, escribir la propia sustituye a la opción elegida.
    setChoices(update({ other, selected: question.multiSelect || !other.trim() ? choice.selected : [] }));
  };

  const focusOption = (index: number): void => {
    const count = question.options.length + (question.other ? 1 : 0);
    if (!count) return;
    const target = (index + count) % count;
    if (target < question.options.length) optionRefs.current[target]?.focus({ preventScroll: true });
    else fieldRef.current?.focus({ preventScroll: true });
    setHighlight(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    // Enter activa el botón enfocado (Omitir, Atrás, pestañas…), incluso con selección múltiple.
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement
      && !optionRefs.current.includes(event.target)) return;
    if (!typing && /^[1-9]$/.test(event.key) && question.kind === "choice") {
      const index = Number(event.key) - 1;
      if (index < question.options.length) {
        event.preventDefault();
        setHighlight(index);
        optionRefs.current[index]?.focus({ preventScroll: true });
        pick(question.options[index].label);
      } else if (index === question.options.length && question.other) {
        event.preventDefault();
        focusOption(index);
      }
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && question.kind === "choice" && !(typing && event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      focusOption(highlight + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    // Con varias respuestas, Enter sigue (Espacio marca); en el campo de texto responde con lo escrito o lo marcado.
    if (event.key === "Enter" && !event.shiftKey && (typing || question.multiSelect)) {
      event.preventDefault();
      if (answered(choice) || !last) advance(choices);
    }
  };

  const optionCount = question.options.length;
  const previewOption = question.options[highlight] ?? question.options.find(option => choice.selected.includes(option.label));
  const hasPreviews = question.options.some(option => option.preview);
  const fieldLabel = question.kind === "choice" ? `Otra respuesta para: ${question.question}` : question.question;
  const placeholder = question.placeholder
    || (question.kind === "number" ? "Escribe un número" : question.kind === "text" ? "Escribe tu respuesta…" : "Otra respuesta…");

  return <div ref={rootRef} className="chat-ask" role="group" tabIndex={-1} aria-label={`${agent} te pregunta`} onKeyDown={onKeyDown}>
    <div className="chat-ask-head">
      <span className="chat-ask-icon" aria-hidden="true"><QuestionIcon size={15} /></span>
      <span className="chat-ask-title">{title || `${agent} te pregunta`}</span>
      {questions.length > 1 && <span className="chat-ask-count">{step + 1} de {questions.length}</span>}
    </div>

    {questions.length > 1 && <div className="chat-ask-steps" role="tablist" aria-label="Preguntas">
      {questions.map((entry, index) => <button key={entry.id} type="button" role="tab" aria-selected={index === step}
        className={`chat-ask-step${index === step ? " current" : ""}${answered(choices[index]) ? " done" : ""}`}
        onClick={() => setStep(index)}>
        {answered(choices[index]) && <CheckIcon size={11} strokeWidth={2.6} />}
        <span>{entry.header || `Pregunta ${index + 1}`}</span>
      </button>)}
    </div>}

    <div className="chat-ask-question">
      {question.header && questions.length === 1 && <span className="chat-question-tag">{question.header}</span>}
      <div className="chat-ask-text"><Markdown text={question.question} /></div>
      {question.description && <p className="chat-ask-help">{question.description}</p>}
      {question.multiSelect && <p className="chat-ask-help">Puedes elegir varias.</p>}
    </div>

    <div className={`chat-ask-body${hasPreviews ? " with-preview" : ""}`}>
      {question.kind === "choice" && <div className="chat-ask-options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
        {question.options.map((option, index) => {
          const selected = choice.selected.includes(option.label);
          return <button key={option.label} ref={element => { optionRefs.current[index] = element; }} type="button"
            role={question.multiSelect ? "checkbox" : "radio"} aria-checked={selected}
            className={`chat-ask-option${selected ? " selected" : ""}${highlight === index ? " highlighted" : ""}${question.multiSelect ? " multi" : ""}`}
            onFocus={() => setHighlight(index)} onMouseEnter={() => setHighlight(index)}
            onClick={() => pick(option.label)}>
            <span className="chat-ask-key" aria-hidden="true">{selected ? <CheckIcon size={11} strokeWidth={2.6} /> : index + 1}</span>
            <span className="chat-ask-option-text">
              <span className="chat-ask-option-title">
                <strong>{option.title}</strong>
                {option.recommended && <span className="chat-ask-badge">Recomendada</span>}
              </span>
              {option.description && <span className="chat-ask-option-description">{option.description}</span>}
            </span>
          </button>;
        })}
        {question.other && <label className={`chat-ask-other${choice.other.trim() ? " filled" : ""}${highlight === optionCount ? " highlighted" : ""}`}>
          <span className="chat-ask-key" aria-hidden="true">{optionCount + 1}</span>
          <input ref={element => { fieldRef.current = element; }} className="chat-ask-field" type={question.secret ? "password" : "text"}
            value={choice.other} placeholder={placeholder} aria-label={fieldLabel} autoComplete="off" spellCheck={!question.secret}
            onFocus={() => setHighlight(optionCount)} onChange={event => setOther(event.target.value)} />
        </label>}
      </div>}

      {question.kind === "text" && (question.secret
        ? <input ref={element => { fieldRef.current = element; }} className="chat-ask-field boxed" type="password" value={choice.other}
          placeholder={placeholder} aria-label={fieldLabel} autoComplete="off" onChange={event => setOther(event.target.value)} />
        : <textarea ref={element => { fieldRef.current = element; }} className="chat-ask-field boxed" rows={1} value={choice.other}
          placeholder={placeholder} aria-label={fieldLabel} onChange={event => setOther(event.target.value)} />)}

      {question.kind === "number" && question.number && <div className="chat-ask-number">
        {question.number.min !== null && question.number.max !== null && <input type="range" aria-hidden="true" tabIndex={-1}
          min={question.number.min} max={question.number.max} step={question.number.step ?? 1}
          value={choice.other || question.number.initial || question.number.min} onChange={event => setOther(event.target.value)} />}
        <span className="chat-ask-number-value">
          <input ref={element => { fieldRef.current = element; }} className="chat-ask-field boxed" type="number" inputMode="decimal"
            min={question.number.min ?? undefined} max={question.number.max ?? undefined} step={question.number.step ?? "any"}
            value={choice.other} placeholder={placeholder} aria-label={fieldLabel} onChange={event => setOther(event.target.value)} />
          {question.number.unit && <span className="chat-ask-unit">{question.number.unit}</span>}
        </span>
      </div>}

      {hasPreviews && <div className="chat-ask-preview" aria-live="polite">
        {previewOption?.preview ? <Preview text={previewOption.preview} /> : <div className="chat-ask-preview-empty">Sin vista previa</div>}
      </div>}
    </div>

    <div className="chat-ask-foot">
      <span className="chat-ask-hint">
        {question.kind === "choice"
          ? `${optionCount > 1 ? `1–${optionCount}` : "1"} para elegir${question.other ? " · escribe otra respuesta" : ""}${question.multiSelect ? " · Enter para seguir" : ""}`
          : last ? "Enter para responder" : "Enter para seguir"}
      </span>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => onAnswer(item, false, false)}>
        {questions.length > 1 ? "Omitir preguntas" : "Omitir"}
      </button>
      {step > 0 && <button type="button" className="btn btn-small" onClick={() => setStep(step - 1)}>Atrás</button>}
      <button type="button" className="btn btn-primary btn-small chat-ask-next" disabled={last && !anyAnswered} onClick={() => advance(choices)}>
        {last ? "Responder" : <>Siguiente <ArrowRightIcon size={13} /></>}
      </button>
    </div>
  </div>;
}
