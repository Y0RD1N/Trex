import { useAntigravityChat } from "../hooks/useAntigravityChat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentTeamClaim, agentTeamFinish, agentTeamOpen, agentTeamPause, agentTeamPoll, agentTeamSnapshot, trexBrowserStatus, trexBrowserSpaces, formatError, loadHandoff, prepareHandoff } from "../api";
import { TEAM_ROLES, TEAM_COORDINATOR_POLICY, TEAM_READER_POLICY, mergeTeamItems, teamCombinedState, teamPlanningContext, teamTaskActive, teamTaskRunnable, type AgentTeam, type TeamMember, type TeamSnapshot, type TeamTask } from "../agentTeam";
import { browserOptions, type BrowserSpace } from "../browser";
import { currentModel, modelName, type ChatState } from "../chatState";
import { buildHandoffPrompt, sanitizeHandoffText } from "../handoff";
import { planningContext } from "../agentWorkflow";
import type { ChatSession, ChatSessionOptions } from "../hooks/chatSession";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { useCodexChat } from "../hooks/useCodexChat";
import { useTrexChat } from "../hooks/useTrexChat";
import { ChatPanel, type ChatViewProps } from "./ChatView";
import AgentTeamToolbar from "./AgentTeamToolbar";
import { agentPermissionLabel, defaultAgentPermission } from "../agentPermissions";
import { chatTasks, teamTasks } from "../chatTasks";
import { INBOX_WAKE, messageQueueId } from "../messageQueue";
import "./AgentRoomView.css";
import "./AgentTeamView.css";

type Props = Omit<ChatViewProps, "workflow" | "planningOnly" | "handoff" | "handoffRestored"> & { team: AgentTeam; onTeamChange: (team: AgentTeam) => void };
type RuntimeProps = { id: string; epoch: string; options: ChatSessionOptions; publish: (id: string, epoch: string, session: ChatSession) => void };
function Publish({ id, epoch, session, publish }: Omit<RuntimeProps,"options"> & { session: ChatSession }) {
  useLayoutEffect(() => publish(id, epoch, session));
  return null;
}
function ClaudeRuntime(props: RuntimeProps) { return <Publish {...props} session={useClaudeChat(props.options)} />; }
function CodexRuntime(props: RuntimeProps) { return <Publish {...props} session={useCodexChat(props.options)} />; }
function AntigravityRuntime(props: RuntimeProps) { return <Publish {...props} session={useAntigravityChat(props.options)} />; }
function TrexRuntime(props: RuntimeProps) { return <Publish {...props} session={useTrexChat(props.options)} />; }
type Attempt = { epoch: string; task: TeamTask; member: TeamMember; session: ChatSession; previous: string | null; users: Set<string>; accepted: boolean };
const noop = (): void => undefined;
export default function AgentTeamView(props: Props) {
  const { team } = props;
  const latest = useRef(props); latest.current = props;
  const current = useRef(team), received = useRef(team);
  if (received.current !== team) { received.current=team; current.current=team; }
  const browser = useRef(browserOptions(props.settings, team.id)).current;
  const [spaces,setSpaces]=useState<BrowserSpace[]>([]);
  const desktopEnabled = useRef(props.settings.desktopEnabled).current;
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), generation = useRef(0), ticking = useRef(false);
  const sessionsRef = useRef<Record<string,ChatSession>>({});
  const [published, setPublished] = useState<{epoch:string; sessions:Record<string,ChatSession>}>({epoch:team.epoch,sessions:{}});
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [openedEpoch, setOpenedEpoch] = useState("");
  const [starting, setStarting] = useState(false);
  const [preparingMessage, setPreparingMessage] = useState(false);
  const sendReservation = useRef<object | null>(null);
  const schedulerWaiters = useRef<(() => void)[]>([]);
  const [activated, setActivated] = useState(() => new Set([team.master.id,...team.workers.filter(member=>member.conversationId).map(member=>member.id)]));
  const attempt = useRef(new Map<string,Attempt>());
  const epoch = useRef(team.epoch);
  const wasRestored = useRef(team.phase === "paused");
  const masterCompletion = useRef<string | null>(null);
  const feedback=useRef<string | null>(null),waitingReports=useRef(false);
  const opening = useRef<string | null>(null);
  if (epoch.current !== team.epoch) {
    epoch.current = team.epoch; sessionsRef.current = {}; attempt.current.clear(); masterCompletion.current = null;feedback.current=null;waitingReports.current=false;
  }
  const change = useCallback((update:(value:AgentTeam)=>AgentTeam):void => {
    if (!mounted.current) return;
    const before=current.current, next=update(before);
    if (next===before) return;
    current.current=next; latest.current.onTeamChange(next);
  },[]);
  const publish = useCallback((id:string, publishedEpoch:string, session:ChatSession):void => {
    if (!mounted.current || current.current.epoch!==publishedEpoch) return;
    const prior=sessionsRef.current[id]; sessionsRef.current[id]=session;
    if (!prior || prior.state!==session.state || prior.terminals!==session.terminals || prior.queue.snapshot!==session.queue.snapshot || prior.queue.ready!==session.queue.ready || prior.queue.error!==session.queue.error)
      setPublished(previous=>({epoch:publishedEpoch,sessions:{...(previous.epoch===publishedEpoch?previous.sessions:{}),[id]:session}}));
    change(value=>{
      const member=id===value.master.id?value.master:value.workers.find(member=>member.id===id);
      if (!member) return value;
      const state=session.state;
      const conversationId=state.sessionId && state.items.some(item=>item.kind==="user")?state.sessionId:member.conversationId;
      const model=id===value.master.id?state.modelChoice:member.agent.model;
      const effort=(id===value.master.id?state.effortChoice:member.agent.effort)??null;
      if (conversationId===member.conversationId && model===member.agent.model && effort===(member.agent.effort??null)) return value;
      const next={...member,conversationId,agent:{...member.agent,model,effort}};
      return id===value.master.id?{...value,master:next}:{...value,workers:value.workers.map(item=>item.id===id?next:item)};
    });
  },[change]);
  const members=useMemo(()=>[team.master,...team.workers],[team.master,team.workers]);
  const sessions=published.epoch===team.epoch?published.sessions:{};
  const states=useMemo(()=>Object.fromEntries(Object.entries(sessions).map(([id,session])=>[id,session.state])) as Record<string,ChatState>,[sessions]);
  const merged=useMemo(()=>mergeTeamItems(members,states,team.order),[members,states,team.order]);
  useEffect(()=>{ change(value=>value.order.length===merged.order.length && value.order.every((id,index)=>id===merged.order[index])?value:{...value,order:merged.order}); },[merged.order,change]);
  const stop = useCallback((reason="Equipo detenido. Revisa los resultados antes de reanudar."):void => {
    generation.current++; attempt.current.clear();waitingReports.current=false;
    for(const resolve of schedulerWaiters.current.splice(0))resolve();
    sendReservation.current=null;setPreparingMessage(false);
    const binding={id:current.current.id,epoch:current.current.epoch};
    change(value=>({...value,phase:"paused",error:reason}));
    for (const session of Object.values(sessionsRef.current)) session.interrupt();
    void agentTeamPause(binding).then(value=>{if(mounted.current && current.current.epoch===binding.epoch)setSnapshot(value);}).catch(error=>{
      if(mounted.current && current.current.epoch===binding.epoch) latest.current.onMessage(formatError(error));
    });
  },[change]);
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false; generation.current++;
      const binding={id:current.current.id,epoch:current.current.epoch};
      for(const session of Object.values(sessionsRef.current))session.interrupt();
      void agentTeamPause(binding).catch(()=>undefined);
    };
  },[]);
  const allocateSpaces=async(config:AgentTeam):Promise<BrowserSpace[]>=>{
    if(!browser.enabled)return [];
    const status=await trexBrowserStatus();if(!status.ready)return [];
    if(!status.capabilities?.spaces)throw new Error("Actualiza el componente Trex Browser para habilitar espacios por agente.");
    return (await trexBrowserSpaces(latest.current.cwd,[config.master,...config.workers].map(member=>({clientId:config.id+"-"+member.id,label:member.name})))).spaces;
  };
  useEffect(()=>{
    if (team.phase==="paused" || team.phase==="failed") {
      void agentTeamSnapshot(team.id).then(value=>{if(mounted.current)setSnapshot(value);}).catch(()=>undefined);
      return;
    }
    if(openedEpoch===team.epoch || opening.current===team.epoch)return;
    const binding=team.epoch; opening.current=binding; setStarting(true);
    void (async()=>{
      const bindings=await allocateSpaces(team);
      if(!mounted.current || current.current.epoch!==binding)return null;
      setSpaces(bindings);
      return agentTeamOpen(team,props.cwd);
    })().then(value=>{
      if(!value || !mounted.current || current.current.epoch!==binding)return;
      setSnapshot(value);setOpenedEpoch(binding);
    }).catch(error=>{if(mounted.current && current.current.epoch===binding)change(value=>({...value,phase:"failed",error:formatError(error)}));})
      .finally(()=>{if(opening.current===binding){opening.current=null;if(mounted.current)setStarting(false);}});
  },[team.epoch,team.phase,team.id,openedEpoch,props.cwd,change]);
  const resume=async():Promise<void>=>{
    if(starting)return;
    const token=++generation.current, before=current.current;
    setStarting(true);
    try{
      const next={...before,epoch:crypto.randomUUID(),phase:"running" as const,error:null};
      const bindings=await allocateSpaces(next);
      if(!mounted.current || generation.current!==token)return;
      const value=await agentTeamOpen(next,latest.current.cwd,true);
      if(!mounted.current || generation.current!==token){void agentTeamPause({id:next.id,epoch:next.epoch}).catch(()=>undefined);return;}
      for(const session of Object.values(sessionsRef.current))session.interrupt();
      setSpaces(bindings);change(()=>next);setPublished({epoch:next.epoch,sessions:{}});setSnapshot(value);setOpenedEpoch(next.epoch);
      requestAnimationFrame(()=>root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    }catch(error){if(mounted.current)change(value=>({...value,phase:"paused",error:formatError(error)}));}
    finally{if(mounted.current)setStarting(false);}
  };
  // A slow provider acknowledgement or context capture must not expire the
  // coordinator's lease while the task scheduler is awaiting that operation.
  useEffect(()=>{
    if(openedEpoch!==team.epoch || team.phase!=="running")return;
    let cancelled=false, pending=false;
    const binding={id:team.id,epoch:team.epoch};
    const timer=window.setInterval(()=>{
      if(pending || cancelled)return;
      pending=true;
      void agentTeamPoll(binding).then(value=>{
        if(!cancelled && mounted.current && current.current.epoch===binding.epoch && current.current.phase==="running" && value.phase!=="running")stop("La coordinación se pausó. Revisa las tareas antes de continuar.");
      }).catch(error=>{
        if(!cancelled && mounted.current && current.current.epoch===binding.epoch && current.current.phase==="running")stop("Se perdió la conexión del equipo: "+formatError(error));
      }).finally(()=>{pending=false;});
    },3000);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[team.id,team.epoch,team.phase,openedEpoch,stop]);
  useEffect(()=>{
    if(openedEpoch!==team.epoch || ["paused","failed","completed"].includes(team.phase))return;
    let cancelled=false;
    const binding={id:team.id,epoch:team.epoch};
    const isCurrent=()=>!cancelled && mounted.current && current.current.epoch===binding.epoch && !["paused","failed"].includes(current.current.phase);
    const tick=async():Promise<void>=>{
      if(ticking.current || !isCurrent())return;
      ticking.current=true;
      try{
        let value=await agentTeamPoll(binding);
        if(!isCurrent())return;
        setSnapshot(value);
        if(value.phase!=="running"){stop("La coordinación se pausó. Revisa las tareas antes de continuar.");return;}
        const main=sessionsRef.current[current.current.master.id];
        const completion=main?.state.lastCompletion;
        if(completion && completion.id!==masterCompletion.current){
          masterCompletion.current=completion.id;
          if(completion.status!=="completed"){stop("El principal se interrumpió o falló. Revisa las delegaciones antes de reanudar.");return;}
          waitingReports.current=value.tasks.some(teamTaskActive);
          if(!waitingReports.current){
            if(value.plan?.some(step=>!value.tasks.some(task=>task.key===step.taskKey && task.status==="completed"))){
              stop("El principal terminó con tareas del plan pendientes o sin validar. Revisa los resultados antes de reanudar.");return;
            }
            change(team=>({...team,phase:"completed",error:null}));
          }
        }
        if(main && ["failed","exited"].includes(main.state.process) && current.current.phase!=="completed"){stop("No se pudo mantener la sesión del principal. Revisa su cuenta y reanuda el equipo.");return;}
        for(const active of [...attempt.current.values()]){
          if(!active.accepted)continue;
          const state=sessionsRef.current[active.member.id]?.state,done=state?.lastCompletion;
          if(!done || done.id===active.previous || !done.messageIds.some(id=>!active.users.has(id))){
            if(state && ["failed","exited"].includes(state.process)){stop("El subagente se cerró sin confirmar el resultado. No se repetirá la tarea.");return;}
            continue;
          }
          const ids=new Set(done.itemIds);
          const report=sanitizeHandoffText(state!.items.flatMap(item=>item.kind==="text" && item.final && ids.has(item.id)?[item.text]:[]).join("\n\n")).trim();
          let status=done.status==="completed"?"completed":done.status==="interrupted"?"uncertain":"failed";
          let result=report || "El subagente terminó sin un informe final utilizable. Revisa su historial y solicita una explicación.";
          if(!report && status!=="uncertain")status="failed";
          if(new TextEncoder().encode(result).length>32*1024){status="failed";result="El informe final supera 32 KiB. El contenido completo se conserva en el historial del subagente; solicita un resumen completo más breve antes de decidir.";}
          value=await agentTeamFinish(binding,active.task.id,status,result);
          if(!isCurrent())return;
          attempt.current.delete(active.member.id);setSnapshot(value);
          if(status==="uncertain"){stop("Una delegación se interrumpió. Revisa los archivos y el historial antes de continuar.");return;}
        }
        const finished=value.tasks.filter(task=>task.epoch===binding.epoch && !teamTaskActive(task));
        if(waitingReports.current && !sendReservation.current && main?.state.process==="ready" && main.state.pendingTurns===0 && main.state.lastCompletion?.status==="completed" && finished.length && !value.tasks.some(teamTaskActive)){
          const key=finished.map(task=>task.id+":"+task.status).sort().join("|");
          if(feedback.current!==key && current.current.phase!=="completed"){
            feedback.current=key;waitingReports.current=false;
            const prompt="Han terminado las delegaciones pendientes de este ciclo. Consulta trex_task_status para leer y evaluar sus informes antes de cerrar el trabajo. No vuelvas a ejecutar estas tareas. Si hay fallos, decide y publica los pasos correctivos con claves nuevas. Tareas: "+finished.map(task=>task.id+" ("+task.key+", "+task.status+")").join("; ");
            const accepted=await main.send(prompt,[],[],"Informes del equipo listos para revisión");
            if(!isCurrent())return;
            if(accepted!==true){stop("No se pudo confirmar la entrega de los informes al principal. No se repetirán automáticamente.");return;}
          }
        }
        if(value.tasks.some(task=>["claimed","running"].includes(task.status) && ![...attempt.current.values()].some(active=>active.task.id===task.id))){stop("Se encontró una entrega anterior sin confirmación. No se ha vuelto a ejecutar.");return;}
        for(const queued of value.tasks.filter(task=>task.epoch===binding.epoch && task.status==="queued")){
          if(current.current.master.canWrite && (sendReservation.current || (sessionsRef.current[current.current.master.id]?.state.pendingTurns??0)>0))break;
          if(attempt.current.has(queued.memberId) || !teamTaskRunnable(value,queued,[current.current.master,...current.current.workers]))continue;
          const member=current.current.workers.find(member=>member.id===queued.memberId);
          if(!member)throw new Error("La tarea apunta a un participante que ya no existe.");
          const worker=sessionsRef.current[member.id];
          setActivated(previous=>previous.has(member.id)?previous:new Set([...previous,member.id]));
          if(worker?.queue.error)throw new Error("No se pudo cargar la cola de "+member.name+": "+worker.queue.error);
          if(!worker || !worker.queue.ready || ["starting","idle"].includes(worker.state.process) || worker.state.pendingTurns>0)continue;
          value=await agentTeamClaim(binding,queued.id);
          if(!isCurrent())return;
          const task=value.tasks.find(task=>task.id===queued.id && task.status==="claimed");
          if(!task)continue;
          setSnapshot(value);
          if(worker.state.process!=="ready"){
            const failed=await agentTeamFinish(binding,task.id,"failed","No se pudo iniciar este subagente. Revisa su cuenta o conexión.");
            if(isCurrent())setSnapshot(failed);continue;
          }
          const issued:Attempt={epoch:binding.epoch,task,member,session:worker,previous:worker.state.lastCompletion?.id??null,users:new Set([...worker.state.pendingMessageIds,...worker.state.items.filter(item=>item.kind==="user").map(item=>item.id)]),accepted:false};
          attempt.current.set(member.id,issued);
          void (async()=>{
        const context=planningContext(task.instruction,{sessionId:latest.current.sessionId,provider:current.current.master.agent.provider,
          profileId:current.current.master.agent.profileId,profileName:current.current.master.agent.profileName,title:"Delegación de "+current.current.master.name,
          projectId:latest.current.projectId??"",projectName:latest.current.projectName,cwd:latest.current.cwd});
        const instructions="Realiza solo la tarea delegada. Tu función es "+TEAM_ROLES[member.role].name+". "+member.instructions
          +(member.canWrite?" Comprueba el estado actual del proyecto antes de editar. Permisos elegidos: "+agentPermissionLabel(member.agent.provider,member.mode)+".":" No modifiques archivos, ejecutes implementaciones ni solicites permisos de escritura.")
          +" Si la tarea tiene varios pasos, publica y actualiza tu propia lista con tus herramientas de tareas disponibles; marca cada paso completado solo tras verificarlo. La tarea asignada del equipo se actualiza según el resultado confirmado de tu delegación. Entrega un informe final con resultado, archivos/evidencias, validaciones realizadas, hallazgos y limitaciones. No delegues a otros agentes.";
        context.content="# Función e instrucciones de esta delegación\n\n"+instructions+"\n\n"+context.content;
        const prepared=await prepareHandoff(context);
        if(!isCurrent() || attempt.current.get(member.id)!==issued)return;
        const accepted=await worker.send(buildHandoffPrompt(prepared,"Realiza únicamente la tarea y función recibidas. Respeta sus restricciones y entrega un informe final verificable."),[],[],"Delegación de "+current.current.master.name+"\n\n"+task.instruction);
        if(!isCurrent() || attempt.current.get(member.id)!==issued)return;
        if(accepted!==true){
          await agentTeamFinish(binding,task.id,"uncertain","No se pudo confirmar la entrega. Revisa el historial; no se repetirá automáticamente.");
          stop("Entrega de una delegación sin confirmar. Revisa y reanuda el equipo.");return;
        }
        const running=await agentTeamFinish(binding,task.id,"running",null);
        if(isCurrent()){issued.accepted=true;setSnapshot(running);}
          })().catch(error=>{if(isCurrent())stop("No se pudo entregar la delegación: "+formatError(error));});
        }
      }catch(error){if(isCurrent())stop("No se pudo coordinar el equipo: "+formatError(error));}
      finally{ticking.current=false;for(const resolve of schedulerWaiters.current.splice(0))resolve();}
    };
    void tick(); const timer=window.setInterval(()=>void tick(),750);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[team.id,team.epoch,team.phase,openedEpoch,stop,change]);
  const main=sessions[team.master.id];
  const publishedTasks=teamTasks(snapshot,members);
  const taskPlan=publishedTasks.length?publishedTasks:chatTasks(main?.state.items??[],team.master.name);
  const busy=preparingMessage||Object.values(sessions).some(session=>session.state.pendingTurns>0);
  const paused=["paused","failed"].includes(team.phase);
  const locked=paused || starting || openedEpoch!==team.epoch;
  const block=(message:string):"blocked"=>{latest.current.onMessage(message);return "blocked";};
  const toolbar=<AgentTeamToolbar team={team} states={states} snapshot={snapshot} starting={starting} busy={busy}
    onStop={()=>stop()} onResume={()=>void resume()}
    onLoad={member=>{ setActivated(previous=>new Set([...previous,member.id])); const session=sessions[member.id];
      if(session && ["failed","exited"].includes(session.state.process))void session.start().catch(error=>latest.current.onMessage(formatError(error))); }}
    canRecover={member=>!!sessions[member.id]?.recover && sessions[member.id].state.process==="ready" && sessions[member.id].state.pendingTurns===0}
    onRecover={member=>{void sessions[member.id]?.recover?.().then(()=>latest.current.onMessage("Operaciones revisadas para "+member.name)).catch(error=>latest.current.onMessage(formatError(error)));}} />;
  let aggregate:ChatSession|null=null;
  if(main){
    aggregate={...main,state:teamCombinedState(main.state,states,merged.items,team.master.id,merged.owners),
      send:async(text,images,previews,display)=>{
        if(locked || sendReservation.current || ["paused","failed"].includes(current.current.phase))return false;
        const reservation={};sendReservation.current=reservation;
        const binding={id:current.current.id,epoch:current.current.epoch}, token=generation.current;
        let dispatched=false;
        const valid=()=>mounted.current && token===generation.current && current.current.epoch===binding.epoch && !["paused","failed"].includes(current.current.phase);
        try{
          if(current.current.master.canWrite && ticking.current)await new Promise<void>(resolve=>schedulerWaiters.current.push(resolve));
          if(!valid())return false;
          const value=await agentTeamPoll(binding);
          if(!valid() || value.phase!=="running")return false;
          if(current.current.master.canWrite && value.tasks.some(task=>["claimed","running"].includes(task.status))){
            if(text===INBOX_WAKE)return false;
            await main.queue.enqueue(text,images,previews);return true;
          }
          const setup=current.current.setup;
          let outgoing=text;
          if(setup){
            setPreparingMessage(true);
            const prior=setup.context?await loadHandoff(setup.context.id):null;
            if(!valid())return false;
            const context=teamPlanningContext(current.current,text.trim()?text:images.length?"Analiza las imágenes adjuntas y ayúdame a planificar la idea. Pregunta si necesitas más contexto.":text,
              {sessionId:latest.current.sessionId,provider:current.current.master.agent.provider,profileId:current.current.master.agent.profileId,
                profileName:current.current.master.agent.profileName,title:"Planificación del equipo",projectId:latest.current.projectId??"",projectName:latest.current.projectName,cwd:latest.current.cwd},prior?.content);
            const prepared=await prepareHandoff(context);
            if(!valid())return false;
            outgoing=buildHandoffPrompt(prepared,"Atiende la idea del usuario. Planifica, delega según el equipo configurado y revisa los resultados. "+(current.current.master.canWrite?"Puedes editar respetando tus permisos y ceder el proyecto al terminar tu turno.":"No implementes directamente."));
          }
          if(!valid())return false;
          change(value=>({...value,phase:"running",error:null}));
          waitingReports.current=false;
          dispatched=true;
          const accepted=(await sessionsRef.current[current.current.master.id]!.send(outgoing,images,previews,display??text))===true;
          if(!valid())return false;
          if(accepted && setup)change(value=>({...value,setup:null}));
          if(!accepted && setup)stop("No se pudo confirmar el primer mensaje. Revisa el historial antes de reanudar; no se reenviará automáticamente.");
          return accepted;
        }catch(error){if(valid()){if(dispatched)stop("La entrega del mensaje no se pudo confirmar. Revisa el historial antes de reanudar.");else latest.current.onMessage(formatError(error));}return false;}
        finally{if(sendReservation.current===reservation){sendReservation.current=null;if(mounted.current)setPreparingMessage(false);}}
      },
      sendNow:async()=>{latest.current.onMessage("Usa la cola para incorporar aclaraciones sin interrumpir una delegación.");return false;},
      interrupt:()=>stop(),
      edit:async()=>{throw new Error("El historial del equipo se conserva. Envía una corrección como mensaje nuevo.");},
      reset:()=>{block("Usa Nuevo ciclo para conservar los historiales y revisar las delegaciones.");},
      runCommand:(name,args)=>{
        if(!["help","model","models","effort","usage","context","skills","status"].includes(name) || busy){block("Ese comando no está disponible durante un flujo delegado. Usa los controles del equipo.");return true;}
        return sessionsRef.current[current.current.master.id]!.runCommand(name,args);
      },
      answer:(item,allowed,remember,choices)=>{
        const owner=merged.owners[item.id], session=owner?sessionsRef.current[owner.memberId]:null;
        const original=session?.state.items.find(value=>value.id===owner.originalId);
        if(original?.kind!=="permission" || original.state!=="pending"){block("Esta solicitud ya no está pendiente.");return;}
        session!.answer(original,allowed,remember,choices);
      },
      setMode:()=>{block("Los permisos del principal y de cada subagente se eligen al configurar el equipo.");},
      setModel:value=>{if(busy)block("Espera a que termine el turno antes de cambiar el modelo principal.");else main.setModel(value);},
      setEffort:value=>{if(busy)block("Espera a que termine el turno antes de cambiar el esfuerzo principal.");else main.setEffort(value);},
    };
    if(team.master.canWrite && snapshot?.tasks.some(task=>["claimed","running"].includes(task.status)))
      aggregate.state={...aggregate.state,pendingTurns:Math.max(1,aggregate.state.pendingTurns)};
  }
  const labels=Object.fromEntries(Object.entries(merged.owners).map(([id,owner])=>{
    const member=members.find(member=>member.id===owner.memberId)!;
    const state=sessions[member.id]?.state;
    const model=state?currentModel(state.models,state.model,state.modelChoice):null;
    return [id,{provider:member.agent.provider,label:member.name,profile:member.agent.profileName,memberId:member.id,role:TEAM_ROLES[member.role].name,
      model:model?modelName(model):member.agent.model,effort:state?.effortChoice??state?.effort??member.agent.effort,worker:member.id!==team.master.id,busy:(state?.pendingTurns??0)>0}];
  }));
  return <div className="agent-room agent-team" ref={root}>
    {members.map(member=>{
      const historyOnly=paused && openedEpoch!==team.epoch;
      const readOnly=!member.canWrite || historyOnly;
      const space=spaces.find(space=>space.clientId===team.id+"-"+member.id);
      const memberBrowser=space?{enabled:browser.enabled,clientId:space.clientId,profile:space.profile}:{...browser,enabled:false,clientId:team.id+"-"+member.id};
      const options:ChatSessionOptions={...member.agent.launch,integrations:props.settings.integrations,desktopEnabled: !historyOnly && desktopEnabled,browser:historyOnly?{...memberBrowser,enabled:false}:memberBrowser,
        sessionId:team.id+"-"+member.id+"-"+team.epoch,queueId:messageQueueId(team.id+"-"+member.id),cwd:props.cwd,
        conversationId:member.conversationId,mode:readOnly?"plan":member.mode??defaultAgentPermission(member.agent.provider),
        model:member.agent.model,effort:member.agent.effort,planningOnly:readOnly,
        ...(readOnly?{planningInstruction:member.id===team.master.id?TEAM_COORDINATOR_POLICY:TEAM_READER_POLICY}:{}),
        ...(member.id===team.master.id && !historyOnly?{team:{id:team.id,epoch:team.epoch}}:{}),
        visible:activated.has(member.id) && (openedEpoch===team.epoch || historyOnly && props.visible && !!member.conversationId),
        onRunning:()=>latest.current.onRunning(latest.current.sessionId),onExit:noop};
      const Runtime=member.agent.provider==="antigravity"?AntigravityRuntime:member.agent.provider==="claude"?ClaudeRuntime:member.agent.provider==="codex"?CodexRuntime:TrexRuntime;
      return <Runtime key={team.epoch+"-"+member.id} id={member.id} epoch={team.epoch} options={options} publish={publish} />;
    })}
    {aggregate?<ChatPanel {...props} provider={team.master.agent.provider} session={aggregate} browser={{...browser,clientId:team.id+"-"+team.master.id,label:team.master.name,...spaces.find(space=>space.clientId===team.id+"-"+team.master.id),enabled:browser.enabled}} browserSpaces={spaces.map(space=>({...space,active:(sessions[space.clientId.slice(team.id.length+1)]?.state.pendingTurns??0)>0}))} onStopBrowserAgent={clientId=>{const member=members.find(member=>team.id+"-"+member.id===clientId);if(member){sessionsRef.current[member.id]?.interrupt();stop("Se detuvo a "+member.name+". Revisa su tarea antes de reanudar el equipo.");}}}
      profileId={team.master.agent.profileId} profileName={team.master.agent.profileName} conversationId={team.master.conversationId}
      terminalOwners={members.flatMap(member=>{const session=sessions[member.id]?.terminals;return session?[{id:member.id,label:member.name+" · "+TEAM_ROLES[member.role].name,provider:member.agent.provider,session}]:[];})} toolbar={toolbar} itemLabels={labels} taskPlan={taskPlan} taskAuthor={team.master.name+" · Principal"} tasksPaused={paused} historyReadOnly planningOnly={!team.master.canWrite} inputLocked={locked||preparingMessage}
      emptyState={{title:paused?"Tu equipo está en pausa":"Tu equipo está listo",description:paused?"La configuración está guardada. Revisa las cuentas y el historial antes de reanudar.":`Escribe tu idea a ${team.master.name}. Preparará el plan, repartirá las tareas y revisará los resultados contigo.`,
        participants:members.map((member,index)=>({id:member.id,name:member.name,role:index===0?"Principal · planificación y coordinación":TEAM_ROLES[member.role].name,provider:member.agent.provider,model:member.agent.model,effort:member.agent.effort}))}}
      composerPlaceholder="Escribe tu idea para que el principal prepare el plan…"
      handoff={team.initial} handoffRestored={wasRestored.current}
      onHandoffConsumed={(_id,id)=>change(value=>value.initial?.id===id?{...value,initial:{...value.initial,pending:false}}:value)}
      onConversation={noop} onMode={noop} onModel={noop} onEffort={noop} onPlanHere={undefined} onHandoffRequest={undefined}
      onBeforeSend={()=>locked?block("Revisa y reanuda el equipo antes de enviar nuevas instrucciones."):false}
      queuedSendReason={()=>"El equipo incorpora las aclaraciones desde la cola; no se interrumpe una delegación para enviarlas directamente."}
      localCommandReason={name=>!["help","model","models","effort","usage","context","skills","status"].includes(name) || busy?"Usa los controles del equipo para cambiar o detener el flujo.":null}
      composerLead={<div className="agent-room-composer-lead"><span>Enviar al principal</span><strong>{team.master.name}</strong>
        {team.setup&&(preparingMessage||!busy)&&<small>{preparingMessage?"Preparando tu idea y el contexto del equipo…":"Escribe tu idea aquí; el principal preparará el plan y coordinará al equipo."}</small>}
        {snapshot?.tasks.some(teamTaskActive)&&<small>{snapshot.tasks.filter(task=>["claimed","running"].includes(task.status)).length} delegaciones en curso; las aclaraciones pueden añadirse a la cola.</small>}</div>} />
      :<div className="agent-room-starting">{toolbar}<p>{starting?"Preparando el equipo…":paused?"Revisa el equipo para recuperar la conversación.":"Conectando al agente principal…"}</p></div>}
  </div>;
}
