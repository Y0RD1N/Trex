import { InfoIcon } from "./Icons";

/**
 * La explicación larga de un ajuste, fuera de la vista: un icono de información que la
 * muestra al pasar el cursor o al enfocarlo. Así la fila se queda en nombre y control.
 */
export default function SettingInfo({ text }: { text: string }) {
  return <span className="setting-info tip" role="note" tabIndex={0} aria-label={text} data-tip={text}
    onClick={event => event.preventDefault()}><InfoIcon size={13} /></span>;
}
