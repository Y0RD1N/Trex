import { useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import DropdownMenu from "./DropdownMenu";
import { CheckIcon, ChevronIcon } from "./Icons";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
  disabled?: boolean;
};

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange" | "children" | "onClick" | "onKeyDown" | "type"> & {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
};

/** Selector con el mismo menú, teclado y tema en Windows y Linux. */
export default function Select({ value, options, onChange, placeholder = "Elegir…", className = "", disabled, ...buttonProps }: Props) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [menuWidth, setMenuWidth] = useState(240);
  const selected = options.find(option => option.value === value);
  const label = buttonProps["aria-label"] ?? selected?.label ?? placeholder;
  const hasIcons = options.some(option => option.icon);
  const open = (): void => {
    if (!disabled && triggerRef.current) {
      setMenuWidth(triggerRef.current.getBoundingClientRect().width);
      setAnchor({ element: triggerRef.current });
    }
  };
  const choose = (option: SelectOption): void => {
    setAnchor(null);
    triggerRef.current?.focus({ preventScroll: true });
    onChange(option.value);
  };

  return <>
    <button {...buttonProps} ref={triggerRef} type="button" disabled={disabled}
      className={`input select-trigger ${className}`} aria-haspopup="menu" aria-expanded={!!anchor}
      aria-controls={anchor ? menuId : undefined}
      onClick={() => anchor ? setAnchor(null) : open()}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          open();
        }
      }}>
      {selected?.icon && <span className="select-icon" aria-hidden="true">{selected.icon}</span>}
      <span className="select-value">{selected?.label ?? placeholder}</span>
      <ChevronIcon size={14} />
    </button>
    <DropdownMenu id={menuId} anchor={anchor} triggerRef={triggerRef} label={label} focusSelected
      className="select-menu" onClose={() => setAnchor(null)}
      style={{ "--select-width": `${menuWidth}px` } as CSSProperties}>
      {options.map((option, index) => <div className="select-option-group" key={option.value}>
        {option.group && (index === 0 || options[index - 1].group !== option.group) &&
          <div className={`select-group-label${index ? " separated" : ""}`}>{option.group}</div>}
        <button type="button" role="menuitemradio" aria-checked={value === option.value} disabled={option.disabled}
          tabIndex={-1} className="context-item select-option" onClick={() => choose(option)}>
          {hasIcons && <span className="select-icon" aria-hidden="true">{option.icon}</span>}
          <span className="select-option-text"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
          <span className="select-check" aria-hidden="true">{value === option.value && <CheckIcon size={15} />}</span>
        </button>
      </div>)}
    </DropdownMenu>
  </>;
}
