import { useState } from "react";
import { ConversationProvider, useConversationControls } from "@elevenlabs/react";
import type { WebConfig } from "./config.js";
import { ConversationController } from "./conversation.js";
import { LocalBroker } from "./api.js";
import { SdkDriver } from "./sdkDriver.js";
import { Workspace } from "./Workspace.js";
function LiveWorkspace({ config }: { config: WebConfig }) {
  const controls = useConversationControls();
  const [controller] = useState(() => new ConversationController(new LocalBroker(config.apiOrigin), new SdkDriver(controls), {
    mock: false, maxSessionMs: config.maxSessionMs,
    ...(navigator.mediaDevices?.getUserMedia ? { microphone: () => navigator.mediaDevices.getUserMedia({ audio: true }) } : {}),
  }));
  return <Workspace controller={controller} mock={false} maxMinutes={config.maxSessionMs / 60_000} />;
}
export default function LiveApp({ config }: { config: WebConfig }) {
  return <ConversationProvider><LiveWorkspace config={config} /></ConversationProvider>;
}
