import { ChatShell } from "@/components/chat/chat-shell";
import { requireSignedIn, requireTenantScope } from "@/lib/auth/session";

export default async function SessionChatPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const user = requireTenantScope(await requireSignedIn());

  const { sessionId } = await params;

  return <ChatShell initialConversationId={sessionId} user={user} />;
}
