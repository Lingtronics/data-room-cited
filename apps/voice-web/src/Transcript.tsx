import type { Message } from "./conversation.js";

export function Transcript({ messages, mock, textOnly }: { messages: Message[]; mock: boolean; textOnly: boolean }) {
  return <section className="transcript" aria-labelledby="transcript-title">
    <div className="transcript-heading"><h2 id="transcript-title">Conversation</h2><span>{mock ? "SCRIPTED DEMO" : textOnly ? "TEXT SESSION" : "RECOGNISED / INTERPRETED SPEECH"}</span></div>
    <p className="transcript-disclaimer">Conversation text is not an independently verified documentary claim.</p>
    <div className="transcript-messages" role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions text">
      {messages.length === 0 ? <p className="transcript-empty">Your conversation will appear here. Nothing is saved when the session ends.</p> :
        messages.map(message => <div className={`message message-${message.role}`} key={`${message.role}-${message.id}`}>
          <span className="message-avatar" aria-hidden="true">{message.role === "user" ? "Y" : "C"}</span>
          <div><span className="message-role">{message.role === "user" ? "You" : "Research assistant"}</span><p>{message.text}</p></div>
        </div>)}
    </div>
  </section>;
}
