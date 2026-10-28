import { useEffect, useId, useRef, useState } from "react";
import { trexBrowserCall, trexBrowserOpenArtifact, trexBrowserStatus } from "../../api";
import { browserResultArtifacts, brokerArtifactId, type BrowserArtifact, type BrowserOptions, type BrowserStatus, type BrowserSpace } from "../../browser";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import DropdownMenu from "../DropdownMenu";
import { CloseIcon, GlobeIcon, ImageIcon } from "../Icons";
import "./BrowserMenu.css";

/** Explicit human controls use a separate full grant; agent grants remain immutable. */
export default function BrowserMenu({ cwd, browser, spaces, onStopAgent }: { cwd: string; browser: BrowserOptions; spaces?:BrowserSpace[]; onStopAgent?:(clientId:string)=>void }) {
  const [selectedClient,setSelectedClient]=useState(browser.clientId);
  const selected=spaces?.find(space=>space.clientId===selectedClient)??spaces?.[0];
  const activeBrowser=selected?{...browser,...selected}:browser;
  const [tabs,setTabs]=useState<{tabId:string;title:string;url:string;selected:boolean}[]>([]);
  const [loadingTabs,setLoadingTabs]=useState(false);
  const [counts,setCounts]=useState<Record<string,number>>({});
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null), [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("http://localhost:3000"), [error, setError] = useState("");
  const [paused, setPaused] = useState(false), [recording, setRecording] = useState(false), [otherOwner, setOtherOwner] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [artifacts, setArtifacts] = useState<BrowserArtifact[]>([]);
  const inFlight = useRef(false);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await trexBrowserCall({ name, arguments: args, cwd, mode: "full", clientId: activeBrowser.clientId, profile: activeBrowser.profile,
        operationId: crypto.randomUUID(), timeoutMs: 60_000 });
      if (result.isError) {
        const code = (result.structuredContent?.error as Record<string, unknown> | undefined)?.code;
        if (code === "UNCERTAIN" || code === "PAUSED") { setPaused(true); setPauseReason(code === "UNCERTAIN" ? "uncertain" : null); }
        if (code === "RECOVERY_PENDING") { setPaused(true); setPauseReason("uncertain"); setNeedsRestart(true); }
        setError(code === "READ_TIMEOUT" ? "La consulta tardó demasiado. El navegador sigue disponible; puedes volver a consultar o tomar una captura."
          : code === "RECOVERY_PENDING" ? "La ejecución anterior no terminó. Puedes tomar una captura y reiniciar este perfil para continuar."
          : code === "OWNERSHIP" ? "Otro chat controla este perfil. Utiliza Tomar control para trabajar desde aquí."
          : code === "PAUSED" ? "Los controles están pausados. Las capturas siguen disponibles."
          : "La acción no se confirmó. Puedes revisar el estado con una captura antes de continuar."); return false;
      }
      const refs = browserResultArtifacts(result); if (refs.length) setArtifacts(before => [...refs, ...before].slice(0, 8));
      const data = result.structuredContent?.data as Record<string, unknown> | undefined;
      if(Array.isArray(data?.tabs)){setTabs(data.tabs as typeof tabs);setCounts(before=>({...before,[activeBrowser.clientId]:(data.tabs as unknown[]).length}));}
      if (typeof data?.paused === "boolean") setPaused(data.paused);
      if (typeof data?.pauseReason === "string" || data?.pauseReason === null) setPauseReason(data.pauseReason);
      if (name === "browser_start_video") setRecording(true);
      if (name === "browser_stop_video") setRecording(false);
      if (name === "browser_status") {
        setRecording(!!data?.capture && (data.capture as Record<string, unknown>).kind === "video");
        setOtherOwner(data?.owner === "other");
        setNeedsRestart(data?.paused === true && (data?.pendingAction as Record<string, unknown> | undefined)?.cancelRequested === true);
      }
      if (name === "browser_takeover") setOtherOwner(false);
      if (name === "browser_resume") setNeedsRestart(false);
      if (name === "browser_close") { setNeedsRestart(false); setRecording(false); setPaused(data?.paused === true);setTabs([]);setCounts(before=>({...before,[activeBrowser.clientId]:0})); }
      return true;
    } catch { setError("No se pudo conectar con Trex Browser. Comprueba su instalación en Ajustes.");return false; }
    finally { inFlight.current = false; setBusy(false); }
  };
  useEffect(()=>{
    if(!anchor || !status?.ready)return;
    let cancelled=false,pending=false;
    const refresh=async()=>{
      if(pending || inFlight.current)return;pending=true;
      try{
        const request={cwd,mode:"full" as const,clientId:activeBrowser.clientId,profile:activeBrowser.profile};
        const state=await trexBrowserCall({...request,name:"browser_status",arguments:{},timeoutMs:10000});
        if(cancelled)return;
        const data=state.structuredContent?.data as Record<string,unknown>|undefined;
        setPaused(data?.paused===true);setPauseReason(typeof data?.pauseReason==="string"?data.pauseReason:null);setOtherOwner(data?.owner==="other");
        setRecording(!!data?.capture&&(data.capture as {kind?:string}).kind==="video");setNeedsRestart(data?.paused===true&&(data?.pendingAction as {cancelRequested?:boolean})?.cancelRequested===true);
        if(data?.running && data?.owner!=="other"){
          const result=await trexBrowserCall({...request,name:"browser_tabs",arguments:{action:"list"},timeoutMs:10000});
          if(cancelled)return;
          const pages=(result.structuredContent?.data as {tabs?:typeof tabs}|undefined)?.tabs;
          if(Array.isArray(pages)){setTabs(pages);setCounts(before=>({...before,[request.clientId]:pages.length}));}
        }else {setTabs([]);setCounts(before=>({...before,[request.clientId]:typeof data?.tabs==="number"?data.tabs:0}));}
      }catch{if(!cancelled)setError("No se pudo actualizar este espacio. Vuelve a consultar su estado.");}
      finally{pending=false;if(!cancelled)setLoadingTabs(false);}
    };
    setLoadingTabs(true);setTabs([]);setArtifacts([]);setError("");void refresh();const timer=window.setInterval(()=>void refresh(),3000);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[anchor,status?.ready,cwd,activeBrowser.clientId,activeBrowser.profile]);
  const show = (): void => {
    setAnchor({ element: trigger.current! }); setError("");
    void trexBrowserStatus().then(next => { setStatus(next); })
      .catch(() => setError("No se pudo comprobar la instalación del navegador."));
  };
  const open = async (artifact: BrowserArtifact): Promise<void> => {
    const artifactId = brokerArtifactId(artifact); if (!artifactId || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const result = await trexBrowserOpenArtifact(artifactId, cwd, "full", activeBrowser.clientId, activeBrowser.profile); if (result.isError) setError("No se pudo abrir el archivo del navegador."); }
    catch { setError("No se pudo abrir el archivo del navegador."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const close = (): void => { setAnchor(null); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} type="button" className="chat-tray-chip chat-browser-trigger" aria-label="Controles del navegador" aria-expanded={!!anchor} aria-haspopup="dialog" aria-controls={anchor ? id : undefined}
      onClick={() => anchor ? close() : show()}><GlobeIcon size={14} /><span>{spaces?.length?`Espacios · ${spaces.length}`:"Navegador"}</span>{recording && <i aria-label="Grabando vídeo" />}</button>
    <DropdownMenu id={id} anchor={anchor} triggerRef={trigger} label="Controles del navegador" role="dialog" className="chat-glass-menu chat-browser-menu" onClose={() => setAnchor(null)}>
      <div className="chat-browser-head"><div><strong>Trex Browser</strong><small>{selected?selected.label+" · ":""}{activeBrowser.profile} · navegador del proyecto</small></div><button type="button" className="icon-btn" aria-label="Cerrar controles del navegador" data-menu-autofocus onClick={close}><CloseIcon size={14} /></button></div>
      {!!spaces?.length&&<div className="browser-spaces" aria-label="Espacios de los agentes">{spaces.map(space=><button type="button" key={space.clientId} className={space.clientId===activeBrowser.clientId?"browser-space selected":"browser-space"} aria-pressed={space.clientId===activeBrowser.clientId} disabled={busy} onClick={()=>setSelectedClient(space.clientId)}><GlobeIcon size={14}/><span><strong>{space.label}</strong><small>{space.profile}</small></span><em>{space.active?<><i className="browser-space-live"/>En curso</>:counts[space.clientId]===undefined?"Ver":`${counts[space.clientId]} ${counts[space.clientId]===1?"pestaña":"pestañas"}`}</em></button>)}</div>}
      {status?.ready ? <>
        <form className="chat-browser-address" onSubmit={event => { event.preventDefault(); void call("browser_navigate", { url }); }}>
          <label htmlFor={`${id}-url`}>Abrir una página</label><div><input id={`${id}-url`} type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" disabled={busy||loadingTabs} /><button type="submit" disabled={busy||loadingTabs || paused}>Abrir</button></div>
        </form>
        {(loadingTabs||!!tabs.length)&&<div className="browser-space-tabs" aria-label="Pestañas del espacio">{loadingTabs?<small className="browser-space-loading" role="status">Consultando pestañas…</small>:tabs.map(tab=><button type="button" key={tab.tabId} disabled={busy||loadingTabs||paused} aria-pressed={tab.selected} title={tab.url} onClick={()=>void call("browser_tabs",{action:"select",tabId:tab.tabId})}><span>{tab.title||tab.url||"Nueva pestaña"}</span><small>{tab.selected?"Activa":"Abrir"}</small></button>)}</div>}
        <div className="chat-browser-actions">
          <button type="button" disabled={busy||loadingTabs||paused} onClick={()=>void call("browser_tabs",{action:"new",url})}>+ Nueva pestaña</button>
          <button type="button" disabled={busy||loadingTabs} onClick={()=>void call("browser_status")}>Actualizar estado</button>
          <button type="button" disabled={busy||loadingTabs} onClick={() => void call("browser_take_screenshot")}><ImageIcon size={15} />Tomar captura</button>
          <button type="button" disabled={busy||loadingTabs || (paused && !recording)} onClick={() => void call(recording ? "browser_stop_video" : "browser_start_video")}>{recording ? "■ Detener vídeo" : "○ Grabar vídeo"}</button>
          <button type="button" disabled={busy||loadingTabs || needsRestart} onClick={() => void call(paused ? "browser_resume" : "browser_pause")}>{paused ? "Reanudar automatización" : "Pausar para revisar"}</button>
          {needsRestart && <button type="button" className="browser-action-wide" disabled={busy||loadingTabs} onClick={() => void call("browser_close")}>Reiniciar perfil del navegador</button>}
          {!!tabs.length&&<button type="button" disabled={busy||loadingTabs} onClick={()=>void (async()=>{if(await call("browser_pause"))await call("browser_close");})()}>Cerrar este espacio</button>}
          {onStopAgent&&selected&&<button type="button" className="browser-action-wide" title="Interrumpe esta delegación y pausa el equipo para revisar el resultado" disabled={busy||loadingTabs} onClick={()=>{void call("browser_pause");onStopAgent(selected.clientId);}}>Detener agente y revisar</button>}
          {otherOwner && <button type="button" className="browser-action-wide" disabled={busy||loadingTabs} onClick={() => void call("browser_takeover")}>Tomar control para este chat</button>}
        </div>
        <p className="chat-browser-hint">{paused ? pauseReason === "uncertain" ? "Una acción quedó sin confirmar. Las capturas y consultas siguen disponibles. Revisa la página y reanuda los controles para continuar."
          : pauseReason === "runtime" ? "El servicio del navegador necesita atención. Revisa su instalación antes de reanudar los controles."
          : "Controles pausados para revisión. Las capturas y consultas siguen disponibles; reanuda cuando termines."
          : recording ? "Grabación en curso. Detén el vídeo para guardarlo." : "El agente puede revisar consola, red, rendimiento y contenido de la página."}</p>
        {needsRestart && <p className="chat-browser-hint">Reiniciar cierra las pestañas de este perfil y descarta la ejecución pendiente. Tus sesiones guardadas y los archivos se conservan; después puedes abrir la página de nuevo.</p>}
        {!!artifacts.length && <div className="chat-browser-recent"><small>Archivos recientes</small>{artifacts.map(artifact => <button type="button" key={artifact.id} disabled={busy||loadingTabs || !brokerArtifactId(artifact)} onClick={() => void open(artifact)}>{artifact.mimeType.startsWith("video/") ? "Abrir vídeo" : "Abrir captura"}<span>{Math.max(1, Math.round(artifact.sizeBytes / 1024))} kB ↗</span></button>)}</div>}
      </> : <p className="chat-browser-hint">{!status ? "Comprobando instalación…" : status.error?.message ?? "Selecciona Trex Browser al instalar trex o utiliza su instalador independiente."}</p>}
      {error && <p className="chat-browser-error" role="alert">{error}</p>}
      <div className="chat-browser-foot">Capturas y vídeos guardados en este dispositivo.</div>
    </DropdownMenu>
  </>;
}
