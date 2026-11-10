/**
 * Uso de las cuentas en una ventana: el mismo panel de órbitas de la pestaña
 * «Uso» del chat, para cuando no hay ningún chat a la vista.
 */
import type { Settings } from "../types";
import { AccountUsagePanel } from "./AccountUsage";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import "./UsageDialog.css";

export default function UsageDialog({ settings, onClose, ...motion }: {
  settings: Settings;
  onClose: () => void;
} & FeatureDialogMotionProps) {
  return <FeatureDialog {...motion} title="Uso de las cuentas" onClose={onClose} className="usage-dialog">
    <AccountUsagePanel profiles={settings.profiles} />
  </FeatureDialog>;
}
