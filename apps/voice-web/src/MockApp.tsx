import { useRef, useState } from "react";
import type { WebConfig } from "./config.js";
import { ConversationController } from "./conversation.js";
import { MockBroker, MockDriver, type Scenario } from "./mock.js";
import { Workspace } from "./Workspace.js";
export default function MockApp({ config }: { config: WebConfig }) {
  const [scenario, setScenario] = useState<Scenario>("supported");
  const current = useRef(scenario); current.current = scenario;
  const [controller] = useState(() => new ConversationController(new MockBroker(() => current.current), new MockDriver(() => current.current), { mock: true, maxSessionMs: config.maxSessionMs }));
  return <Workspace controller={controller} mock maxMinutes={config.maxSessionMs / 60_000} scenario={scenario} onScenario={setScenario} />;
}
