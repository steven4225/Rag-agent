import { ChatShell } from "@/components/chat/chat-shell";
import { requireSignedIn, requireTenantScope } from "@/lib/auth/session";

export default async function ChatPage() {
  const user = requireTenantScope(await requireSignedIn());

  return <ChatShell user={user} />;
}
