import { useSyncExternalStore } from "react";
import { getTimeFormat, subscribeTimeFormat } from "../timeFormat";
export const useTimeFormat = () => useSyncExternalStore(subscribeTimeFormat, getTimeFormat, getTimeFormat);
