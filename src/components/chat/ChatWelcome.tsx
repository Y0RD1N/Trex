import type { AgentProvider } from "../../types";
import AgentIcon from "../AgentIcon";
import { effortLabel } from "../../chatState";
import "./ChatWelcome.css";

export type ChatWelcomeContent = {
  title: string;
  description: string;
  participants: { id: string; name: string; role: string; provider: AgentProvider; model: string | null; effort?: string | null }[];
};

export default function ChatWelcome({ content, provider }: { content: ChatWelcomeContent; provider: AgentProvider }) {
  return <section className="chat-empty chat-start" aria-label="Agentes configurados">
    <span className="chat-start-logo"><AgentIcon kind={provider} size={30} /></span>
    <span className="chat-start-eyebrow">Configuración guardada</span>
    <h2>{content.title}</h2>
    <p className="chat-start-description">{content.description}</p>
    <ol className="chat-start-members">{content.participants.map((member, index) => <li key={member.id}>
      <span className="chat-start-number" aria-hidden="true">{String(index+1).padStart(2,"0")}</span><AgentIcon kind={member.provider} size={19} />
      <span><strong>{member.name}</strong><span>{member.role}</span><small title={member.model??"Modelo del perfil"}>{member.model??"Modelo del perfil"}{member.effort?` · ${effortLabel(member.effort)}`:""}</small></span>
    </li>)}</ol>
    <p className="chat-start-hint">El trabajo empieza cuando envíes tu primer mensaje.</p>
  </section>;
}
